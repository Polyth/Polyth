import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { AuthPrincipal } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { attachTerminalWs } from "../src/serverEntry.ts";

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
