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
import { attachWs } from "../src/ws.ts";

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
  event?: SessionEvent;
  events?: SessionEvent[];
  session?: { id: string };
  sessions?: Array<{ id: string }>;
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
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
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

    // gap-fill (1,2) arrives as ONE batched frame, then the flushed live
    // buffer (3,4) as single-event frames; dup seq 2 sent only once
    const batch = await c.next();
    assert.equal(batch.type, "events");
    assert.deepEqual(batch.events!.map((e) => e.seq), [1, 2]);
    assert.ok(batch.events!.every((e) => e.sessionId === "s1"));
    const seqs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const m = await c.next();
      assert.equal(m.type, "event");
      assert.equal(m.event!.sessionId, "s1");
      seqs.push(m.event!.seq);
    }
    assert.deepEqual(seqs, [3, 4]);
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
    c.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s-c", afterSeq: 0 }));
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
    // (flushed). The second snapshot is SKIPPED: same scope ("*"), and live
    // projection broadcasts keep it current after the first snapshot.
    const m1 = await c.next();
    assert.equal(m1.type, "events");
    assert.deepEqual(m1.events!.map((e) => ({ sid: e.sessionId, seq: e.seq })), [{ sid: "s-a", seq: 1 }]);
    assert.equal((await c.next()).type, "projections");
    const m2 = await c.next();
    assert.equal(m2.type, "events");
    assert.deepEqual(m2.events!.map((e) => ({ sid: e.sessionId, seq: e.seq })), [{ sid: "s-c", seq: 1 }]);
    const m3 = await c.next();
    assert.deepEqual({ type: m3.type, sid: m3.event!.sessionId, seq: m3.event!.seq }, { type: "event", sid: "s-c", seq: 2 });

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
