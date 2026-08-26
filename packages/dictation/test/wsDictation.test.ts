// WP15 WS dictation protocol: audio chunks over /ws are acked, transcripts
// stream back, replays after reconnect deduplicate, and nothing dictation-
// related ever reaches the session event log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { SessionService } from "@polyth/contracts";
import { createChunkBuffer, createDictationService, type SttAdapter, type SttStream } from "@polyth/dictation";
import { attachWs } from "../../server/src/ws.ts";

function fakeAdapter(): SttAdapter & { pushes: number } {
  const a = {
    engine: "fake",
    pushes: 0,
    createStream(): SttStream {
      const words: string[] = [];
      return {
        push: (pcm: Uint8Array) => { a.pushes++; words.push(Buffer.from(pcm).toString("utf8")); },
        partial: () => words.join(" "),
        finalize: async () => words.join(" "),
      };
    },
  };
  return a;
}

/** Session service double: the gateway only needs events() and list(). */
const sessionsDouble = {
  events: async () => [],
  list: async () => [],
} as unknown as SessionService;

interface WsMsg { type: string; seq?: number; duplicate?: boolean; text?: string; revision?: number; code?: string; session?: { id: string } }

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

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

test("dictation over ws: ack, transcript, reconnect replay dedupe", async () => {
  const adapter = fakeAdapter();
  const dictation = createDictationService({ adapter });
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, sessionsDouble, undefined, dictation);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    const d = dictation.create({ sessionId: "chat-1" });
    const buf = createChunkBuffer();

    // -- first connection: start + two chunks ------------------------------
    const c1 = await connect(port);
    open.push(c1.ws);
    c1.ws.send(JSON.stringify({ type: "dictation/start", dictationId: d.id }));
    const state = await c1.next();
    assert.equal(state.type, "dictation/state");
    assert.equal(state.session?.id, d.id);

    const s1 = buf.push(new Uint8Array(Buffer.from("hello")));
    c1.ws.send(JSON.stringify({ type: "dictation/audio", dictationId: d.id, seq: s1, pcm: b64("hello") }));
    const ack1 = await c1.next();
    assert.deepEqual({ type: ack1.type, seq: ack1.seq, duplicate: ack1.duplicate }, { type: "dictation/ack", seq: 1, duplicate: false });
    const t1 = await c1.next();
    assert.equal(t1.type, "dictation/transcript");
    assert.equal(t1.text, "hello");
    buf.ack(ack1.seq!);

    const s2 = buf.push(new Uint8Array(Buffer.from("world")));
    c1.ws.send(JSON.stringify({ type: "dictation/audio", dictationId: d.id, seq: s2, pcm: b64("world") }));
    await c1.next(); // ack 2 — deliberately NOT applied to the buffer: the
    await c1.next(); // transcript; simulates an ack lost in transit
    c1.ws.close();

    // -- reconnect: replay everything unacked (seq 2) -----------------------
    const c2 = await connect(port);
    open.push(c2.ws);
    assert.deepEqual(buf.unacked().map((c) => c.seq), [2]);
    for (const chunk of buf.unacked()) {
      c2.ws.send(JSON.stringify({
        type: "dictation/audio", dictationId: d.id, seq: chunk.seq,
        pcm: Buffer.from(chunk.pcm).toString("base64"),
      }));
    }
    const ackReplay = await c2.next();
    assert.equal(ackReplay.type, "dictation/ack");
    assert.equal(ackReplay.duplicate, true); // server had already transcribed seq 2
    buf.ack(ackReplay.seq!);
    assert.deepEqual(buf.unacked(), []);
    // duplicates also re-send the current transcript so the client resyncs
    const resync = await c2.next();
    assert.equal(resync.type, "dictation/transcript");
    assert.equal(resync.text, "hello world");

    // adapter saw each chunk exactly once despite the replay
    assert.equal(adapter.pushes, 2);

    // -- new audio continues on the new socket ------------------------------
    const s3 = buf.push(new Uint8Array(Buffer.from("again")));
    c2.ws.send(JSON.stringify({ type: "dictation/audio", dictationId: d.id, seq: s3, pcm: b64("again") }));
    const ack3 = await c2.next();
    assert.equal(ack3.seq, 3);
    const t3 = await c2.next();
    assert.equal(t3.text, "hello world again");

    const finalDto = await dictation.finalize(d.id);
    assert.equal(finalDto.transcript, "hello world again");
    assert.equal(finalDto.status, "done");
  } finally {
    for (const ws of open) ws.terminate();
    server.close();
  }
});

test("dictation errors surface as dictation/error, not disconnects", async () => {
  const dictation = createDictationService({ adapter: fakeAdapter() });
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, sessionsDouble, undefined, dictation);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const open: WebSocket[] = [];
  try {
    const c = await connect(port);
    open.push(c.ws);
    c.ws.send(JSON.stringify({ type: "dictation/start", dictationId: "nope" }));
    const e1 = await c.next();
    assert.deepEqual({ type: e1.type, code: e1.code }, { type: "dictation/error", code: "not-found" });

    const d = dictation.create({});
    // out-of-order chunk: error, but the socket stays usable
    c.ws.send(JSON.stringify({ type: "dictation/audio", dictationId: d.id, seq: 7, pcm: b64("x") }));
    const e2 = await c.next();
    assert.equal(e2.type, "dictation/error");
    assert.equal(e2.code, "out-of-order");
    c.ws.send(JSON.stringify({ type: "dictation/audio", dictationId: d.id, seq: 1, pcm: b64("ok") }));
    const ack = await c.next();
    assert.equal(ack.type, "dictation/ack");
    assert.equal(ack.seq, 1);
  } finally {
    for (const ws of open) ws.terminate();
    server.close();
  }
});
