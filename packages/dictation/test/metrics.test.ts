import { test } from "node:test";
import assert from "node:assert/strict";
import { createDictationService, type SttAdapter } from "../src/streaming.ts";

const adapter: SttAdapter = {
  engine: "measured-provider",
  createStream: () => {
    let text = "";
    return {
      push(pcm) { text += `${pcm.byteLength} `; },
      partial: () => text.trim(),
      finalize: async () => text.trim(),
    };
  },
};

test("server metrics count accepted, duplicate and reordered frames without inferring external telemetry", async () => {
  let now = 1_000;
  const service = createDictationService({ adapter, now: () => now });
  const session = service.create({});
  assert.deepEqual(session.metrics, {
    provider: "measured-provider",
    audioBytes: 0,
    audioDurationMs: 0,
    acceptedFrames: 0,
    duplicateFrames: 0,
    reorderedFrames: 0,
    providerErrors: 0,
  });

  now += 10;
  await service.push(session.id, 1, new Uint8Array(640));
  now += 10;
  const buffered = await service.push(session.id, 3, new Uint8Array(640));
  assert.equal(buffered.buffered, true);
  now += 10;
  await service.push(session.id, 3, new Uint8Array(640));
  now += 10;
  await service.push(session.id, 2, new Uint8Array(640));

  const current = service.get(session.id)!;
  assert.equal(current.metrics.provider, "measured-provider");
  assert.equal(current.metrics.audioBytes, 1_920);
  assert.equal(current.metrics.audioDurationMs, 60);
  assert.equal(current.metrics.acceptedFrames, 3);
  assert.equal(current.metrics.duplicateFrames, 1);
  assert.equal(current.metrics.reorderedFrames, 1);
  assert.equal(current.metrics.providerErrors, 0);
  assert.equal(current.timing.connectMs, 10);
  assert.equal(current.timing.firstAudioMs, 10);
  assert.equal(current.timing.firstPartialMs, 10);

  now += 20;
  const done = await service.finalize(session.id);
  assert.equal(done.timing.finalMs, 60);
});

test("provider errors are measured without changing their error code", async () => {
  const failing: SttAdapter = {
    engine: "failing-provider",
    createStream: () => ({
      push() { throw Object.assign(new Error("offline"), { code: "network_error" }); },
      finalize: async () => "",
    }),
  };
  const service = createDictationService({ adapter: failing });
  const session = service.create({});
  await assert.rejects(
    () => service.push(session.id, 1, new Uint8Array(2)),
    (error: unknown) => (error as { code?: string }).code === "network_error",
  );
  assert.equal(service.get(session.id)?.metrics.providerErrors, 1);
});
