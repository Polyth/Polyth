import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { SyncClient } from "../src/sync.ts";

class FakeSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  ended(code = 1006): void { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
}

const event = (seq: number, sessionId = "s1"): SessionEvent => ({
  id: `${sessionId}-${seq}`, sessionId, seq, time: seq, type: "test/event", data: {}, v: 1,
});

test("cursor-only replay is contiguous, recovers gaps, and remains bounded at 10k events", () => {
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({ webSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  const received: number[] = [];
  client.onEvent((msg) => {
    if (msg.type === "event") received.push(msg.event.seq);
    if (msg.type === "events") received.push(...msg.events.map((entry) => entry.seq));
  });
  client.setSubscription("s1", 0);
  client.connect("ws://test/ws");
  const socket = sockets[0]!;
  socket.open();
  socket.message({ type: "event", event: event(1) });
  socket.message({ type: "event", event: event(3) });
  assert.deepEqual(received, [1], "a gap is not applied or cursor-skipped");
  assert.deepEqual(socket.sent.map((raw) => JSON.parse(raw).afterSeq), [0, 1], "gap resubscribes from contiguous cursor");
  socket.message({ type: "events", events: [event(2), event(3)] });
  assert.deepEqual(received, [1, 2, 3]);

  const rest = Array.from({ length: 9_997 }, (_, index) => event(index + 4));
  socket.message({ type: "events", events: rest });
  assert.equal(received.length, 10_000);
  client.setSubscription("s1", 0);
  assert.equal(JSON.parse(socket.sent.at(-1)!).afterSeq, 10_000, "only highest contiguous cursor is retained");
});

test("an out-of-order replay frame is not sorted or partially trusted past its gap", () => {
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({ webSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  const received: number[] = [];
  client.onEvent((msg) => { if (msg.type === "events") received.push(...msg.events.map((entry) => entry.seq)); });
  client.setSubscription("s1", 0);
  client.connect("ws://test/ws");
  const socket = sockets[0]!;
  socket.open();
  socket.message({ type: "events", events: [event(1), event(3), event(2)] });
  assert.deepEqual(received, [1]);
  assert.equal(JSON.parse(socket.sent.at(-1)!).afterSeq, 1);
  socket.message({ type: "events", events: [event(2), event(3)] });
  assert.deepEqual(received, [1, 2, 3]);
});

test("session cursors use a bounded LRU and revisits trust the caller cursor", () => {
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({ maxSessionCursors: 3, webSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  client.setSubscription("active", 0);
  client.connect("ws://test/ws");
  const socket = sockets[0]!;
  socket.open();
  socket.message({ type: "event", event: event(1, "active") });
  client.setSubscription("evicted", 0);
  socket.message({ type: "event", event: event(1, "evicted") });
  client.setSubscription("recent-a", 0);
  socket.message({ type: "event", event: event(1, "recent-a") });
  client.setSubscription("recent-b", 0);
  socket.message({ type: "event", event: event(1, "recent-b") });
  client.setSubscription("active", 77);
  assert.equal(JSON.parse(socket.sent.at(-1)!).afterSeq, 77, "evicted cursors are not retained as hidden history");
  socket.message({ type: "event", event: event(78, "active") });
});

test("session-specific subscriptions reject wrong-session single and batch frames", () => {
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({ webSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  const received: number[] = [];
  client.onEvent((msg) => {
    if (msg.type === "event") received.push(msg.event.seq);
    if (msg.type === "events") received.push(...msg.events.map((entry) => entry.seq));
  });
  client.setSubscription("expected", 0);
  client.connect("ws://test/ws");
  const socket = sockets[0]!;
  socket.open();
  socket.message({ type: "event", event: event(1, "wrong") });
  socket.message({ type: "event", event: event(2, "wrong") });
  socket.message({ type: "events", events: [event(1, "expected"), event(1, "wrong")] });
  assert.deepEqual(received, []);
  assert.equal(socket.sent.length, 2, "wrong traffic reasserts the active subscription/cursor once");
  socket.message({ type: "event", event: event(1, "expected") });
  assert.deepEqual(received, [1], "wrong frames did not advance expected cursor");
});

test("project-wide subscriptions retain independent per-session cursors", () => {
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({ webSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  const received: string[] = [];
  client.onEvent((msg) => {
    if (msg.type === "events") received.push(...msg.events.map((entry) => `${entry.sessionId}:${entry.seq}`));
  });
  client.setSubscription(undefined, 0, "project");
  client.connect("ws://test/ws");
  sockets[0]!.open();
  sockets[0]!.message({ type: "events", events: [event(1, "one"), event(1, "two")] });
  assert.deepEqual(received, ["one:1", "two:1"]);
});

test("flapping opens preserve backoff; only a stable connection resets it", () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let now = 0;
  const client = new SyncClient({
    webSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length as never;
    },
    clearTimeout: () => {},
    random: () => 0,
    now: () => now,
    baseDelayMs: 10,
    maxDelayMs: 80,
    stableConnectionMs: 50,
  });
  client.connect("ws://test/ws");
  sockets[0]!.open();
  now = 1;
  sockets[0]!.ended();
  assert.equal(timers[0]!.delay, 5);
  timers[0]!.callback();
  sockets[1]!.open();
  now = 2;
  sockets[1]!.ended();
  assert.equal(timers[1]!.delay, 10, "short successful open did not reset the doubled backoff");
  timers[1]!.callback();
  sockets[2]!.open();
  now = 60;
  sockets[2]!.ended();
  assert.equal(timers[2]!.delay, 5, "stable open reset backoff before retry");
});

test("reconnect jitter stays within the bounded half-to-one-and-a-half window", () => {
  const delayFor = (random: number): number => {
    const sockets: FakeSocket[] = [];
    let delay = -1;
    const client = new SyncClient({
      webSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (_callback, ms) => { delay = ms; return 1 as never; },
      clearTimeout: () => {},
      random: () => random,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    });
    client.connect("ws://test/ws");
    sockets[0]!.open();
    sockets[0]!.ended();
    return delay;
  };
  assert.equal(delayFor(0), 50);
  assert.equal(delayFor(0.999), 149);
});

test("100 manual reconnects keep one authoritative socket and no timer tree", () => {
  const sockets: FakeSocket[] = [];
  let scheduled = 0;
  const client = new SyncClient({
    webSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => { scheduled += 1; return scheduled as never; },
    clearTimeout: () => {},
  });
  client.connect("ws://test/ws");
  for (let i = 0; i < 100; i += 1) client.reconnect();
  assert.equal(sockets.length, 101);
  assert.ok(sockets.slice(0, -1).every((socket) => socket.closed));
  assert.equal(sockets.at(-1)?.closed, false);
  assert.equal(scheduled, 0);
  client.close();
  assert.equal(sockets.at(-1)?.closed, true);
});

test("foreground resume supersedes a pending timer and uses the latest subscription", () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const client = new SyncClient({
    webSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback) => { timers.push(callback); return timers.length as never; },
    clearTimeout: () => {},
  });
  client.setSubscription("old", 3);
  client.connect("ws://test/ws");
  sockets[0]!.open();
  sockets[0]!.ended();
  assert.equal(timers.length, 1);
  client.setRetryHints({ foreground: false });
  client.setSubscription("new", 7);
  client.setRetryHints({ foreground: true });
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), { type: "subscribe", sessionId: "new", afterSeq: 7 });
  timers[0]!();
  assert.equal(sockets.length, 2, "superseded timer cannot create another socket");
  client.close();
  timers[0]!();
  assert.equal(sockets.length, 2, "close fences every future retry callback");
});

test("100 background/foreground cycles retain no live socket or reconnect timer", () => {
  const sockets: FakeSocket[] = [];
  let timers = 0;
  const client = new SyncClient({
    webSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => ++timers as never,
    clearTimeout: () => {},
  });
  client.connect("ws://test/ws");
  sockets[0]!.open();
  for (let i = 0; i < 100; i += 1) {
    client.setRetryHints({ foreground: false });
    client.setRetryHints({ foreground: true });
  }
  client.setRetryHints({ foreground: false });
  assert.equal(sockets.length, 101, "each foreground resumes exactly one transport");
  assert.ok(sockets.every((socket) => socket.closed));
  assert.equal(timers, 0, "suspension does not retain or schedule reconnect work");
  assert.equal(client.getStatus(), "suspended");
});

test("oversized canonical close is terminal instead of replaying the same cursor forever", () => {
  const sockets: FakeSocket[] = [];
  let timers = 0;
  const client = new SyncClient({
    webSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => ++timers as never,
    clearTimeout: () => {},
  });
  client.connect("ws://test/ws");
  sockets[0]!.open();
  sockets[0]!.ended(1009);
  assert.equal(client.getStatus(), "disconnected");
  assert.equal(timers, 0);
});

test("stale socket callbacks and retry collisions cannot corrupt the current generation", () => {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const client = new SyncClient({
    webSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length as never;
    },
    clearTimeout: () => {},
    random: () => 0,
    baseDelayMs: 10,
    maxDelayMs: 20,
  });
  const received: number[] = [];
  client.onEvent((msg) => { if (msg.type === "event") received.push(msg.event.seq); });
  client.setSubscription("s1", 0);
  client.connect("ws://test/ws");
  const first = sockets[0]!;
  first.open();
  client.reconnect();
  const second = sockets[1]!;
  second.open();
  first.open();
  first.message({ type: "event", event: event(1) });
  first.onerror?.({} as Event);
  first.ended();
  assert.deepEqual(received, []);
  assert.equal(timers.length, 0, "stale close/error cannot schedule retries");

  second.ended();
  assert.equal(client.getStatus(), "reconnecting");
  assert.equal(timers.length, 1);
  client.reconnect();
  assert.equal(sockets.length, 3, "manual reconnect replaces, rather than races, timer generation");
  timers[0]!();
  assert.equal(sockets.length, 3, "superseded timer is fenced");
  client.setRetryHints({ online: false });
  sockets[2]!.ended();
  assert.equal(client.getStatus(), "offline");
  client.close();
  assert.equal(client.getStatus(), "disconnected");
});
