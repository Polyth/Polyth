import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { AuthPrincipal } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { attachTerminalWs } from "../src/serverEntry.ts";
import { createTerminalService } from "../src/index.ts";

function paired(grants: string[]): AuthPrincipal {
  return {
    kind: "paired-device",
    deviceId: "dev-a",
    deviceEndpointId: "ep",
    connectionId: "c1",
    transport: "direct",
    grants,
    grantRevision: 1,
  };
}

function connect(port: number, id: string): Promise<{
  ws: WebSocket;
  next: () => Promise<Record<string, unknown>>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${id}`);
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (): Promise<Record<string, unknown>> =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise((res, rej) => {
          waiters.push(res);
          setTimeout(() => rej(new Error("ws message timeout")), 4000).unref();
        });
  return new Promise((res, rej) => {
    ws.on("open", () => res({ ws, next }));
    ws.on("error", rej);
  });
}

test("terminal.open without terminal.input cannot write; resize is separate", async () => {
  const grants = { current: [REMOTE_CAPABILITY.terminalOpen] as string[] };
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let emitExit: ((id: string, exitCode: number | null) => void) | undefined;
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachTerminalWs(server, {
    identity: () => ({ authenticated: true, principal: paired(grants.current) }),
    refreshPrincipal: (principal) => principal.kind === "paired-device"
      ? { ...principal, grants: grants.current }
      : principal,
    terminals: {
      get: (id: string) => id === "t1" ? { id: "t1", projectId: "p", cwd: "/", running: true } : undefined,
      replay: () => "",
      onData: () => ({ dispose() {} }),
      onExit: (listener: (id: string, exitCode: number | null) => void) => {
        emitExit = listener;
        return { dispose() {} };
      },
      write(_id: string, data: string) { writes.push(data); },
      resize(_id: string, cols: number, rows: number) { resizes.push([cols, rows]); },
    } as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, next } = await connect(port, "t1");
    assert.equal((await next()).type, "attached");
    ws.send(JSON.stringify({ type: "data", data: "echo\n" }));
    const deniedWrite = await next();
    assert.equal(deniedWrite.code, "forbidden");
    assert.deepEqual(writes, []);
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    const deniedResize = await next();
    assert.equal(deniedResize.code, "forbidden");
    assert.deepEqual(resizes, []);
    grants.current = [REMOTE_CAPABILITY.terminalOpen, REMOTE_CAPABILITY.terminalInput];
    ws.send(JSON.stringify({ type: "data", data: "echo\n" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["echo\n"]);
    grants.current = [REMOTE_CAPABILITY.terminalOpen];
    ws.send(JSON.stringify({ type: "data", data: "blocked\n" }));
    const removed = await next();
    assert.equal(removed.code, "forbidden");
    assert.deepEqual(writes, ["echo\n"]);
    grants.current = [REMOTE_CAPABILITY.terminalOpen, REMOTE_CAPABILITY.terminalResize];
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(resizes, [[100, 30]]);
    grants.current = [];
    emitExit?.("t1", 1);
    grants.current = [REMOTE_CAPABILITY.terminalOpen];
    emitExit?.("t1", 2);
    assert.equal((await next()).exitCode, 2);
    ws.close();
  } finally {
    server.close();
  }
});

test("local UI can write without explicit terminal.input grant", async () => {
  const writes: string[] = [];
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachTerminalWs(server, {
    identity: () => ({
      authenticated: true,
      principal: { kind: "local-user", trustedLoopback: true },
    }),
    terminals: {
      get: () => ({ id: "t1", projectId: "p", cwd: "/", running: true }),
      replay: () => "",
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write(_id: string, data: string) { writes.push(data); },
      resize() {},
    } as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, next } = await connect(port, "t1");
    assert.equal((await next()).type, "attached");
    ws.send(JSON.stringify({ type: "data", data: "hi" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(writes, ["hi"]);
    ws.close();
  } finally {
    server.close();
  }
});

test("disconnecting and reopening a terminal window keeps its real process alive until tab close", async () => {
  const terminals = createTerminalService();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const detach = attachTerminalWs(server, {
    identity: () => ({ authenticated: true, principal: { kind: "local-user", trustedLoopback: true } }),
    terminals,
  });
  const sockets: WebSocket[] = [];
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let terminalId: string | undefined;
  try {
    const { id } = await terminals.create({ projectId: "window-lifecycle", cwd: process.cwd(), cmd: "cat", cols: 100, rows: 30 });
    terminalId = id;
    const first = await connect(port, id);
    sockets.push(first.ws);
    assert.equal((await first.next()).type, "attached");
    first.ws.send(JSON.stringify({ type: "data", data: "before-window-close\n" }));
    while (!String((await first.next()).data).includes("before-window-close")) { /* await real child output */ }
    const disconnected = once(first.ws, "close");
    first.ws.close();
    await disconnected;
    assert.equal(terminals.get(id)?.running, true, "a socket close must not send HUP to the process");
    terminals.resize(id, 65, 24);
    terminals.write(id, "while-window-hidden\n");
    const deadline = Date.now() + 4000;
    while (!terminals.replay(id)?.includes("while-window-hidden")) {
      assert.ok(Date.now() < deadline, "the detached child still accepts input");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reopened = await connect(port, id);
    sockets.push(reopened.ws);
    assert.equal((await reopened.next()).type, "attached");
    const replay = await reopened.next();
    assert.equal(replay.type, "replay");
    assert.match(String(replay.data), /before-window-close/);
    assert.match(String(replay.data), /while-window-hidden/);
    const frames = replay.frames as Array<{ type: string; data?: string; cols?: number; rows?: number }>;
    assert.deepEqual(frames.filter((frame) => frame.type === "resize"), [
      { type: "resize", cols: 100, rows: 30 },
      { type: "resize", cols: 65, rows: 24 },
    ]);
    assert.equal(frames.filter((frame) => frame.type === "data").map((frame) => frame.data).join(""), replay.data, "legacy string and ordered replay contain the same output");
    assert.equal(terminals.get(id)?.running, true, "reopening reuses the running process");
    await terminals.close(id);
    assert.equal(terminals.get(id), undefined, "only explicit tab close removes the terminal");
  } finally {
    for (const socket of sockets) socket.terminate();
    if (terminalId) await terminals.close(terminalId);
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
