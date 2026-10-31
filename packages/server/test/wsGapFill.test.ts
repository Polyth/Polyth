// P0 regression: (1) live events broadcast while a gap-fill is awaiting the
// DB must be buffered and flushed (seq-deduped) once the gap-fill completes —
// their seqs sit above the gap-fill boundary, so dropping them loses them
// until re-subscribe; (2) a subscribe arriving while another is in flight
// must be processed afterwards (latest wins), not silently discarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { SessionEvent, SessionProjection, SessionService } from "@polyth/contracts";
import { attachWs, legacyReplayPage } from "../src/ws.ts";

const mkEv = (sessionId: string, seq: number): SessionEvent => ({
  id: `${sessionId}-${seq}`, sessionId, seq, time: seq, type: "test/event", data: {}, v: 1,
});

const proj: SessionProjection = {
  id: "s1", projectId: "p1", title: "T", status: "idle",
  createdAt: 1, updatedAt: 1,
} as SessionProjection;

interface GapCall {
  sessionId: string;
  afterSeq: number;
  resolve: (evs: SessionEvent[]) => void;
}

/**
 * Session service double whose events() never resolves on its own: each call
 * is surfaced via nextGap() and the test decides when (and with what) the
 * gap-fill completes, so live broadcasts can be raced deterministically.
 */
function controllableSessions() {
  const pending: GapCall[] = [];
  const waiters: Array<(c: GapCall) => void> = [];
  const seen: Array<{ sessionId: string; afterSeq: number }> = [];
  const sessions = {
    events: (sessionId: string, afterSeq: number) =>
      new Promise<SessionEvent[]>((resolve) => {
        seen.push({ sessionId, afterSeq });
        const call: GapCall = { sessionId, afterSeq, resolve };
        const w = waiters.shift();
        if (w) w(call);
        else pending.push(call);
      }),
    list: async () => [proj],
    replayPage: async (id: string, cursor: number) => {
      const events = await sessions.events(id, cursor);
      const highWater = events.at(-1)?.seq ?? cursor;
      return { events, cursor: highWater, highWater, complete: true };
    },
  } as unknown as SessionService;
  const nextGap = (): Promise<GapCall> =>
    pending.length > 0
      ? Promise.resolve(pending.shift()!)
      : new Promise((res, rej) => {
          waiters.push(res);
          setTimeout(() => rej(new Error("gap-fill call timeout")), 5000).unref();
        });
  return { sessions, nextGap, seen };
}

interface WsMsg {
  type: string;
  phase?: string;
  token?: number;
  event?: SessionEvent;
  events?: SessionEvent[];
  session?: SessionProjection;
  sessions?: SessionProjection[];
  code?: string;
}

function connect(port: number): Promise<{ ws: WebSocket; next: () => Promise<WsMsg> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue: WsMsg[] = [];
  const waiters: Array<(m: WsMsg) => void> = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as WsMsg;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (): Promise<WsMsg> =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise((res, rej) => {
          waiters.push(res);
          setTimeout(() => rej(new Error("ws message timeout")), 5000).unref();
        });
  return new Promise((res, rej) => {
    ws.on("open", () => res({ ws, next }));
    ws.on("error", rej);
  });
}

/** Round-trips a ping so all previously sent client messages have been handled. */
const settle = (ws: WebSocket): Promise<void> =>
  new Promise((res) => { ws.once("pong", () => res()); ws.ping(); });

test("summary subscribers refresh the selected draft outside the navigator page and on same-project navigation", async (t) => {
  const other = { ...proj, id: "outside", summary: true as const };
  let snapshots = 0;
  const sessions = {
    replayPage: async () => ({ events: [], cursor: 0, highWater: 0, complete: true }),
    summaries: async () => ({ sessions: [other], complete: false, revision: 1 }),
    snapshot: async (id: string) => { snapshots++; return { ...proj, id, draft: `server draft ${id}`, draftUpdatedAt: 123 }; },
  } as unknown as SessionService;
  const server = createServer();
  const broadcast = attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  client.ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", sessionId: "s1", afterSeq: 0, summaryProjections: true }));
  // The selected row goes out first, ahead of the navigator page.
  const first = await client.next();
  assert.equal(first.type, "projection");
  assert.equal(first.session?.draft, "server draft s1");
  const list = await client.next();
  assert.equal(list.type, "projections");
  assert.equal(list.sessions?.find((row) => row.id === "s1"), undefined);
  assert.equal(list.sessions?.find((row) => row.id === "outside")?.summary, true);
  client.ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", sessionId: "s2", afterSeq: 0, summaryProjections: true }));
  const next = await client.next();
  assert.equal(next.session?.id, "s2");
  assert.equal(next.session?.draft, "server draft s2");
  broadcast.projection({ ...proj, id: "s2", draft: "latest", draftUpdatedAt: 124 });
  assert.equal((await client.next()).session?.draft, "latest");
  broadcast.projection({ ...proj, id: "outside", draft: "private inactive detail" });
  assert.equal((await client.next()).session?.draft, undefined);
  assert.equal(snapshots, 2);
});

test("a scoped summary subscriber also sees every project's active rows so the rail status is live", async (t) => {
  const other = { ...proj, id: "outside", projectId: "p2", title: "Other project", status: "working" as const, updatedAt: 2 };
  const queries: Array<{ projectId?: string; attentionOnly?: boolean }> = [];
  const sessions = {
    replayPage: async () => ({ events: [], cursor: 0, highWater: 0, complete: true }),
    summaries: async (query: { projectId?: string; attentionOnly?: boolean }) => {
      queries.push(query);
      return query.attentionOnly
        ? { sessions: [{ ...other, summary: true as const, draftPreview: "never sent" }], complete: true, revision: 1 }
        : { sessions: [{ ...proj, summary: true as const }], complete: true, revision: 1 };
    },
    snapshot: async (id: string) => ({ ...proj, id }),
  } as unknown as SessionService;
  const server = createServer();
  const broadcast = attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  client.ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", sessionId: "s1", afterSeq: 0, summaryProjections: true }));

  // The navigator page stays project-scoped; activity from other projects
  // arrives as summary rows before those projects are ever opened.
  let row: SessionProjection | undefined;
  for (let i = 0; i < 20 && !row; i++) {
    const message = await client.next();
    const rows = message.type === "projections" ? message.sessions ?? []
      : message.type === "projection" && message.session ? [message.session] : [];
    row = rows.find((candidate) => candidate.id === "outside");
  }
  assert.equal(row?.projectId, "p2");
  assert.equal(row?.status, "working");
  assert.equal(row?.summary, true);
  assert.equal(row?.draft, undefined, "another project travels only as a summary");
  assert.ok(queries.some((query) => query.attentionOnly === true && query.projectId === undefined),
    "the snapshot asks the Space for active rows, not one project's page");

  // A turn ending in another project reaches the rail without opening it.
  broadcast.projection({ ...other, status: "idle" });
  let live: SessionProjection | undefined;
  for (let i = 0; i < 20 && !live; i++) {
    const message = await client.next();
    const candidate = message.type === "projection" ? message.session : undefined;
    if (candidate?.id === "outside" && candidate.status === "idle") live = candidate;
  }
  assert.equal(live?.summary, true);
  assert.equal(live?.draft, undefined);
});

test("the navigator snapshot carries the reader's pinned chats beyond the recency page", async (t) => {
  const recent = { ...proj, id: "recent", updatedAt: 9, summary: true as const };
  const oldPin = { ...proj, id: "old-pin", updatedAt: 1, pinned: { position: 0 }, summary: true as const };
  const queries: Array<{ pinned?: boolean; attentionOnly?: boolean }> = [];
  const sessions = {
    replayPage: async () => ({ events: [], cursor: 0, highWater: 0, complete: true }),
    summaries: async (query: { pinned?: boolean }) => {
      queries.push(query);
      return query.pinned
        ? { sessions: [oldPin, recent], complete: true, revision: 1 }
        : { sessions: [recent], complete: false, revision: 1 };
    },
    snapshot: async (id: string) => ({ ...proj, id }),
  } as unknown as SessionService;
  const server = createServer();
  attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  client.ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", sessionId: "s1", afterSeq: 0, summaryProjections: true }));
  let list: WsMsg | undefined;
  while (!list) {
    const message = await client.next();
    if (message.type === "projections") list = message;
  }
  assert.deepEqual(list.sessions?.map((row) => row.id), ["recent", "old-pin"], "pinned rows join once, after the page");
  assert.deepEqual(
    queries.filter((query) => query.attentionOnly !== true).map((query) => query.pinned === true),
    [false, true],
    "the project page reads recency, then pinned; the cross-project activity read is separate",
  );
});

test("sync receipts confirm the open session before the navigator list, echoing the client token", async (t) => {
  const sessions = {
    replayPage: async (_id: string, cursor: number) => cursor === 0
      ? { events: [mkEv("s1", 1)], cursor: 1, highWater: 1, complete: true }
      : { events: [], cursor, highWater: cursor, complete: true },
    summaries: async () => ({ sessions: [{ ...proj, id: "other", summary: true as const }], complete: true, revision: 1 }),
    snapshot: async (id: string) => ({ ...proj, id }),
  } as unknown as SessionService;
  const server = createServer();
  attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  client.ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", sessionId: "s1", afterSeq: 0, summaryProjections: true, syncToken: 7 }));
  const order: string[] = [];
  for (;;) {
    const message = await client.next();
    order.push(message.type === "synced" ? `synced:${message.phase}:${message.token}` : message.type);
    if (message.type === "synced" && message.phase === "sessions") break;
  }
  assert.deepEqual(order, ["events", "projection", "synced:session:7", "projections", "synced:sessions:7"]);
  // A same-scope resubscribe skips the list but still confirms both phases.
  client.ws.send(JSON.stringify({ type: "subscribe", projectId: "p1", sessionId: "s1", afterSeq: 1, summaryProjections: true, syncToken: 8 }));
  const again: string[] = [];
  for (;;) {
    const message = await client.next();
    again.push(message.type === "synced" ? `synced:${message.phase}:${message.token}` : message.type);
    if (message.type === "synced" && message.phase === "sessions") break;
  }
  assert.deepEqual(again, ["projection", "synced:session:8", "synced:sessions:8"]);
});

test("subscribers that do not ask for receipts never receive one", async (t) => {
  const sessions = {
    replayPage: async () => ({ events: [], cursor: 0, highWater: 0, complete: true }),
    list: async () => [proj],
  } as unknown as SessionService;
  const server = createServer();
  attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  client.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
  assert.equal((await client.next()).type, "projections");
  await settle(client.ws);
  client.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
  await settle(client.ws);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(Promise.race([client.next(), new Promise((_, rej) => setTimeout(() => rej(new Error("none")), 150))]));
});

test("legacy newest-limit adapters select a bounded forward range, never the newest gap slice", async () => {
  let reads = 0;
  const sessions = { events: async (id: string, after: number, page: { limit: number; beforeSeq?: number }) => {
    reads++;
    const end = Math.min(170_000, (page.beforeSeq ?? 170_001) - 1);
    const start = Math.max(after + 1, end - page.limit + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => mkEv(id, start + i));
  } } as unknown as SessionService;
  const first = await legacyReplayPage(sessions, "s1", 0);
  assert.equal(first.highWater, 170_000);
  assert.equal(first.events[0]?.seq, 1);
  assert.equal(first.cursor, 500);
  const second = await legacyReplayPage(sessions, "s1", first.cursor, first.highWater);
  assert.equal(second.events[0]?.seq, 501);
  assert.equal(reads, 3);
});

test("170k replay with a live producer uses bounded pages and one fixed contiguous boundary", async (t) => {
  let calls = 0;
  let live = 170_000;
  const sessions = {
    list: async () => [proj],
    events: async () => { throw new Error("unbounded replay must not be used"); },
    replayPage: async (id: string, cursor: number, highWater?: number) => {
      calls++;
      const boundary = highWater ?? live;
      assert.equal(boundary, 170_000);
      const end = Math.min(cursor + 500, boundary);
      const events = Array.from({ length: end - cursor }, (_, i) => mkEv(id, cursor + i + 1));
      if (calls % 40 === 0) broadcast.event(mkEv(id, ++live));
      return { events, cursor: end, highWater: boundary, complete: end === boundary };
    },
  } as unknown as SessionService;
  const server = createServer();
  const broadcast = attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  client.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, liveEventBatches: true }));
  let cursor = 0;
  for (;;) {
    const message = await client.next();
    if (message.type === "projections") break;
    assert.equal(message.type, "events");
    assert.ok(message.events!.length <= 500);
    for (const event of message.events!) assert.equal(event.seq, ++cursor);
  }
  assert.equal(cursor, 170_008);
  assert.equal(calls, 340);
});

test("a stored oversized event closes terminally instead of looping the same replay", async (t) => {
  let calls = 0;
  const sessions = { replayPage: async () => { calls++; throw Object.assign(new Error("oversized"), { code: "payload-too-large" }); } } as unknown as SessionService;
  const server = createServer();
  attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { ws } = await connect((server.address() as { port: number }).port);
  t.after(() => { ws.terminate(); server.close(); });
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
  assert.equal((await closed)[0], 1009);
  assert.equal(calls, 1);
});

test("live events during gap-fill are buffered and flushed seq-deduped, not dropped", async () => {
  const { sessions, nextGap } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    const c = await connect(port);
    open.push(c.ws);
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, liveEventBatches: true }));
    const gap = await nextGap();
    assert.equal(gap.sessionId, "s1");
    assert.equal(gap.afterSeq, 0);

    // while the DB read is in flight: one duplicate of a gap-fill event, two
    // events above the gap-fill boundary, and one for an unrelated session
    broadcast.event(mkEv("s1", 2));
    broadcast.event(mkEv("s1", 3));
    broadcast.event(mkEv("s1", 4));
    broadcast.event(mkEv("other", 9));
    gap.resolve([mkEv("s1", 1), mkEv("s1", 2)]);

    // Gap-fill (1,2) and the buffered live tail (3,4) are separate batched
    // frames; the duplicate seq 2 is delivered only once.
    const batch = await c.next();
    assert.equal(batch.type, "events");
    assert.deepEqual(batch.events!.map((e) => e.seq), [1, 2]);
    assert.ok(batch.events!.every((e) => e.sessionId === "s1"));
    const liveTail = await c.next();
    assert.equal(liveTail.type, "events");
    assert.deepEqual(liveTail.events!.map((e) => e.seq), [3, 4]);
    assert.ok(liveTail.events!.every((e) => e.sessionId === "s1"));
    // projections snapshot (batched frame) follows the flush
    const snap = await c.next();
    assert.equal(snap.type, "projections");
    assert.deepEqual(snap.sessions!.map((s) => s.id), ["s1"]);

    // live path resumes: seq 4 already flushed (deduped), seq 5 delivered
    broadcast.event(mkEv("s1", 4));
    broadcast.event(mkEv("s1", 5));
    const live = await c.next();
    assert.equal(live.type, "event");
    assert.equal(live.event!.seq, 5);
  } finally {
    for (const ws of open) ws.terminate();
    server.close();
  }
});

test("subscribe during in-flight gap-fill is processed after it (latest wins)", async () => {
  const { sessions, nextGap, seen } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    const c = await connect(port);
    open.push(c.ws);
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-a", afterSeq: 0 }));
    const gapA = await nextGap();
    assert.equal(gapA.sessionId, "s-a");

    // rapid session switching while s-a's gap-fill is awaited: s-b is
    // superseded by s-c; neither may be dropped into the void
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-b", afterSeq: 0 }));
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-c", afterSeq: 0, liveEventBatches: true }));
    await settle(c.ws); // both subscribes handled server-side before resolving
    gapA.resolve([mkEv("s-a", 1)]);

    // the latest pending subscribe (s-c) gets its own gap-fill
    const gapC = await nextGap();
    assert.equal(gapC.sessionId, "s-c");
    assert.equal(gapC.afterSeq, 0);
    // buffering also applies to the follow-up gap-fill
    broadcast.event(mkEv("s-c", 2));
    gapC.resolve([mkEv("s-c", 1)]);

    // client sees: a1 (batched), projections snapshot, c1 (batched), c2
    // (batched live tail). The second snapshot is SKIPPED: same scope ("*"),
    // and live projection broadcasts keep it current after the first snapshot.
    // Navigation cancels stale page publication; only the latest subscription
    // receives detail, with its buffered live tail preserved.
    const m2 = await c.next();
    assert.equal(m2.type, "events");
    assert.deepEqual(m2.events!.map((e) => ({ sid: e.sessionId, seq: e.seq })), [{ sid: "s-c", seq: 1 }]);
    const m3 = await c.next();
    assert.equal(m3.type, "events");
    assert.deepEqual(m3.events!.map((e) => ({ sid: e.sessionId, seq: e.seq })), [{ sid: "s-c", seq: 2 }]);

    assert.equal((await c.next()).type, "projections");

    // the sub now targets s-c: old-session live events filtered, s-c delivered
    broadcast.event(mkEv("s-a", 2));
    broadcast.event(mkEv("s-c", 3));
    const live = await c.next();
    assert.deepEqual({ sid: live.event!.sessionId, seq: live.event!.seq }, { sid: "s-c", seq: 3 });

    // exactly two gap-fills ran: s-a and s-c (s-b superseded, never read twice)
    assert.deepEqual(seen.map((s) => s.sessionId), ["s-a", "s-c"]);
  } finally {
    for (const ws of open) ws.terminate();
    server.close();
  }
});

test("stream chunks share one frame and a non-stream event flushes them as an ordering barrier", async () => {
  const { sessions, nextGap } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    const c = await connect(port);
    open.push(c.ws);
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, liveEventBatches: true }));
    (await nextGap()).resolve([]);
    assert.equal((await c.next()).type, "projections");

    broadcast.event({ ...mkEv("s1", 1), type: "assistant/chunk", data: { partId: "p", text: "a" } });
    broadcast.event({ ...mkEv("s1", 2), type: "assistant/reasoning-chunk", data: { partId: "r", text: "b" } });
    broadcast.event({ ...mkEv("s1", 3), type: "tool/call", data: { callId: "c", tool: "read", input: {} } });

    const streamed = await c.next();
    assert.equal(streamed.type, "events");
    assert.deepEqual(streamed.events!.map((e) => e.seq), [1, 2]);

    const barrier = await c.next();
    assert.equal(barrier.type, "event");
    assert.equal(barrier.event!.seq, 3);
  } finally {
    for (const ws of open) ws.terminate();
    broadcast.close();
    server.close();
  }
});

test("legacy subscribers keep receiving single live event frames", async () => {
  const { sessions, nextGap } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    const c = await connect(port);
    open.push(c.ws);
    // No liveEventBatches capability: this models a cached pre-upgrade PWA.
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
    (await nextGap()).resolve([]);
    assert.equal((await c.next()).type, "projections");

    broadcast.event({ ...mkEv("s1", 1), type: "assistant/chunk", data: { partId: "p", text: "a" } });
    broadcast.event({ ...mkEv("s1", 2), type: "assistant/chunk", data: { partId: "p", text: "b" } });

    const first = await c.next();
    const second = await c.next();
    assert.deepEqual(
      [
        { type: first.type, seq: first.event?.seq },
        { type: second.type, seq: second.event?.seq },
      ],
      [
        { type: "event", seq: 1 },
        { type: "event", seq: 2 },
      ],
    );
  } finally {
    for (const ws of open) ws.terminate();
    broadcast.close();
    server.close();
  }
});

test("bounded live replay buffer closes for explicit resync instead of dropping canonical events", async () => {
  const { sessions, nextGap } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  let ws: WebSocket | undefined;
  try {
    const c = await connect(port);
    ws = c.ws;
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, liveEventBatches: true }));
    await nextGap(); // Hold durable replay while live delivery races it.
    const closed = once(c.ws, "close");
    for (let seq = 1; seq <= 2_049; seq += 1) broadcast.event(mkEv("s1", seq));
    const [code, reason] = await closed as [number, Buffer];
    assert.equal(code, 1013);
    assert.match(String(reason), /^resync-required:/);
  } finally {
    ws?.terminate();
    broadcast.close();
    server.close();
  }
});

test("live replay byte cap also closes for resync", async () => {
  const { sessions, nextGap } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  let ws: WebSocket | undefined;
  try {
    const c = await connect(port);
    ws = c.ws;
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, liveEventBatches: true }));
    await nextGap();
    const closed = once(c.ws, "close");
    broadcast.event({ ...mkEv("s1", 1), data: { payload: "x".repeat(4 * 1024 * 1024) } });
    const [code, reason] = await closed as [number, Buffer];
    assert.equal(code, 1013);
    assert.match(String(reason), /^resync-required:/);
  } finally {
    ws?.terminate();
    broadcast.close();
    server.close();
  }
});

test("a browser that offers permessage-deflate gets compressed history frames", async (t) => {
  const sessions = {
    list: async () => [proj],
    replayPage: async (id: string, cursor: number) => {
      const events = Array.from({ length: 200 }, (_, i) => mkEv(id, cursor + i + 1));
      return { events, cursor: cursor + 200, highWater: 200, complete: true };
    },
  } as unknown as SessionService;
  const server = createServer();
  attachWs(server, sessions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await connect((server.address() as { port: number }).port);
  t.after(() => { client.ws.terminate(); server.close(); });
  assert.match(client.ws.extensions, /permessage-deflate/);
  client.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0, liveEventBatches: true }));
  const page = await client.next();
  assert.equal(page.type, "events");
  assert.equal(page.events!.length, 200);
});
