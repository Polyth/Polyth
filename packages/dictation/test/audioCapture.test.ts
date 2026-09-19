import { test } from "node:test";
import assert from "node:assert/strict";
import { startPcm16Capture } from "../widgets/audioCapture.ts";

const withGlobal = async (key: string, value: unknown, run: () => Promise<void>): Promise<void> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
};

const withNavigator = async (value: unknown, run: () => Promise<void>): Promise<void> =>
  withGlobal("navigator", value, run);

test("microphone permission denial is normalized to mic_denied", async () => {
  await withNavigator({
    mediaDevices: {
      async getUserMedia() {
        const error = new Error("permission denied");
        error.name = "NotAllowedError";
        throw error;
      },
    },
  }, async () => {
    await assert.rejects(
      () => startPcm16Capture({ onChunk() {} }),
      (error: unknown) => (error as { code?: string }).code === "mic_denied",
    );
  });
});

test("missing microphone API is reported as mic_denied", async () => {
  await withNavigator({}, async () => {
    await assert.rejects(
      () => startPcm16Capture({ onChunk() {} }),
      (error: unknown) => (error as { code?: string }).code === "mic_denied",
    );
  });
});

test("ended microphone track is replaced before reporting the capture as ended", async () => {
  class FakeTrack {
    onended: (() => void) | null = null;
    stopped = false;
    stop() { this.stopped = true; }
  }
  class FakeStream {
    readonly track: FakeTrack;
    constructor(track: FakeTrack) { this.track = track; }
    getAudioTracks() { return [this.track] as unknown as MediaStreamTrack[]; }
    getTracks() { return [this.track] as unknown as MediaStreamTrack[]; }
  }
  class FakeSource {
    disconnected = false;
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  let currentContext: FakeContext | null = null;
  class FakeContext {
    state: AudioContextState = "running";
    audioWorklet = { addModule: async () => {} };
    sources: FakeSource[] = [];
    constructor() { currentContext = this; }
    createMediaStreamSource() {
      const source = new FakeSource();
      this.sources.push(source);
      return source as unknown as MediaStreamAudioSourceNode;
    }
    async resume() { this.state = "running"; }
    async suspend() { this.state = "suspended"; }
    async close() { this.state = "closed"; }
  }
  class FakeWorkletNode {
    port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null };
    connect() {}
    disconnect() {}
  }

  const first = new FakeTrack();
  const second = new FakeTrack();
  let calls = 0;
  let ended = 0;
  const navigatorValue = {
    mediaDevices: {
      async getUserMedia() {
        calls++;
        if (calls === 1) return new FakeStream(first) as unknown as MediaStream;
        if (calls === 2) return new FakeStream(second) as unknown as MediaStream;
        throw new Error("replacement unavailable");
      },
    },
  };

  await withNavigator(navigatorValue, async () => {
    await withGlobal("AudioContext", FakeContext, async () => {
      await withGlobal("AudioWorkletNode", FakeWorkletNode, async () => {
        const capture = await startPcm16Capture({ onChunk() {}, onEnded: () => { ended++; } });
        assert.equal(calls, 1);
        first.onended?.();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 2);
        assert.equal(ended, 0);
        const context = currentContext as FakeContext | null;
        assert.ok(context);
        assert.equal(context.sources.length, 2);
        assert.equal(context.sources[0]?.disconnected, true);

        second.onended?.();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 3);
        assert.equal(ended, 1);
        capture.stop();
      });
    });
  });
});
