import { test } from "node:test";
import assert from "node:assert/strict";
import { createDictationService, type SttAdapter } from "@polyth/dictation";

const pcm = new Uint8Array([1, 0]);

function adapter(onCancel?: () => void): SttAdapter {
  return {
    engine: "fake",
    createStream: () => ({
      push() {},
      partial: () => "partial",
      finalize: async () => "final",
      cancel: () => onCancel?.(),
    }),
  };
}

test("completed results do not consume the live-session concurrency budget", async () => {
  const svc = createDictationService({ adapter: adapter(), maxSessions: 1 });
  const first = svc.create({});
  await svc.push(first.id, 1, pcm);
  await svc.finalize(first.id);

  const second = svc.create({});
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, "recording");
  assert.equal(svc.get(first.id)?.status, "done");
});

test("idle recording expires with session_expired and cancels its provider stream", async () => {
  let at = 1_000;
  let cancelled = 0;
  const svc = createDictationService({
    adapter: adapter(() => { cancelled++; }),
    idleTimeoutMs: 100,
    now: () => at,
  });
  const d = svc.create({});
  at += 101;
  await assert.rejects(
    () => svc.push(d.id, 1, pcm),
    (error: unknown) => (error as { code?: string }).code === "session_expired",
  );
  assert.equal(cancelled, 1);
  assert.equal(svc.get(d.id), null);
});

test("terminal result metadata expires after retention without background timers", async () => {
  let at = 10_000;
  const svc = createDictationService({
    adapter: adapter(),
    resultRetentionMs: 50,
    now: () => at,
  });
  const d = svc.create({});
  await svc.push(d.id, 1, pcm);
  const final = await svc.finalize(d.id);
  assert.equal(final.status, "done");
  assert.equal(svc.get(d.id)?.transcript, "final");
  at += 51;
  assert.equal(svc.get(d.id), null);
});

test("firstAudioMs and firstPartialMs are measured from the service clock", async () => {
  let at = 1_000;
  const svc = createDictationService({ adapter: adapter(), now: () => at });
  const d = svc.create({});
  at = 1_125;
  await svc.push(d.id, 1, pcm);
  const snapshot = svc.get(d.id)!;
  assert.equal(snapshot.timing.firstAudioMs, 125);
  assert.equal(snapshot.timing.firstPartialMs, 125);
  at = 1_400;
  const final = await svc.finalize(d.id);
  assert.equal(final.timing.finalMs, 400);
});
