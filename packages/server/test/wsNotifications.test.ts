// NTF-01 WS contract: notification/added fans out to EVERY connected socket
// without the active-session filter, is delivered immediately even while a
// session gap-fill is in flight (never buffered into liveBuffer, never
// counted against afterSeq), and leaves existing event filtering untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { NotificationRecord, SessionEvent, SessionProjection, SessionService } from "@polyth/contracts";
import { attachWs } from "../src/ws.ts";

const mkEv = (sessionId: string, seq: number): SessionEvent => ({
  id: `${sessionId}-${seq}`, sessionId, seq, time: seq, type: "test/event", data: {}, v: 1,
});

const mkRecord = (id: string, sessionId: string): NotificationRecord => ({
  id, key: `${sessionId}:turn:idle`, kind: "completed",
  sessionId, projectId: "p1", title: "Polyth — T", body: "T — finished",
  ts: 100, read: false,
});

const proj: SessionProjection = {
  id: "s1", projectId: "p1", title: "T", status: "idle",
  createdAt: 1, updatedAt: 1,
} as SessionProjection;

interface GapCall { resolve: (evs: SessionEvent[]) => void }

function controllableSessions() {
  const pending: GapCall[] = [];
  const waiters: Array<(c: GapCall) => void> = [];
  const sessions = {
    events: (_sessionId: string, _afterSeq: number) =>
      new Promise<SessionEvent[]>((resolve) => {
        const call: GapCall = { resolve };
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
  return { sessions, nextGap };
}

interface WsMsg {
  type: string;
  event?: SessionEvent;
  session?: { id: string };
  notification?: NotificationRecord;
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

test("notification/added reaches every socket, bypassing the active-session filter", async () => {
  const { sessions, nextGap } = controllableSessions();
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const broadcast = attachWs(server, sessions);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    // Client A subscribes to session s1 and finishes its gap-fill; client B
    // has no session subscription at all.
    const a = await connect(port);
    const b = await connect(port);
    open.push(a.ws, b.ws);
    a.ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1", afterSeq: 0 }));
    (await nextGap()).resolve([]);
    assert.equal((await a.next()).type, "projection"); // post-gap-fill snapshot

    // A notification for a THIRD session must reach both sockets unfiltered.
    const record = mkRecord("n1", "s3");
    broadcast.notification!(record);
    const gotA = await a.next();
    const gotB = await b.next();
    assert.equal(gotA.type, "notification/added");
    assert.deepEqual(gotA.notification, record);
    assert.equal(gotB.type, "notification/added");
    assert.deepEqual(gotB.notification, record);

    // Session-event filtering is unchanged: an s2 event never reaches A…
    broadcast.event(mkEv("s2", 1));
    // …while an s1 event still does, with its seq accounting intact.
    broadcast.event(mkEv("s1", 1));
    const ev = await a.next();
    assert.equal(ev.type, "event");
    assert.equal(ev.event!.sessionId, "s1");
  } finally {
    for (const ws of open) ws.close();
    server.close();
  }
});

test("notification/added is delivered immediately during a pending gap-fill, never buffered", async () => {
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
    const gap = await nextGap(); // DB read is now in flight

    // Notification during gap-fill: delivered ahead of the gap-fill events —
    // it is not part of liveBuffer and owes nothing to seq accounting.
    const record = mkRecord("n2", "s1");
    broadcast.notification!(record);
    broadcast.event(mkEv("s1", 2)); // buffered live event (above the boundary)
    gap.resolve([mkEv("s1", 1)]);

    const first = await c.next();
    assert.equal(first.type, "notification/added");
    assert.deepEqual(first.notification, record);

    // Then the normal order: gap-fill event, flushed live event, projections.
    const e1 = await c.next();
    assert.equal(e1.type, "event");
    assert.equal(e1.event!.seq, 1);
    const e2 = await c.next();
    assert.equal(e2.type, "event");
    assert.equal(e2.event!.seq, 2);
    assert.equal((await c.next()).type, "projection");
  } finally {
    for (const ws of open) ws.close();
    server.close();
  }
});
