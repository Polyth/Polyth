import { test } from "node:test";
import assert from "node:assert";
import {
  DictationWireError,
  decodeDictationAudioFrame,
  encodeDictationAudioFrame,
  isDictationAudioFrame,
} from "@polyth/dictation";

test("binary dictation frame round-trips metadata and PCM without base64", () => {
  const pcm = new Uint8Array([1, 0, 2, 0, 255, 127]);
  const encoded = encodeDictationAudioFrame({
    dictationId: "dictation-α",
    seq: 42,
    sampleRate: 16_000,
    channels: 1,
    flags: 3,
    payload: pcm,
  });
  assert.equal(isDictationAudioFrame(encoded), true);
  const frame = decodeDictationAudioFrame(encoded);
  assert.equal(frame.version, 1);
  assert.equal(frame.dictationId, "dictation-α");
  assert.equal(frame.seq, 42);
  assert.equal(frame.sampleRate, 16_000);
  assert.equal(frame.channels, 1);
  assert.equal(frame.flags, 3);
  assert.deepEqual([...frame.payload], [...pcm]);
});

test("wire decoder rejects unsupported version", () => {
  const encoded = encodeDictationAudioFrame({
    dictationId: "d",
    seq: 1,
    sampleRate: 16_000,
    channels: 1,
    payload: new Uint8Array([0, 0]),
  });
  encoded[2] = 99;
  assert.throws(
    () => decodeDictationAudioFrame(encoded),
    (error) => error instanceof DictationWireError && error.code === "protocol_error",
  );
});

test("wire codec rejects malformed PCM16 payloads", () => {
  assert.throws(
    () => encodeDictationAudioFrame({
      dictationId: "d",
      seq: 1,
      sampleRate: 16_000,
      channels: 1,
      payload: new Uint8Array([1]),
    }),
    (error) => error instanceof DictationWireError && error.code === "audio_format_error",
  );
});
