import { test } from "node:test";
import assert from "node:assert";
import {
  createChunkBuffer, createDictationService,
  type SttAdapter, type SttStream,
} from "@polyth/dictation";

/** Fake STT: decodes each PCM chunk as UTF-8 words; finalize joins them. */
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
          words.push(Buffer.from(pcm).toString("utf8"));
        },
        partial: () => words.join(" "),
        finalize: async () => words.join(" ").trim(),
      };
    },
  };
}

const chunk = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

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
  // client replays 1..2 after a reconnect
  const dup1 = await svc.push(d.id, 1, chunk("alpha"));
  const dup2 = await svc.push(d.id, 2, chunk("beta"));
  assert.equal(dup1.duplicate, true);
  assert.equal(dup2.duplicate, true);
  assert.equal(dup1.ack, 2); // ack reports the high-water mark
  assert.equal(adapter.pushed.length, 2); // adapter saw each chunk exactly once
  const r3 = await svc.push(d.id, 3, chunk("gamma"));
  assert.equal(r3.transcript?.text, "alpha beta gamma");
});

test("small out-of-order jump rejects the chunk but keeps recording", async () => {
  const svc = createDictationService({ adapter: fakeAdapter() });
  const d = svc.create({});
  await svc.push(d.id, 1, chunk("a"));
  await assert.rejects(() => svc.push(d.id, 3, chunk("c")), /expected seq 2/);
  assert.equal(svc.get(d.id)!.status, "recording");
  await svc.push(d.id, 2, chunk("b")); // recovery works
});

test("seq gap beyond the cap fails the dictation", async () => {
  const svc = createDictationService({ adapter: fakeAdapter(), maxSeqGap: 5 });
  const d = svc.create({});
  await svc.push(d.id, 1, chunk("a"));
  await assert.rejects(() => svc.push(d.id, 50, chunk("z")), /audio gap/);
  assert.equal(svc.get(d.id)!.status, "failed");
});

test("byte cap fails the dictation", async () => {
  const svc = createDictationService({ adapter: fakeAdapter(), maxBytes: 10 });
  const d = svc.create({});
  await assert.rejects(() => svc.push(d.id, 1, new Uint8Array(11)), /audio cap/);
  assert.equal(svc.get(d.id)!.status, "failed");
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
  await svc.push(d.id, 1, chunk("x"));
  const [a, b] = await Promise.all([svc.finalize(d.id), svc.finalize(d.id)]);
  const c = await svc.finalize(d.id);
  assert.equal(finalizeCalls, 1);
  assert.equal(a.transcript, "final text");
  assert.equal(b.status, "done");
  assert.equal(c.transcript, "final text");
  // pushing after finalize is rejected
  await assert.rejects(() => svc.push(d.id, 2, chunk("y")), /dictation is/);
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
  assert.equal(buf.push(chunk("a")), 1);
  assert.equal(buf.push(chunk("b")), 2);
  assert.equal(buf.push(chunk("c")), 3);
  buf.ack(1);
  const replay = buf.unacked();
  assert.deepEqual(replay.map((c) => c.seq), [2, 3]);
  assert.equal(Buffer.from(replay[0]!.pcm).toString(), "b");
});

test("chunk buffer ack is idempotent and tolerates high acks", () => {
  const buf = createChunkBuffer();
  buf.push(chunk("a"));
  buf.push(chunk("b"));
  buf.ack(5);
  buf.ack(5);
  assert.deepEqual(buf.unacked(), []);
  assert.equal(buf.bytes(), 0);
});

test("chunk buffer bounds retention and counts dropped audio", () => {
  const buf = createChunkBuffer({ maxBytes: 8 });
  buf.push(new Uint8Array(4));
  buf.push(new Uint8Array(4));
  buf.push(new Uint8Array(4)); // evicts the first
  assert.equal(buf.dropped(), 1);
  assert.deepEqual(buf.unacked().map((c) => c.seq), [2, 3]);
  assert.ok(buf.bytes() <= 8);
});
