import { test } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { startPcm16Capture } from "../widgets/audioCapture.ts";
import { NATIVE_AUDIO_CAPTURE_GLOBAL, NATIVE_CAPTURE_STALL_MS } from "../widgets/nativeCapture.ts";

type Events = { onChunk(pcm: Uint8Array): void; onEnded(): void };

const withGlobals = async (values: Record<string, unknown>, run: () => Promise<void>): Promise<void> => {
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    await run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
};

const fakeNative = (startError?: unknown) => {
  const calls: string[] = [];
  let events: Events | null = null;
  let options: { sampleRate: number; chunkMs: number } | null = null;
  const native = {
    async start(next: { sampleRate: number; chunkMs: number }, nextEvents: Events) {
      calls.push("start");
      if (startError) throw startError;
      options = next;
      events = nextEvents;
      return {
        sampleRate: next.sampleRate,
        async pause() { calls.push("pause"); },
        async resume() { calls.push("resume"); },
        async stop() { calls.push("stop"); },
      };
    },
  };
  return { native, calls, events: () => events!, options: () => options };
};

test("the host's native capture is used before getUserMedia and delivers chunks with levels", async () => {
  const fake = fakeNative();
  let webCalls = 0;
  await withGlobals({
    [NATIVE_AUDIO_CAPTURE_GLOBAL]: fake.native,
    navigator: { mediaDevices: { async getUserMedia() { webCalls++; throw new Error("unused"); } } },
  }, async () => {
    const chunks: Uint8Array[] = [];
    const levels: number[] = [];
    const capture = await startPcm16Capture({ targetSampleRate: 16_000, chunkMs: 40, onChunk: (pcm) => chunks.push(pcm), onLevel: (rms) => levels.push(rms) });
    assert.deepEqual(fake.options(), { sampleRate: 16_000, chunkMs: 40 });
    assert.equal(webCalls, 0, "WKWebView capture is not touched");
    const loud = new Uint8Array(new Int16Array([16_000, -16_000]).buffer);
    fake.events().onChunk(loud);
    assert.equal(chunks.length, 1);
    assert.ok(levels[0]! > 0.4);
    await capture.pause();
    fake.events().onChunk(loud);
    assert.equal(chunks.length, 1, "paused capture drops audio");
    await capture.resume();
    capture.stop();
    fake.events().onChunk(loud);
    assert.equal(chunks.length, 1, "stopped capture drops audio");
    assert.deepEqual(fake.calls, ["start", "pause", "resume", "stop"]);
  });
});

test("a native refusal is mic_denied and does not fall back to the web capture", async () => {
  const fake = fakeNative(Object.assign(new Error("Microphone permission was denied"), { code: "mic_denied" }));
  let webCalls = 0;
  await withGlobals({
    [NATIVE_AUDIO_CAPTURE_GLOBAL]: fake.native,
    navigator: { mediaDevices: { async getUserMedia() { webCalls++; throw new Error("unused"); } } },
  }, async () => {
    await assert.rejects(
      () => startPcm16Capture({ onChunk() {} }),
      (error: unknown) => (error as { code?: string }).code === "mic_denied",
    );
    assert.equal(webCalls, 0);
  });
});

test("another native failure falls back to the web capture", async () => {
  const fake = fakeNative(Object.assign(new Error("No microphone input is available"), { code: "audio_unavailable" }));
  let webCalls = 0;
  await withGlobals({
    [NATIVE_AUDIO_CAPTURE_GLOBAL]: fake.native,
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          webCalls++;
          throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        },
      },
    },
  }, async () => {
    await assert.rejects(() => startPcm16Capture({ onChunk() {} }));
    assert.equal(webCalls, 1, "the web path was tried");
  });
});

test("without a web capture, the native failure itself is reported", async () => {
  const fake = fakeNative(Object.assign(new Error("No microphone input is available"), { code: "audio_unavailable" }));
  await withGlobals({ [NATIVE_AUDIO_CAPTURE_GLOBAL]: fake.native, navigator: {} }, async () => {
    await assert.rejects(
      () => startPcm16Capture({ onChunk() {} }),
      (error: unknown) => (error as { code?: string; message?: string }).code === "audio_format_error"
        && (error as Error).message === "No microphone input is available",
    );
  });
});

test("a lost native microphone reports onEnded once and stops the capture", async () => {
  const fake = fakeNative();
  await withGlobals({ [NATIVE_AUDIO_CAPTURE_GLOBAL]: fake.native, navigator: {} }, async () => {
    let ended = 0;
    await startPcm16Capture({ onChunk() {}, onEnded: () => { ended++; } });
    fake.events().onEnded();
    fake.events().onEnded();
    assert.equal(ended, 1);
    assert.deepEqual(fake.calls, ["start", "stop"]);
  });
});

test("a native capture that delivers nothing is reported as stalled", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const fake = fakeNative();
  await withGlobals({ [NATIVE_AUDIO_CAPTURE_GLOBAL]: fake.native, navigator: {} }, async () => {
    let stalled = 0;
    const capture = await startPcm16Capture({ onChunk() {}, onStalled: () => { stalled++; } });
    t.mock.timers.tick(NATIVE_CAPTURE_STALL_MS - 500);
    fake.events().onChunk(new Uint8Array(4));
    t.mock.timers.tick(NATIVE_CAPTURE_STALL_MS - 500);
    assert.equal(stalled, 0, "a chunk resets the stall clock");
    t.mock.timers.tick(1_000);
    assert.equal(stalled, 1);
    t.mock.timers.tick(NATIVE_CAPTURE_STALL_MS * 2);
    assert.equal(stalled, 1, "reported once");
    capture.stop();
  });
});

test("the iOS shell publishes its native capture under the name this package reads", async () => {
  const host = await readFile(new URL("../../../apps/mobile/src/nativeAudioCapture.ts", import.meta.url), "utf8");
  assert.match(host, new RegExp(`NATIVE_AUDIO_CAPTURE_GLOBAL = "${NATIVE_AUDIO_CAPTURE_GLOBAL}"`));
});
