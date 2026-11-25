// The conversation-long microphone capture: recognizers attach to one open
// stream, one that starts late is first given what was said meanwhile, the
// barge-in watcher reads the same stream, and a lost microphone is reported to
// whoever is attached.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pcm16CaptureOptions } from "@polyth/dictation/voice-runtime";
import { PREROLL_KEEP_MS, startSharedCapture } from "../widgets/sharedCapture.ts";

/** One 40 ms chunk of 16 kHz PCM16 whose samples all hold `value`. */
const chunk = (value: number, samples = 640): Uint8Array => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index++) view.setInt16(index * 2, value, true);
  return bytes;
};
const first = (pcm: Uint8Array) => new DataView(pcm.buffer, pcm.byteOffset).getInt16(0, true);

async function setup() {
  let mic: Pcm16CaptureOptions | null = null;
  const opened: Pcm16CaptureOptions[] = [];
  let stops = 0;
  let clock = 0;
  const deferred: Array<() => void> = [];
  const shared = await startSharedCapture({
    start: async (options) => {
      opened.push(options);
      if (opened.length === 1) mic = options;
      return { sampleRate: options.targetSampleRate ?? 16_000, channels: 1, pause: async () => {}, resume: async () => {}, stop: () => { stops++; } };
    },
    now: () => clock,
    defer: (run) => { deferred.push(run); },
  });
  return {
    shared, opened,
    stops: () => stops,
    /** The microphone produces 40 ms of audio. */
    hear: (value: number) => {
      clock += 40;
      mic!.onChunk(chunk(value));
    },
    mic: () => mic!,
    /** The recognizer got its capture handle: replayed audio may flow. */
    attach: () => { for (const run of deferred.splice(0)) run(); },
  };
}

function recognizer(options: Partial<Pcm16CaptureOptions> = {}) {
  const heard: number[] = [];
  const sizes: number[] = [];
  const levels: number[] = [];
  const events: string[] = [];
  const capture: Pcm16CaptureOptions = {
    targetSampleRate: 16_000,
    chunkMs: 40,
    onChunk: (pcm) => { heard.push(first(pcm)); sizes.push(pcm.byteLength); },
    onLevel: (rms) => { levels.push(rms); },
    onEnded: () => { events.push("ended"); },
    onStalled: () => { events.push("stalled"); },
    ...options,
  };
  return { capture, heard, sizes, levels, events };
}

test("one microphone serves every turn: a recognizer hears live audio from the moment it is asked for", async () => {
  const h = await setup();
  assert.equal(h.opened.length, 1);
  assert.deepEqual([h.opened[0]!.targetSampleRate, h.opened[0]!.chunkMs], [16_000, 40]);
  h.hear(1);
  h.hear(2);

  const turn = recognizer();
  const factory = h.shared.factory();
  h.hear(3); // said while the recognizer is still connecting
  const handle = await factory(turn.capture);
  assert.equal(h.opened.length, 1, "no second microphone");
  h.hear(4);
  assert.deepEqual(turn.heard, [], "nothing arrives before the recognizer holds its capture");
  h.attach();
  assert.deepEqual(turn.heard, [3, 4], "…then everything since it was asked for, in order — not what came before");
  h.hear(5);
  assert.deepEqual(turn.heard, [3, 4, 5]);
  assert.equal(turn.levels.length, 1, "replayed audio is not a loudness reading; live audio is");

  handle.stop();
  h.hear(6);
  assert.deepEqual(turn.heard, [3, 4, 5], "a finished turn hears nothing more");
  assert.equal(h.stops(), 0, "…and the microphone stays open for the next one");
});

test("after a barge-in the recognizer is first given the moment before", async () => {
  const h = await setup();
  for (let value = 1; value <= 30; value++) h.hear(value);
  const turn = recognizer();
  const factory = h.shared.factory(200);
  h.hear(31);
  await factory(turn.capture);
  h.attach();
  assert.deepEqual(turn.heard, [26, 27, 28, 29, 30, 31], "200 ms of pre-roll, then what followed");

  const long = await setup();
  const kept = PREROLL_KEEP_MS / 40;
  for (let value = 1; value <= kept + 20; value++) long.hear(value);
  const late = recognizer();
  await long.shared.factory(60_000)(late.capture);
  long.attach();
  assert.equal(late.heard.length, kept, "the ring is bounded: older audio is gone");
  assert.equal(late.heard[0], 21);
});

test("a recognizer gets the chunk size it asked for, and another sample rate gets its own microphone", async () => {
  const h = await setup();
  const wide = recognizer({ chunkMs: 100 });
  await h.shared.factory()(wide.capture);
  h.attach();
  for (let value = 1; value <= 5; value++) h.hear(value);
  assert.deepEqual(wide.sizes, [3_200, 3_200], "5 × 40 ms arrive as 2 × 100 ms");
  assert.deepEqual(wide.heard, [1, 3], "the second chunk starts mid-way through the third capture chunk");

  const other = recognizer({ targetSampleRate: 24_000 });
  await h.shared.factory()(other.capture);
  assert.equal(h.opened.length, 2, "a format the shared capture does not produce is captured separately");
  assert.equal(h.opened[1]!.targetSampleRate, 24_000);
});

test("pausing one recognizer does not stop the microphone, and the watcher reads the same stream", async () => {
  const h = await setup();
  const turn = recognizer();
  const handle = await h.shared.factory()(turn.capture);
  h.attach();
  h.hear(1);
  await handle.pause();
  h.hear(2);
  await handle.resume();
  h.hear(3);
  assert.deepEqual(turn.heard, [1, 3]);

  const speech: string[] = [];
  const watcher = h.shared.watch({ onSpeech: () => speech.push("speech") });
  for (let index = 0; index < 12; index++) h.hear(30);       // the room, with the reply's echo in it
  assert.deepEqual(speech, [], "quiet (and its echo) is not the user");
  for (let index = 0; index < 12; index++) h.hear(9_000);    // the user talks over the reply
  assert.deepEqual(speech, ["speech"], "a clear, sustained voice is");
  watcher.stop();
  for (let index = 0; index < 30; index++) h.hear(30);
  for (let index = 0; index < 12; index++) h.hear(9_000);
  assert.deepEqual(speech, ["speech"], "a stopped watcher reports nothing");
  assert.equal(h.opened.length, 1, "noticing a barge-in opens no second microphone");
});

test("the room's loudness comes from the quiet moments, even while someone is talking", async () => {
  const h = await setup();
  assert.equal(h.shared.noiseFloor(), undefined, "not before enough was heard");
  for (let index = 0; index < 40; index++) h.hear(index % 4 === 0 ? 60 : 8_000); // speech with gaps
  const floor = h.shared.noiseFloor()!;
  assert.ok(floor > 0.001 && floor < 0.003, `the gaps (${60 / 32_768}), not the voice: ${floor}`);
});

test("a lost microphone is reported to the attached recognizer, and stop closes it once", async () => {
  const h = await setup();
  const turn = recognizer();
  await h.shared.factory()(turn.capture);
  h.attach();
  assert.equal(h.shared.dead, false);
  h.mic().onEnded?.();
  assert.deepEqual(turn.events, ["ended"]);
  assert.equal(h.shared.dead, true, "the controller opens a new capture for the next turn");
  assert.equal(h.stops(), 1);
  h.hear(1);
  assert.deepEqual(turn.heard, []);
  const after = recognizer();
  await h.shared.factory()(after.capture);
  assert.equal(h.opened.length, 2, "a dead capture hands out real ones rather than silence");

  const stalled = await setup();
  const waiting = recognizer();
  await stalled.shared.factory()(waiting.capture);
  stalled.mic().onStalled?.();
  assert.deepEqual(waiting.events, ["stalled"]);

  const closed = await setup();
  closed.shared.stop();
  closed.shared.stop();
  assert.equal(closed.stops(), 1);
  assert.equal(closed.shared.dead, true);
});
