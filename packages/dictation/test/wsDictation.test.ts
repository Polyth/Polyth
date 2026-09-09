import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { SessionService } from "@polyth/contracts";
import {
  createChunkBuffer,
  createDictationService,
  encodeDictationAudioFrame,
  type SttAdapter,
  type SttStream,
} from "@polyth/dictation";
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

const sessionsDouble = {
  events: async () => [],
  list: async () => [],
} as unknown as SessionService;

interface WsMsg {
  type: string;
  seq?: number;
  duplicate?: boolean;
  buffered?: boolean;
  text?: string;
  revision?: number;
  code?: string;
  session?: { id: string };
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

const frame = (id: string, seq: number, text: string, sampleRate = 16_000) =>
  encodeDictationAudioFrame({
    dictationId: id,
    seq,
    sampleRate,
    channels: 1,
    payload: new Uint8Array(Buffer.from(text, "utf8")),
  });

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

test("binary dictation ws: ack, partial, reconnect replay dedupe", async () => {
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
    const c1 = await connect(port);
    open.push(c1.ws);
    c1.ws.send(JSON.stringify({ type: "dictation/start", dictationId: d.id }));
    const state = await c1.next();
    assert.equal(state.type, "dictation/state");
    assert.equal(state.session?.id, d.id);

    const p1 = new Uint8Array(Buffer.from("hi", "utf8"));
    const s1 = buf.push(p1);
    c1.ws.send(frame(d.id, s1, "hi"));
    const ack1 = await c1.next();
    assert.deepEqual({ type: ack1.type, seq: ack1.seq, duplicate: ack1.duplicate }, { type: "dictation/ack", seq: 1, duplicate: false });
    assert.equal((await c1.next()).text, "hi");
    buf.ack(ack1.seq!);

    const p2 = new Uint8Array(Buffer.from("to", "utf8"));
    const s2 = buf.push(p2);
    c1.ws.send(frame(d.id, s2, "to"));
    await c1.next();
    await c1.next();
    c1.ws.close();

    const c2 = await connect(port);
    open.push(c2.ws);
    assert.deepEqual(buf.unacked().map((c) => c.seq), [2]);
    for (const chunk of buf.unacked()) {
      c2.ws.send(encodeDictationAudioFrame({
        dictationId: d.id,
        seq: chunk.seq,
        sampleRate: 16_000,
        channels: 1,
        payload: chunk.pcm,
      }));
    }
    const replayAck = await c2.next();
    assert.equal(replayAck.type, "dictation/ack");
    assert.equal(replayAck.duplicate, true);
    buf.ack(replayAck.seq!);
    assert.equal((await c2.next()).text, "hi to");
    assert.equal(adapter.pushes, 2);

    const s3 = buf.push(new Uint8Array(Buffer.from("us", "utf8")));
    c2.ws.send(frame(d.id, s3, "us"));
    assert.equal((await c2.next()).seq, 3);
    assert.equal((await c2.next()).text, "hi to us");
    const final = await dictation.finalize(d.id);
    assert.equal(final.transcript, "hi to us");
    assert.equal(final.status, "done");
  } finally {
    for (const ws of open) ws.terminate();
    server.close();
  }
});

test("binary dictation validates format and keeps socket usable", async () => {
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
    const d = dictation.create({});
    c.ws.send(frame(d.id, 1, "xx", 8_000));
    const formatError = await c.next();
    assert.deepEqual(
      { type: formatError.type, code: formatError.code },
      { type: "dictation/error", code: "audio_format_error" },
    );

    c.ws.send(frame(d.id, 1, "ok"));
    assert.equal((await c.next()).seq, 1);
    assert.equal((await c.next()).text, "ok");
  } finally {
    for (const ws of open) ws.terminate();
    server.close();
  }
});

test("legacy JSON/base64 audio remains backward compatible", async () => {
  const dictation = createDictationService({ adapter: fakeAdapter() });
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachWs(server, sessionsDouble, undefined, dictation);
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let ws: WebSocket | null = null;
  try {
    const c = await connect(port);
    ws = c.ws;
    const d = dictation.create({});
    c.ws.send(JSON.stringify({ type: "dictation/audio", dictationId: d.id, seq: 1, pcm: b64("ok") }));
    assert.equal((await c.next()).seq, 1);
    assert.equal((await c.next()).text, "ok");
  } finally {
    ws?.terminate();
    server.close();
  }
});
