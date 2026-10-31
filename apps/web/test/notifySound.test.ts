import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPLETION_SOUND_URI } from "../src/assets/completionSound.ts";
import { playCompletionSound } from "../src/notify.ts";

test("completion sound URI is valid base64 audio/mpeg matching asset bytes", () => {
  assert.ok(COMPLETION_SOUND_URI.startsWith("data:audio/mpeg;base64,"));
  const b64 = COMPLETION_SOUND_URI.slice("data:audio/mpeg;base64,".length);
  const soundBuf = Buffer.from(b64, "base64");
  const assetPath = resolve(import.meta.dirname, "../src/assets/completion.mp3");
  const assetBuf = readFileSync(assetPath);
  assert.deepEqual(soundBuf, assetBuf);
  // Verify it starts with ID3 header
  assert.equal(soundBuf.subarray(0, 3).toString("latin1"), "ID3");
});

test("playCompletionSound runs safely in headless environment without throwing", () => {
  assert.doesNotThrow(() => {
    playCompletionSound();
  });
});

test("playCompletionSound plays via Web Audio and never creates an HTMLMediaElement", async () => {
  let mediaElements = 0;
  let started = 0;
  let decoded = 0;
  let resumed = 0;

  class FakeBufferSource {
    buffer: unknown = null;
    onended: (() => void) | null = null;
    connect(): void {}
    disconnect(): void {}
    start(): void { started++; }
  }

  class FakeAudioContext {
    state = "suspended";
    destination = {};
    createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
    decodeAudioData(): Promise<unknown> {
      decoded++;
      return Promise.resolve({ duration: 0.5 });
    }
    resume(): Promise<void> {
      resumed++;
      this.state = "running";
      return Promise.resolve();
    }
    close(): Promise<void> { return Promise.resolve(); }
    createOscillator(): never { throw new Error("oscillator fallback must not run"); }
  }

  const globals = globalThis as unknown as { window?: unknown; Audio?: unknown };
  const prevWindow = globals.window;
  const prevAudio = globals.Audio;
  try {
    // A fake window without HTMLMediaElement support: any `new Audio(...)` is
    // counted, and the AudioContext records buffer sources instead.
    globals.window = { AudioContext: FakeAudioContext };
    globals.Audio = class { constructor() { mediaElements++; } };

    playCompletionSound();
    await new Promise((resolve) => setTimeout(resolve, 0));
    playCompletionSound();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(mediaElements, 0, "completion sound must not construct an HTMLAudioElement");
    assert.equal(started, 2, "each cue starts one Web Audio buffer source");
    assert.equal(decoded, 1, "the embedded clip is decoded once and reused");
    assert.ok(resumed >= 1, "a suspended context is resumed before playback");
  } finally {
    if (prevWindow === undefined) delete globals.window;
    else globals.window = prevWindow;
    if (prevAudio === undefined) delete globals.Audio;
    else globals.Audio = prevAudio;
  }
});

test("every later gesture re-primes a context iOS suspended again", async () => {
  const listeners = new Map<string, () => void>();
  const contexts: Array<{ state: string }> = [];
  let resumed = 0;
  class FakeAudioContext {
    state = "suspended";
    destination = {};
    constructor() { contexts.push(this); }
    decodeAudioData(): Promise<unknown> { return Promise.resolve({ duration: 0.5 }); }
    resume(): Promise<void> {
      resumed++;
      this.state = "running";
      return Promise.resolve();
    }
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = globals.window;
  const prevDocument = globals.document;
  try {
    globals.window = { AudioContext: FakeAudioContext };
    globals.document = {
      addEventListener(type: string, fn: () => void) { listeners.set(type, fn); },
      removeEventListener(type: string) { listeners.delete(type); },
    };
    // A fresh module instance: earlier cases already cached a context.
    const fresh = "../src/notify.ts?reprime";
    const notify = await import(fresh) as { installNotify(): void };
    try { notify.installNotify(); } catch { /* the store wiring needs the full app */ }
    const gesture = listeners.get("pointerdown");
    assert.ok(gesture, "a pointerdown primer is installed");
    gesture!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resumed, 1, "the first gesture resumes the context");
    contexts[0]!.state = "interrupted";
    gesture!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resumed, 2, "a later gesture resumes a context that is no longer running");
    gesture!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resumed, 2, "a running, decoded context is left alone");
  } finally {
    if (prevWindow === undefined) delete globals.window;
    else globals.window = prevWindow;
    if (prevDocument === undefined) delete globals.document;
    else globals.document = prevDocument;
  }
});
