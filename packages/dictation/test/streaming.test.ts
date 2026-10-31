import { test } from "node:test";
import assert from "node:assert";
import {
  createChunkBuffer, createDictationService,
  type SttAdapter, type SttStream,
} from "@polyth/dictation";

/** Test-only PCM fixture: each ASCII byte becomes the low byte of one s16le
 * sample so the service still receives structurally valid PCM16. */
const chunk = (s: string): Uint8Array => {
  const text = Buffer.from(s, "utf8");
  const pcm = new Uint8Array(text.byteLength * 2);
  for (let i = 0; i < text.byteLength; i++) pcm[i * 2] = text[i]!;
  return pcm;
};
const decodeChunk = (pcm: Uint8Array): string => {
  const bytes = Buffer.allocUnsafe(pcm.byteLength / 2);
  for (let i = 0; i < bytes.byteLength; i++) bytes[i] = pcm[i * 2]!;
  return bytes.toString("utf8");
};

function fakeAdapter(): SttAdapter & { pushed: Uint8Array[] } {
  const pushed: Uint8Array[] = [];
  return {
    engine: "fake",
    pushed,
    createStream(): SttStream {
      const words: string[] = [];
      return {
        push(pcm) {
          pushed.push(pcm);
          words.push(decodeChunk(pcm));
        },
        partial: () => words.join(" "),
        finalize: async () => words.join(" ").trim(),
      };
    },
  };
}

test("no adapter: capability is honest, create refuses", () => {
  const svc = createDictationService({ adapter: null, unavailableReason: "no engine" });
  assert.deepEqual(svc.capability(), { available: false, reason: "no engine" });
  assert.throws(() => svc.create({}), /no engine/);
});

test("in-order chunks ack and produce transcript revisions", async () => {
  const svc = createDictationService({ adapter: fakeAdapter() });
  const d = svc.create({ sessionId: "chat-1" });
  assert.equal(d.status, "recording");
  const r1 = await svc.push(d.id, 1, chunk("hello"));
  assert.deepEqual({ ack: r1.ack, duplicate: r1.duplicate }, { ack: 1, duplicate: false });
  assert.equal(r1.transcript?.text, "hello");
  const r2 = await svc.push(d.id, 2, chunk("world"));
  assert.equal(r2.transcript?.text, "hello world");
  assert.ok(r2.transcript!.revision > r1.transcript!.revision);
});

test("duplicate chunks re-ack without re-transcribing", async () => {
  const adapter = fakeAdapter();
  const svc = createDictationService({ adapter });
  const d = svc.create({});
  await svc.push(d.id, 1, chunk("alpha"));
  await svc.push(d.id, 2, chunk("beta"));
  const dup1 = await svc.push(d.id, 1, chunk("alpha"));
  const dup2 = await svc.push(d.id, 2, chunk("beta"));
  assert.equal(dup1.duplicate, true);
  assert.equal(dup2.duplicate, true);
  assert.equal(dup1.ack, 2);
  assert.equal(adapter.pushed.length, 2);
  const r3 = await svc.push(d.id, 3, chunk("gamma"));
  assert.equal(r3.transcript?.text, "alpha beta gamma");
});

test("out-of-order chunks are buffered and drained in order", async () => {
  const adapter = fakeAdapter();
  const svc = createDictationService({ adapter });
  const d = svc.create({});
  await svc.push(d.id, 1, chunk("a"));
  const third = await svc.push(d.id, 3, chunk("c"));
  assert.equal(third.ack, 1);
  assert.equal(third.buffered, true);
  assert.equal(adapter.pushed.length, 1);
  const second = await svc.push(d.id, 2, chunk("b"));
  assert.equal(second.ack, 3);
  assert.equal(second.transcript?.text, "a b c");
  assert.equal(adapter.pushed.length, 3);
});

test("duplicate out-of-order chunk is suppressed before drain", async () => {
  const adapter = fakeAdapter();
  const svc = createDictationService({ adapter });
  const d = svc.create({});
  await svc.push(d.id, 2, chunk("b"));
  const duplicate = await svc.push(d.id, 2, chunk("b"));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ack, 0);
  await svc.push(d.id, 1, chunk("a"));
  assert.equal(adapter.pushed.length, 2);
});

test("seq gap beyond the cap fails the dictation", async () => {
  const svc = createDictationService({ adapter: fakeAdapter(), maxSeqGap: 5 });
  const d = svc.create({});
  await svc.push(d.id, 1, chunk("a"));
  await assert.rejects(() => svc.push(d.id, 50, chunk("z")), /audio gap/);
  assert.equal(svc.get(d.id)!.status, "failed");
});

test("bounded reorder buffer fails rather than silently dropping audio", async () => {
  const svc = createDictationService({ adapter: fakeAdapter(), maxBufferedChunks: 1 });
  const d = svc.create({});
  await svc.push(d.id, 2, chunk("b"));
  await assert.rejects(() => svc.push(d.id, 3, chunk("c")), /reorder buffer overflowed/);
  assert.equal(svc.get(d.id)!.status, "failed");
});

test("byte cap fails the dictation", async () => {
  const svc = createDictationService({ adapter: fakeAdapter(), maxBytes: 10 });
  const d = svc.create({});
  await assert.rejects(() => svc.push(d.id, 1, new Uint8Array(12)), /audio cap/);
  assert.equal(svc.get(d.id)!.status, "failed");
});

test("odd byte chunks fail explicit pcm16 validation", async () => {
  const svc = createDictationService({ adapter: fakeAdapter() });
  const d = svc.create({});
  await assert.rejects(() => svc.push(d.id, 1, new Uint8Array(3)), /whole 16-bit samples/);
});

test("finalize refuses missing buffered audio", async () => {
  const svc = createDictationService({ adapter: fakeAdapter() });
  const d = svc.create({});
  await svc.push(d.id, 2, chunk("b"));
  await assert.rejects(() => svc.finalize(d.id), /missing audio/);
  assert.equal(svc.get(d.id)!.status, "recording");
});

test("finalize happens exactly once; repeat calls return the same result", async () => {
  let finalizeCalls = 0;
  const adapter: SttAdapter = {
    engine: "fake",
    createStream: () => ({
      push() { /* consume */ },
      finalize: async () => { finalizeCalls++; return "final text"; },
    }),
  };
  const svc = createDictationService({ adapter });
  const d = svc.create({});
  await svc.push(d.id, 1, chunk("xx"));
  const [a, b] = await Promise.all([svc.finalize(d.id), svc.finalize(d.id)]);
  const c = await svc.finalize(d.id);
  assert.equal(finalizeCalls, 1);
  assert.equal(a.transcript, "final text");
  assert.equal(b.status, "done");
  assert.equal(c.transcript, "final text");
  assert.ok(typeof c.timing.finalMs === "number");
  await assert.rejects(() => svc.push(d.id, 2, chunk("yy")), /dictation is/);
});

test("cancel removes the session", () => {
  const svc = createDictationService({ adapter: fakeAdapter() });
  const d = svc.create({});
  svc.cancel(d.id);
  assert.equal(svc.get(d.id), null);
});

// ---------------------------------------------------------------- chunk buffer

test("chunk buffer assigns sequential seqs and replays unacked in order", () => {
  const buf = createChunkBuffer();
  assert.equal(buf.push(chunk("aa")), 1);
  assert.equal(buf.push(chunk("bb")), 2);
  assert.equal(buf.push(chunk("cc")), 3);
  buf.ack(1);
  const replay = buf.unacked();
  assert.deepEqual(replay.map((c) => c.seq), [2, 3]);
  assert.equal(decodeChunk(replay[0]!.pcm), "bb");
});

test("chunk buffer ack is idempotent and tolerates high acks", () => {
  const buf = createChunkBuffer();
  buf.push(chunk("aa"));
  buf.push(chunk("bb"));
  buf.ack(5);
  buf.ack(5);
  assert.deepEqual(buf.unacked(), []);
  assert.equal(buf.bytes(), 0);
});

test("chunk buffer bounds retention and counts dropped audio", () => {
  const buf = createChunkBuffer({ maxBytes: 8 });
  buf.push(new Uint8Array(4));
  buf.push(new Uint8Array(4));
  buf.push(new Uint8Array(4));
  assert.equal(buf.dropped(), 1);
  assert.deepEqual(buf.unacked().map((c) => c.seq), [2, 3]);
  assert.ok(buf.bytes() <= 8);
});
