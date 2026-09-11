import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { AuthPrincipal, SessionEvent, SessionService } from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY } from "@polyth/contracts";
import { PairedSocketRegistry } from "@polyth/plugins";
import { isDictationAudioFrame, decodeDictationAudioFrame, encodeDictationAudioFrame } from "../../dictation/src/wire.ts";
import { attachWs } from "../src/ws.ts";

const proj = {
  id: "s1", projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1,
};

function sessionsStub(): SessionService {
  return {
    events: async () => [] as SessionEvent[],
    list: async () => [proj],
  } as unknown as SessionService;
}

function paired(deviceId: string, grants: string[], connectionId = `${deviceId}-c`): AuthPrincipal {
  return {
    kind: "paired-device",
    deviceId,
    deviceEndpointId: "ep",
    connectionId,
    transport: "direct",
    grants,
    grantRevision: 1,
  };
}

function connect(port: number, headers?: Record<string, string>): Promise<{
  ws: WebSocket;
  messages: unknown[];
  next: () => Promise<Record<string, unknown>>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  const messages: unknown[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    messages.push(m);
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
    ws.on("open", () => res({ ws, messages, next }));
    ws.on("error", rej);
  });
}

test("paired core.sessions.read cannot subscribe to browser frames or send dictation audio", async () => {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const dictation = {
    decodeAudioFrame: (value: ArrayBuffer | ArrayBufferView) => isDictationAudioFrame(value) ? decodeDictationAudioFrame(value) : null,
    get: () => ({ id: "d1" }),
    push: async () => ({ ack: 1, duplicate: false }),
  };
  const browser = {
    latestFrame: () => undefined,
    onFrame: () => {},
    onEvent: () => {},
  };
  attachWs(server, sessionsStub(), browser as never, dictation as never, {
    identity: () => ({
      authenticated: true,
      principal: paired("dev-a", [...GRANT_PROFILE_PRESETS.observe]),
    }),
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, next } = await connect(port);
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
    const projections = await next();
    assert.equal(projections.type, "projections");
    ws.send(JSON.stringify({ type: "browser/subscribe", browserSessionId: "b1" }));
    const browserDenied = await next();
    assert.equal(browserDenied.type, "error");
    assert.equal(browserDenied.code, "forbidden");
    ws.send(encodeDictationAudioFrame({ dictationId: "d1", seq: 1, sampleRate: 16_000, channels: 1, payload: new Uint8Array([0, 0]) }));
    const dictationDenied = await next();
    assert.equal(dictationDenied.type, "error");
    assert.equal(dictationDenied.code, "forbidden");
    ws.close();
  } finally {
    server.close();
  }
});

test("notification permission and local-only package events", async () => {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const grants = { current: [REMOTE_CAPABILITY.coreSessionsRead] };
  const gateway = attachWs(server, sessionsStub(), undefined, undefined, {
    identity: () => ({
      authenticated: true,
      principal: paired("dev-a", grants.current),
    }),
    refreshPrincipal: (principal) => principal.kind === "paired-device"
      ? { ...principal, grants: grants.current }
      : principal,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, messages } = await connect(port);
    gateway.notification({
      id: "n1", key: "k", kind: "completed", sessionId: "s1", projectId: "p1",
      title: "T", body: "done", ts: 1, read: false,
    });
    gateway.packageChanged({ id: "tunnel", enabled: true } as never);
    gateway.clientSettingsChanged({ revision: 1, settings: {} } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(messages.some((item) => (item as { type?: string }).type === "notification/added"), false);
    assert.equal(messages.some((item) => (item as { type?: string }).type === "package/changed"), false);
    assert.equal(messages.some((item) => (item as { type?: string }).type === "client-settings/changed"), false);
    grants.current = [REMOTE_CAPABILITY.coreSessionsRead, REMOTE_CAPABILITY.coreNotificationsRead];
    gateway.notification({
      id: "n2", key: "k2", kind: "completed", sessionId: "s1", projectId: "p1",
      title: "T", body: "done", ts: 2, read: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(messages.some((item) => (item as { type?: string }).type === "notification/added"), true);
    ws.close();
  } finally {
    server.close();
  }
});

test("local UI sockets keep unrestricted behavior", async () => {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const gateway = attachWs(server, sessionsStub());
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, messages } = await connect(port);
    gateway.packageChanged({ id: "tunnel", enabled: true } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(messages.some((item) => (item as { type?: string }).type === "package/changed"), true);
    ws.close();
  } finally {
    server.close();
  }
});

test("revoking one device closes only that device's sockets", async () => {
  const registry = new PairedSocketRegistry();
  const revoked = new Set<string>();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, sessionsStub(), undefined, undefined, {
    identity: (req) => {
      const deviceId = String(req.headers["x-device"] ?? "a");
      return {
        authenticated: true,
        principal: paired(deviceId, [...GRANT_PROFILE_PRESETS.observe], `${deviceId}-c`),
      };
    },
    refreshPrincipal: (principal) => {
      if (principal.kind !== "paired-device") return principal;
      if (revoked.has(principal.deviceId)) return null;
      return principal;
    },
    pairedSockets: registry,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const a = await connect(port, { "x-device": "a" });
    const b = await connect(port, { "x-device": "b" });
    const aClosed = once(a.ws, "close");
    registry.closeDevice("a");
    await aClosed;
    assert.equal(a.ws.readyState, WebSocket.CLOSED);
    assert.equal(b.ws.readyState, WebSocket.OPEN);
    b.ws.close();
  } finally {
    server.close();
  }
});

test("revoked session grant cannot leak a delayed gap-fill", async () => {
  let release!: (events: SessionEvent[]) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new Promise<SessionEvent[]>((resolve) => { release = resolve; });
  const grants = { current: [REMOTE_CAPABILITY.coreSessionsRead] };
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, {
    events: async () => { started(); return delayed; },
    list: async () => [proj],
  } as unknown as SessionService, undefined, undefined, {
    identity: () => ({ authenticated: true, principal: paired("dev-a", grants.current) }),
    refreshPrincipal: (principal) => principal.kind === "paired-device"
      ? { ...principal, grants: grants.current, grantRevision: principal.grantRevision + 1 }
      : principal,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, messages } = await connect(port);
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
    await began;
    grants.current = [];
    release([{ id: "secret", sessionId: "s1", seq: 1, time: 1, type: "test/secret", data: { secret: true }, v: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.some((message) => {
      const type = (message as { type?: string }).type;
      return type === "event" || type === "events" || type === "projection" || type === "projections";
    }), false, JSON.stringify(messages));
    ws.close();
  } finally {
    server.close();
  }
});

test("revoked session grant cannot leak a delayed projection snapshot", async () => {
  let release!: (items: typeof proj[]) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new Promise<typeof proj[]>((resolve) => { release = resolve; });
  const grants = { current: [REMOTE_CAPABILITY.coreSessionsRead] };
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, {
    events: async () => [],
    list: async () => { started(); return delayed; },
  } as unknown as SessionService, undefined, undefined, {
    identity: () => ({ authenticated: true, principal: paired("dev-a", grants.current) }),
    refreshPrincipal: (principal) => principal.kind === "paired-device"
      ? { ...principal, grants: grants.current, grantRevision: principal.grantRevision + 1 }
      : principal,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const { ws, messages } = await connect(port);
    ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", afterSeq: 0 }));
    await began;
    grants.current = [];
    release([proj]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.some((message) => (message as { type?: string }).type === "projections"), false);
    ws.close();
  } finally {
    server.close();
  }
});
