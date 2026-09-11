// WsGateway owns browser subscriptions and HTTP upgrade claims for its
// lifetime. close() must drop both, stay idempotent, and stop delivering
// into backing services that shutdown is about to dispose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { SessionEvent, SessionProjection, SessionService } from "@polyth/contracts";
import type { BrowserFrame, BrowserRuntimeEvent, BrowserService } from "@polyth/browser";
import { createWsGateway } from "../src/ws.ts";

const proj: SessionProjection = {
  id: "s1", projectId: "p1", title: "T", status: "idle",
  createdAt: 1, updatedAt: 1,
} as SessionProjection;

function stubSessions(overrides: Partial<SessionService> = {}): SessionService {
  return {
    events: async () => [],
    list: async () => [proj],
    ...overrides,
  } as unknown as SessionService;
}

function mockBrowser() {
  const frames = new Set<(frame: BrowserFrame) => void>();
  const events = new Set<(event: BrowserRuntimeEvent) => void>();
  const visible = new Map<string, boolean>();
  const browser = {
    get: (id: string) => ({ id, projectId: "p1", status: "ready" }),
    setViewerVisible: (id: string, value: boolean) => { visible.set(id, value); },
    latestFrame: () => null,
    onFrame(cb: (frame: BrowserFrame) => void) {
      frames.add(cb);
      return { dispose: () => { frames.delete(cb); } };
    },
    onEvent(cb: (event: BrowserRuntimeEvent) => void) {
      events.add(cb);
      return { dispose: () => { events.delete(cb); } };
    },
  } as unknown as BrowserService;
  return {
    browser, visible,
    frameCount: () => frames.size,
    eventCount: () => events.size,
    emitFrame(frame: BrowserFrame) {
      for (const cb of [...frames]) cb(frame);
    },
    emitEvent(event: BrowserRuntimeEvent) {
      for (const cb of [...events]) cb(event);
    },
  };
}

interface WsMsg {
  type: string;
  event?: SessionEvent;
  events?: SessionEvent[];
  sessions?: Array<{ id: string }>;
  browserSessionId?: string;
  revision?: number;
}

function listen(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.listen(0);
  return once(server, "listening").then(() => ({
    server,
    port: (server.address() as { port: number }).port,
  }));
}

function connect(port: number): Promise<{ ws: WebSocket; messages: WsMsg[]; next: () => Promise<WsMsg> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue: WsMsg[] = [];
  const waiters: Array<(m: WsMsg) => void> = [];
  const messages: WsMsg[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as WsMsg;
    messages.push(m);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (): Promise<WsMsg> =>
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

function rejectConnect(port: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("expected upgrade to fail")), 4000);
    timer.unref();
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      rej(new Error("upgrade succeeded after gateway close"));
    });
    ws.on("error", () => {
      clearTimeout(timer);
      res();
    });
    ws.on("unexpected-response", () => {
      clearTimeout(timer);
      ws.terminate();
      res();
    });
  });
}

test("close releases browser subscriptions and stops frame/event delivery", async () => {
  const { server, port } = await listen();
  const browser = mockBrowser();
  const gateway = createWsGateway(stubSessions(), browser.browser);
  gateway.attach(server);
  try {
    assert.equal(browser.frameCount(), 1);
    assert.equal(browser.eventCount(), 1);
    const { ws, messages, next } = await connect(port);
    ws.send(JSON.stringify({ type: "browser/subscribe", browserSessionId: "b1", afterRevision: 0 }));
    await new Promise<void>((res) => { ws.once("pong", () => res()); ws.ping(); });

    browser.emitFrame({
      browserSessionId: "b1", revision: 1, mime: "image/jpeg", data: new Uint8Array([1]),
    });
    const frame = await next();
    assert.equal(frame.type, "browser/frame");
    assert.equal(frame.revision, 1);

    gateway.close();
    gateway.close();
    assert.equal(browser.frameCount(), 0);
    assert.equal(browser.eventCount(), 0);

    const before = messages.length;
    browser.emitFrame({
      browserSessionId: "b1", revision: 2, mime: "image/jpeg", data: new Uint8Array([2]),
    });
    browser.emitEvent({ browserSessionId: "b1", kind: "console" });
    await new Promise((res) => setTimeout(res, 50).unref());
    assert.equal(messages.length, before, "no browser callbacks after close");
    ws.close();
  } finally {
    gateway.close();
    server.close();
  }
});

test("close removes upgrade claims; attach after close does not leak them", async () => {
  const { server, port } = await listen();
  const gateway = createWsGateway(stubSessions());
  gateway.attach(server);
  try {
    const { ws } = await connect(port);
    ws.close();
    gateway.close();
    await rejectConnect(port);

    const second = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    second.listen(0);
    await once(second, "listening");
    const secondPort = (second.address() as { port: number }).port;
    try {
      gateway.attach(second);
      await rejectConnect(secondPort);
    } finally {
      second.close();
    }
  } finally {
    gateway.close();
    server.close();
  }
});

test("repeated close is harmless and boot/shutdown cycles do not accumulate listeners", async () => {
  const browser = mockBrowser();
  for (let i = 0; i < 5; i++) {
    const { server, port } = await listen();
    const gateway = createWsGateway(stubSessions(), browser.browser);
    gateway.attach(server);
    const { ws } = await connect(port);
    ws.close();
    gateway.close();
    gateway.close();
    assert.equal(browser.frameCount(), 0, `frame listeners after cycle ${i}`);
    assert.equal(browser.eventCount(), 0, `event listeners after cycle ${i}`);
    await rejectConnect(port);
    server.close();
    await once(server, "close");
  }
});

test("close removes the HTTP server close listener; replacements do not accumulate", async () => {
  const { server } = await listen();
  try {
    const first = createWsGateway(stubSessions());
    first.attach(server);
    first.close();
    const afterFirst = server.listenerCount("close");
    for (let i = 0; i < 20; i++) {
      const gateway = createWsGateway(stubSessions());
      gateway.attach(server);
      gateway.close();
      gateway.close();
      assert.equal(server.listenerCount("close"), afterFirst, `close listeners after replacement ${i}`);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("closed gateway does not reach disposed backing services", async () => {
  let disposed = false;
  let listCalls = 0;
  let resolveGap!: (events: SessionEvent[]) => void;
  const blocked = stubSessions({
    events: () => new Promise<SessionEvent[]>((resolve) => { resolveGap = resolve; }),
    list: async () => {
      listCalls++;
      if (disposed) throw new Error("store already closed");
      return [proj];
    },
  });
  const { server, port } = await listen();
  const gateway = createWsGateway(blocked);
  gateway.attach(server);
  try {
    const { ws } = await connect(port);
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, projectId: "p1" }));
    await new Promise((res) => setTimeout(res, 20).unref());
    gateway.close();
    disposed = true;
    resolveGap([]);
    await new Promise((res) => setTimeout(res, 30).unref());
    assert.equal(listCalls, 0, "gap-fill must not list after close");
    gateway.event({
      id: "e1", sessionId: "s1", seq: 1, time: 1, type: "test/event", data: {}, v: 1,
    });
    gateway.projection(proj);
    ws.close();
  } finally {
    gateway.close();
    server.close();
  }
});

test("browser visibility counts all viewers and refuses a known foreign Space browser", async () => {
  const { server, port } = await listen();
  const fixture = mockBrowser();
  fixture.browser.get = (id) => ({ id, projectId: id === "foreign" ? "foreign-project" : "p1", sessionId: "s1", status: "ready" }) as never;
  const spaces = {
    cookieName: "space",
    resolve: () => ({ spaceId: "a" }),
    services: () => ({ sessions: stubSessions() }),
    guard: {
      assertProject: (_ctx: unknown, id: string) => { if (id !== "p1") throw new Error("not-found"); },
      assertSession: (_ctx: unknown, id: string) => { if (id !== "s1") throw new Error("not-found"); },
    },
  };
  const gateway = createWsGateway(stubSessions(), fixture.browser, undefined, spaces as never);
  gateway.attach(server);
  const a = await connect(port);
  const b = await connect(port);
  const subscribe = async (ws: WebSocket, id: string, visible = true) => {
    ws.send(JSON.stringify({ type: "browser/subscribe", browserSessionId: id, visible }));
    await new Promise<void>((r) => { ws.once("pong", () => r()); ws.ping(); });
  };
  try {
    await subscribe(a.ws, "foreign");
    const denied = await a.next();
    assert.equal(denied.type, "error");
    assert.equal(fixture.visible.has("foreign"), false);
    await subscribe(a.ws, "b1");
    await subscribe(b.ws, "b1");
    assert.equal(fixture.visible.get("b1"), true);
    await subscribe(a.ws, "b1", false);
    assert.equal(fixture.visible.get("b1"), true, "the other client still sees Browser");
    await subscribe(b.ws, "b1", false);
    assert.equal(fixture.visible.get("b1"), false);
    fixture.emitFrame({ browserSessionId: "b1", revision: 1, mime: "image/jpeg", data: new Uint8Array([1]) });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(a.messages.filter((m) => m.type === "browser/frame").length, 0);
    assert.equal(b.messages.filter((m) => m.type === "browser/frame").length, 0);
  } finally { a.ws.close(); b.ws.close(); gateway.close(); server.close(); }
});
