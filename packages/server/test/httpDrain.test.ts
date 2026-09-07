import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createStore } from "@polyth/session";
import { drainAndCloseServer } from "../src/httpDrain.ts";
import { createHttpAdmission } from "../src/httpAdmission.ts";
import { createHttpHandler, createPublicHttpServer } from "../src/http.ts";
import { createWsGateway } from "../src/ws.ts";
import { attachTerminalWs } from "../../terminal/src/serverEntry.ts";
import { testTenancy } from "./support/spaces.ts";
import type { SessionService } from "@polyth/contracts";

function stubSessions(): SessionService {
  return { events: async () => [], list: async () => [] } as unknown as SessionService;
}

async function listen(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
) {
  const server = createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

const timeoutCount = (): number => {
  const info = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  if (!info) return 0;
  return info.call(process).filter((name) => name === "Timeout").length;
};

test("idle server drain completes", async () => {
  const { server } = await listen((_req, res) => { res.statusCode = 204; res.end(); });
  await drainAndCloseServer(server, { timeoutMs: 500 });
  assert.equal(server.listening, false);
});

test("clean drain does not leave a referenced timeout", async () => {
  const { server } = await listen((_req, res) => { res.statusCode = 204; res.end(); });
  const before = timeoutCount();
  await drainAndCloseServer(server, { timeoutMs: 30_000 });
  const after = timeoutCount();
  assert.equal(server.listening, false);
  assert.ok(after <= before, `stray timeout: before=${before} after=${after}`);
});

test("in-flight request keeps store/package state alive until it finishes", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let disposed = false;
  let sawDisposed = false;
  const { server, port } = await listen((_req, res) => {
    res.setHeader("Connection", "close");
    void blocked.then(() => {
      sawDisposed = disposed;
      res.statusCode = 200;
      res.end("ok");
    });
  });

  const request = fetch(`http://127.0.0.1:${port}/paused`);
  await new Promise((resolve) => setTimeout(resolve, 30));

  let shutdownDone = false;
  const shutdown = drainAndCloseServer(server, { timeoutMs: 4_000 }).then(() => {
    disposed = true;
    shutdownDone = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(disposed, false, "disposal must wait for the in-flight handler");
  assert.equal(shutdownDone, false);

  release();
  const response = await request;
  assert.equal(response.status, 200);
  assert.equal(sawDisposed, false, "handler must not observe disposed state");
  await shutdown;
  assert.equal(disposed, true);
  assert.equal(server.listening, false);
});

test("late handler JS after forced drain cannot touch disposed services", async () => {
  let listCalls = 0;
  const tenancy = await testTenancy({
    dataDir: mkdtempSync(join(tmpdir(), "polyth-drain-fence-")),
    sessions: () => ({
      list: async () => {
        listCalls += 1;
        return [];
      },
      sync: async () => [],
    } as unknown as SessionService),
  });
  const admission = createHttpAdmission();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let touchedAfterFence = false;
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-drain-web-")),
    version: "test",
    admission,
    routes: [async (rc) => {
      if (rc.path !== "/api/held") return false;
      await blocked;
      try {
        void rc.space;
        await tenancy.gateway.services(rc.space).sessions.list();
        touchedAfterFence = true;
        rc.json(200, { ok: true });
      } catch (err) {
        const code = (err as { code?: string }).code;
        rc.json(code === "unavailable" ? 503 : 500, { error: code ?? "internal" });
      }
      return true;
    }],
  });
  const server = createPublicHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const request = fetch(`http://127.0.0.1:${port}/api/held`).then(
    (response) => response,
    () => ({ status: 0 }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));

  admission.stop();
  await drainAndCloseServer(server, {
    timeoutMs: 150,
    untilIdle: (ms) => admission.waitIdle(ms),
  });
  admission.fence();
  release();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const response = await request;
  assert.notEqual(response.status, 200);
  assert.equal(touchedAfterFence, false);
  assert.equal(listCalls, 0);
});

test("in-flight service op after drain timeout cannot touch a closed store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-drain-inflight-"));
  const store = createStore(join(dir, "s.db"));
  try {
    await store.append("s1", "user/message", { text: "hi" });

    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let backingTouched = false;
    let opCode: string | undefined;

    const tenancy = await testTenancy({
      dataDir: dir,
      sessions: () => ({
        list: async () => {
          entered = true;
          await hang;
          try {
            const rows = await store.events("s1");
            backingTouched = true;
            return rows;
          } catch (err) {
            opCode = (err as { code?: string }).code;
            throw err;
          }
        },
        sync: async () => [],
      } as unknown as SessionService),
    });
    const admission = createHttpAdmission();
    const handler = createHttpHandler({
      spaces: tenancy.gateway,
      runtimes: {} as never,
      capabilities: () => [],
      webDist: mkdtempSync(join(tmpdir(), "polyth-drain-web-")),
      version: "test",
      admission,
      routes: [async (rc) => {
        if (rc.path !== "/api/held") return false;
        try {
          // Operation starts immediately; the hang is inside list(), not here.
          const rows = await tenancy.gateway.services(rc.space).sessions.list();
          rc.json(200, { n: rows.length });
        } catch (err) {
          const code = (err as { code?: string }).code;
          rc.json(code === "unavailable" ? 503 : 500, { error: code ?? "internal" });
        }
        return true;
      }],
    });
    const server = createPublicHttpServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const request = fetch(`http://127.0.0.1:${port}/api/held`).then(
      (response) => response,
      () => ({ status: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(entered, true, "service operation must start before shutdown");

    admission.stop();
    await drainAndCloseServer(server, {
      timeoutMs: 150,
      untilIdle: (ms) => admission.waitIdle(ms),
    });
    admission.fence();
    let teardownBegan = false;
    await store.close();
    teardownBegan = true;
    release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const response = await request;

    assert.equal(teardownBegan, true);
    assert.equal(backingTouched, false, "resumed operation must not read disposed sqlite");
    assert.equal(opCode, "unavailable");
    assert.notEqual(response.status, 200);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open WebSocket does not hang drain forever", async () => {
  const { server, port } = await listen((_req, res) => { res.statusCode = 404; res.end(); });
  const gateway = createWsGateway(stubSessions());
  gateway.attach(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(ws, "open");
  const started = Date.now();
  const shutdown = (async () => {
    gateway.close();
    await drainAndCloseServer(server, { timeoutMs: 400 });
  })();
  await shutdown;
  assert.ok(Date.now() - started < 2_000, "WS drain must be bounded");
  assert.equal(server.listening, false);
});

test("terminal WebSocket detach does not wait the full HTTP drain timeout", async () => {
  const { server, port } = await listen((_req, res) => { res.statusCode = 404; res.end(); });
  const stop = attachTerminalWs(server, {
    terminals: {
      get: (id: string) => id === "t1" ? { id: "t1", projectId: "p", cwd: "/", running: true } : undefined,
      replay: () => "",
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      resize() {},
    } as never,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/t1`);
  await once(ws, "open");
  const started = Date.now();
  stop();
  await drainAndCloseServer(server, { timeoutMs: 8_000 });
  assert.ok(Date.now() - started < 2_000, "terminal WS must detach before HTTP drain timeout");
  assert.equal(server.listening, false);
});

test("repeated terminal attach/stop does not accumulate close listeners", async () => {
  const { server } = await listen((_req, res) => { res.statusCode = 404; res.end(); });
  const deps = {
    terminals: {
      get: () => undefined,
      replay: () => "",
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      resize() {},
    } as never,
  };
  for (let i = 0; i < 6; i++) {
    attachTerminalWs(server, deps)();
  }
  assert.ok(server.listenerCount("close") <= 1);
  await drainAndCloseServer(server, { timeoutMs: 500 });
});

test("non-responsive TCP connection does not hang drain forever", async () => {
  const { server, port } = await listen((_req, res) => { res.statusCode = 204; res.end(); });
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  const started = Date.now();
  await drainAndCloseServer(server, { timeoutMs: 250 });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(server.listening, false);
  socket.destroy();
});

test("repeated drain is idempotent", async () => {
  const { server } = await listen((_req, res) => { res.statusCode = 204; res.end(); });
  await drainAndCloseServer(server, { timeoutMs: 500 });
  await drainAndCloseServer(server, { timeoutMs: 500 });
  await drainAndCloseServer(server, { timeoutMs: 500 });
  assert.equal(server.listening, false);
});
