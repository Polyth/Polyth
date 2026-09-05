import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, Agent } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import {
  createHttpHandler,
  createPublicHttpServer,
  createTunnelIngress,
  createTunnelIngressServer,
  TUNNEL_INTERNAL_CONNECTION_HEADER,
  TUNNEL_INTERNAL_TOKEN_HEADER,
} from "../src/http.ts";
import { createWsGateway } from "../src/ws.ts";
import { attachTerminalWs } from "../../terminal/src/serverEntry.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-http-tunnel-"));

test("polyth-link ingress is default-deny, ignores cookies, and never uses localhost optional", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    envPassword: "pw",
    localhostOptional: true,
    resolvePairedDevice: (ingress) => ingress.connectionId === "live" ? {
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: ingress.connectionId,
      transport: ingress.transport,
      grants: [...GRANT_PROFILE_PRESETS.observe],
      grantRevision: 1,
    } : null,
  });
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const server = createServer((req, res) => {
    const connectionId = String(req.headers[TUNNEL_INTERNAL_CONNECTION_HEADER] ?? "live");
    void handler(req, res, { kind: "polyth-link", connectionId, transport: "direct" });
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const unknown = await fetch(`${base}/api/does-not-exist`);
    assert.equal(unknown.status, 403);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    assert.equal(login.status, 403);

    const write = await fetch(`${base}/api/sessions`, { method: "POST", body: "{}" });
    assert.equal(write.status, 403);

    const projects = await fetch(`${base}/api/projects`, {
      headers: { cookie: "polyth_auth=" + "ab".repeat(32), authorization: "Bearer x" },
    });
    assert.equal(projects.status, 200);

    const stale = await fetch(`${base}/api/projects`, {
      headers: { [TUNNEL_INTERNAL_CONNECTION_HEADER]: "stale" },
    });
    assert.equal(stale.status, 401);

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 403);
  } finally {
    server.close();
  }
});

test("tunnel unix ingress rejects missing or wrong per-boot secret", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: "live",
      transport: "direct",
      grants: [...GRANT_PROFILE_PRESETS.observe],
      grantRevision: 1,
    }),
  });
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const secret = "a".repeat(64);
  const server = createTunnelIngressServer(handler, {
    secret,
    lookup: (connectionId) => connectionId === "live"
      ? { kind: "polyth-link", connectionId, transport: "direct" }
      : null,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${base}/api/health`);
    assert.equal(denied.status, 403);
    const wrong = await fetch(`${base}/api/health`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: "b".repeat(64),
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
      },
    });
    assert.equal(wrong.status, 403);
    const ok = await fetch(`${base}/api/health`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
      },
    });
    assert.equal(ok.status, 200);
    const stale = await fetch(`${base}/api/health`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "other",
      },
    });
    assert.equal(stale.status, 403);
  } finally {
    server.close();
  }
});

const noKeepAlive = new Agent({ keepAlive: false });

function unixRequest(socketPath: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function openUnixWs(socketPath: string, path: string, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws+unix://${socketPath}:${path}`, {
    headers,
    handshakeTimeout: 2000,
    agent: noKeepAlive,
    perMessageDeflate: false,
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      ws.on("error", () => {});
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 500);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close();
  });
}

function rawUpgrade(
  socketPath: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ kind: "response" | "unclaimed"; preview: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let preview = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ kind: "unclaimed", preview });
    }, 200);
    socket.on("connect", () => {
      const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      preview += chunk.toString("utf8");
      if (preview.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ kind: "response", preview });
      }
    });
    socket.on("error", reject);
  });
}

test("canonical unix ingress answers HTTP and removes the socket on close", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: "live",
      transport: "direct",
      grants: [...GRANT_PROFILE_PRESETS.observe],
      grantRevision: 1,
    }),
  });
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const secret = "c".repeat(64);
  const socketPath = join(dir, "ingress.sock");
  const handle = createTunnelIngress({
    handler,
    secret,
    socketPath,
    lookup: (connectionId) => connectionId === "live"
      ? { kind: "polyth-link", connectionId, transport: "direct" }
      : null,
    resolve: (request, ingress) => auth.resolve(request, ingress),
    attachChannels() {},
  });
  await handle.listen();
  try {
    const health = await unixRequest(socketPath, "/api/health", {
      [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
      [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
    });
    assert.equal(health.status, 200);
    const denied = await unixRequest(socketPath, "/api/health", {
      [TUNNEL_INTERNAL_TOKEN_HEADER]: "nope".padEnd(64, "x"),
      [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
    });
    assert.equal(denied.status, 403);
    const stale = await unixRequest(socketPath, "/api/health", {
      [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
      [TUNNEL_INTERNAL_CONNECTION_HEADER]: "missing",
    });
    assert.equal(stale.status, 403);
  } finally {
    await handle.close();
  }
  assert.equal(existsSync(socketPath), false);
});

test("public listener ignores internal tunnel headers as identity", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    envPassword: "pw",
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "spoof",
      deviceEndpointId: "ep",
      connectionId: "live",
      transport: "direct",
      grants: [...GRANT_PROFILE_PRESETS.developer],
      grantRevision: 1,
    }),
  });
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const { createPublicHttpServer } = await import("../src/http.ts");
  const server = createPublicHttpServer(handler, "public");
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const spoofed = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: {
        [TUNNEL_INTERNAL_TOKEN_HEADER]: "c".repeat(64),
        [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
      },
    });
    assert.equal(spoofed.status, 401);
  } finally {
    server.close();
  }
});

test("canonical /ws, terminal, and tunnel event channels attach to unix ingress", async () => {
  const dir = tmp();
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  const auth = createAuthService({
    file: join(dir, "auth.json"),
    resolvePairedDevice: () => ({
      kind: "paired-device",
      deviceId: "dev-1",
      deviceEndpointId: "ep",
      connectionId: "live",
      transport: "direct",
      grants: [...GRANT_PROFILE_PRESETS.developer],
      grantRevision: 1,
    }),
  });
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
  });
  const secret = "c".repeat(64);
  const socketPath = join(dir, "ingress.sock");
  const gateway = createWsGateway({ list: async () => [], events: async () => [] } as never);
  const terminals = {
    get: (id: string) => id === "t1" ? { id: "t1", projectId: "p", cwd: dir, running: true } : undefined,
    replay: () => "",
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
  };
  const { TunnelEventBus, attachTunnelEventsWs } = await import("../../tunnel/src/events.ts");
  const events = new TunnelEventBus();
  const attachChannels = (
    ctx: Parameters<NonNullable<Parameters<typeof createTunnelIngress>[0]["attachChannels"]>>[0],
  ) => {
    attachTerminalWs(ctx.server, {
      terminals: terminals as never,
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    });
    attachTunnelEventsWs(ctx.server, {
      events,
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    });
    gateway.attach(ctx.server, {
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    });
  };
  const start = () => createTunnelIngress({
    handler,
    secret,
    socketPath,
    lookup: (connectionId) => connectionId === "live"
      ? { kind: "polyth-link", connectionId, transport: "direct" }
      : null,
    resolve: (request, ingress) => auth.resolve(request, ingress),
    attachChannels,
  });
  const handle = start();
  await handle.listen();
  const firstUpgradeCount = handle.server.listenerCount("upgrade");
  assert.equal(firstUpgradeCount, 1, "one canonical upgrade dispatcher");
  try {
    const headers = {
      [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
      [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
    };
    const health = await unixRequest(socketPath, "/api/health", headers);
    assert.equal(health.status, 200);

    const ws = await openUnixWs(socketPath, "/ws", headers);
    await closeWs(ws);

    const terminal = await openUnixWs(socketPath, "/ws/terminal/t1", headers);
    await closeWs(terminal);

    const tunnel = await openUnixWs(socketPath, "/ws/tunnel", headers);
    await closeWs(tunnel);

    const unknown = await rawUpgrade(socketPath, "/ws/unknown", headers);
    assert.equal(unknown.kind, "response");
    assert.match(unknown.preview, /^HTTP\/1\.1 404 Not Found\r\n/);
    assert.match(unknown.preview, /Connection: close/i);
  } finally {
    await handle.close();
  }
  assert.equal(existsSync(socketPath), false);

  const restarted = start();
  await restarted.listen();
  try {
    assert.equal(restarted.server.listenerCount("upgrade"), firstUpgradeCount);
    const health = await unixRequest(socketPath, "/api/health", {
      [TUNNEL_INTERNAL_TOKEN_HEADER]: secret,
      [TUNNEL_INTERNAL_CONNECTION_HEADER]: "live",
    });
    assert.equal(health.status, 200);
  } finally {
    await restarted.close();
  }
});
