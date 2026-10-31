import { test } from "node:test";
import assert from "node:assert/strict";
import { pcm16Rms, startPcm16Capture } from "../widgets/audioCapture.ts";

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

// The microphone button is the only dictation indicator, so it needs the
// loudness of what is being captured — not just the transcript that follows.
const pcm16 = (samples: number[]): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, Math.round(sample * 0x7fff), true));
  return bytes;
};

test("chunk loudness is reported as RMS in 0..1", () => {
  assert.equal(pcm16Rms(new Uint8Array(0)), 0);
  assert.equal(pcm16Rms(pcm16([0, 0, 0, 0])), 0);
  // A full-scale square wave is the loudest signal PCM16 can carry.
  assert.ok(Math.abs(pcm16Rms(pcm16([1, -1, 1, -1])) - 1) < 0.001);
  const quiet = pcm16Rms(pcm16([0.01, -0.01, 0.01, -0.01]));
  const loud = pcm16Rms(pcm16([0.4, -0.4, 0.4, -0.4]));
  assert.ok(quiet < loud, "room tone reads lower than speech");
  assert.ok(loud < 1);
});

test("capture reports a level for every chunk before handing it on", async () => {
  class FakeSource { connect() {} disconnect() {} }
  class FakeContext {
    state: AudioContextState = "running";
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return new FakeSource() as unknown as MediaStreamAudioSourceNode; }
    async resume() {}
    async suspend() {}
    async close() {}
  }
  let port: { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null } = { onmessage: null };
  class FakeWorkletNode {
    port = port;
    constructor() { port = this.port; }
    connect() {}
    disconnect() {}
  }
  const track = { onended: null as (() => void) | null, stop() {} };
  const stream = {
    getAudioTracks: () => [track as unknown as MediaStreamTrack],
    getTracks: () => [track as unknown as MediaStreamTrack],
  };

  await withNavigator({ mediaDevices: { async getUserMedia() { return stream as unknown as MediaStream; } } }, async () => {
    await withGlobal("AudioContext", FakeContext, async () => {
      await withGlobal("AudioWorkletNode", FakeWorkletNode, async () => {
        const order: string[] = [];
        const levels: number[] = [];
        const capture = await startPcm16Capture({
          onChunk() { order.push("chunk"); },
          onLevel(rms) { order.push("level"); levels.push(rms); },
        });
        const chunk = pcm16([0.5, -0.5, 0.5, -0.5]);
        port.onmessage?.({ data: chunk.buffer } as MessageEvent<ArrayBuffer>);
        assert.deepEqual(order, ["level", "chunk"], "the level is read before onChunk may transfer the buffer");
        assert.ok(levels[0]! > 0.4 && levels[0]! < 0.6);
        capture.stop();
      });
    });
  });
});
