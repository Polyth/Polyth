// A streamed server voice is played while it arrives: the first sound comes
// after a little audio rather than the whole clip, pieces follow back to back
// on the audio clock, stopping stops them all, a stream without audio falls
// back to the browser voice, and a short remark is not fetched twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, { window: dom, CustomEvent: dom.CustomEvent });
Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });

interface FakeBuffer { length: number; sampleRate: number; duration: number; data: Float32Array; getChannelData(): Float32Array }
interface FakeNode {
  buffer: FakeBuffer | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  startedAt: number | null;
  stopped: boolean;
  connect(): void;
  disconnect(): void;
  start(at?: number): void;
  stop(): void;
}

const audio = { now: 0, nodes: [] as FakeNode[], decoded: 0 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() { return audio.now; }
  resume() { return Promise.resolve(); }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {}, getFloatTimeDomainData() {} }; }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const data = new Float32Array(length);
    return { length, sampleRate, duration: length / sampleRate, data, getChannelData: () => data };
  }
  createBufferSource(): FakeNode {
    const node: FakeNode = {
      buffer: null, playbackRate: { value: 1 }, onended: null, startedAt: null, stopped: false,
      connect() {}, disconnect() {},
      start(at = audio.now) { node.startedAt = at; audio.nodes.push(node); },
      stop() { node.stopped = true; },
    };
    return node;
  }
  decodeAudioData(data: ArrayBuffer) {
    audio.decoded++;
    return Promise.resolve(this.createBuffer(1, data.byteLength, 44_100));
  }
}
Object.assign(dom, { AudioContext: FakeAudioContext });

const spoken: string[] = [];
class FakeUtterance {
  text: string;
  lang = ""; rate = 1; pitch = 1; volume = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onboundary: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}
Object.assign(dom, {
  speechSynthesis: {
    speaking: false, paused: false,
    getVoices: () => [{ name: "Samantha", lang: "en-US", localService: true, default: true }],
    speak(utterance: FakeUtterance) { spoken.push(utterance.text); queueMicrotask(() => utterance.onstart?.()); },
    cancel() {}, resume() {}, addEventListener() {}, removeEventListener() {},
  },
});
Object.assign(globalThis, { SpeechSynthesisUtterance: FakeUtterance });

const { createSpeechOutput, pcm16ToFloat, pcmStreamRate } = await import("../widgets/speechOutput.ts");

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let index = 0; index < 4; index++) await tick(); };
const settings = () => ({ engine: "server" as const, lang: "en-US", rate: 1, pitch: 1, volume: 1 });

/** `ms` of 24 kHz PCM16 whose samples all hold `value`. */
const pcm = (ms: number, value = 1_000): Uint8Array => {
  const samples = Math.round(24 * ms);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index++) view.setInt16(index * 2, value, true);
  return bytes;
};

interface Call { body: Record<string, unknown>; feed: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal | undefined }

/** Every `/api/tts/speak` call answers with a PCM stream the test feeds. */
function streamingFetch(contentType = "audio/pcm;rate=24000") {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
    calls.push({ body: JSON.parse(String(init?.body)), feed, signal: init?.signal ?? undefined });
    return new Response(stream, { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const reset = () => {
  audio.now = 0;
  audio.nodes.length = 0;
  audio.decoded = 0;
  spoken.length = 0;
};

/** The audio clock reaches the end of a piece. */
const finish = (node: FakeNode) => {
  audio.now = node.startedAt! + node.buffer!.duration;
  node.onended?.();
};

test("PCM16 is read across network chunk boundaries, and only a PCM response is a stream", () => {
  const first = pcm16ToFloat(new Uint8Array([0x00, 0x40, 0xff]), null);
  assert.deepEqual([...first.samples], [0.5]);
  assert.equal(first.carry, 0xff, "an odd byte waits for its other half");
  const second = pcm16ToFloat(new Uint8Array([0x7f, 0x00, 0x80]), first.carry);
  assert.deepEqual([...second.samples], [Math.fround(32_767 / 32_768), -1], "0x7fff then 0x8000, the first spanning two chunks");
  assert.equal(second.carry, null);
  assert.equal(pcmStreamRate("audio/pcm;rate=24000"), 24_000);
  assert.equal(pcmStreamRate("audio/pcm; rate=16000"), 16_000);
  assert.equal(pcmStreamRate("audio/pcm"), null, "a stream without a rate cannot be played");
  assert.equal(pcmStreamRate("audio/mpeg"), null);
  assert.equal(pcmStreamRate(null), null);
});

test("the first sound comes after a little audio, and the pieces follow back to back", async () => {
  reset();
  const net = streamingFetch();
  const log: string[] = [];
  const output = createSpeechOutput(settings, {
    onSpeaking: (value) => log.push(`speaking:${value}`),
    onChunk: (text) => log.push(`chunk:${text}`),
    onIdle: () => log.push("idle"),
  });
  try {
    output.enqueue("A long reply that is still being synthesized.");
    await settle();
    assert.deepEqual(net.calls.map((call) => call.body), [{ text: "A long reply that is still being synthesized.", lang: "en-US", stream: true }]);

    net.calls[0]!.feed.enqueue(pcm(60));
    await settle();
    assert.equal(audio.nodes.length, 0, "too little to start without stuttering");
    assert.equal(log.length, 0);
    net.calls[0]!.feed.enqueue(pcm(80));
    await settle();
    assert.equal(audio.nodes.length, 1, "140 ms of audio is enough to begin");
    assert.equal(audio.nodes[0]!.buffer!.sampleRate, 24_000);
    assert.equal(audio.nodes[0]!.buffer!.length, 24 * 140);
    assert.ok(Math.abs(audio.nodes[0]!.buffer!.data[0]! - 1_000 / 32_768) < 1e-6, "the samples are the stream's");
    assert.deepEqual(log, ["speaking:true", "chunk:A long reply that is still being synthesized."],
      "audible while the service is still generating");

    net.calls[0]!.feed.enqueue(pcm(100));
    await settle();
    assert.equal(audio.nodes.length, 1, "small pieces are joined while there is audio in hand");
    net.calls[0]!.feed.enqueue(pcm(200));
    await settle();
    assert.equal(audio.nodes.length, 2);
    const [head, tail] = audio.nodes;
    assert.ok(Math.abs(tail!.startedAt! - (head!.startedAt! + head!.buffer!.duration)) < 1e-9, "no gap and no overlap between pieces");

    finish(head!);
    assert.equal(log.includes("idle"), false, "the stream is not over");
    net.calls[0]!.feed.enqueue(pcm(30));
    net.calls[0]!.feed.close();
    await settle();
    assert.equal(audio.nodes.length, 3, "the last short piece is played once the stream ends");
    finish(tail!);
    assert.equal(log.includes("idle"), false);
    finish(audio.nodes[2]!);
    await settle();
    assert.equal(log.at(-1), "idle", "the chunk is done when its last piece has played");
  } finally {
    output.dispose();
    net.restore();
  }
});

test("stopping a streamed reply silences every scheduled piece and cancels the request", async () => {
  reset();
  const net = streamingFetch();
  const output = createSpeechOutput(settings, {});
  try {
    output.enqueue("First part of the reply.");
    output.enqueue("Second part of the reply.");
    await settle();
    net.calls[0]!.feed.enqueue(pcm(300));
    await settle();
    net.calls[0]!.feed.enqueue(pcm(300));
    await settle();
    assert.equal(audio.nodes.length, 2);
    assert.equal(net.calls.length, 2, "the next chunk is already being fetched");
    output.cancel();
    assert.deepEqual(audio.nodes.map((node) => node.stopped), [true, true]);
    assert.deepEqual(net.calls.map((call) => call.signal?.aborted), [true, true], "interrupted speech is not downloaded to the end");
    assert.equal(output.active, false);
    // Audio that was still on its way must not start after the stop.
    try { net.calls[0]!.feed.enqueue(pcm(300)); } catch { /* the reader is gone */ }
    await settle();
    assert.equal(audio.nodes.length, 2);
  } finally {
    output.dispose();
    net.restore();
  }
});

test("a stream that ends without audio falls back to the browser voice", async () => {
  reset();
  const net = streamingFetch();
  const errors: string[] = [];
  const output = createSpeechOutput(settings, { onError: (error) => errors.push(error.message) });
  try {
    output.enqueue("Hello there.");
    await settle();
    net.calls[0]!.feed.error(new Error("connection reset"));
    await settle();
    assert.equal(audio.nodes.length, 0);
    assert.deepEqual(errors, ["connection reset"]);
    assert.deepEqual(spoken, ["Hello there."], "the sentence is still heard");
  } finally {
    output.dispose();
    net.restore();
  }
});

test("a stream cut after it began plays what arrived and moves on", async () => {
  reset();
  const net = streamingFetch();
  const log: string[] = [];
  const output = createSpeechOutput(settings, { onIdle: () => log.push("idle"), onError: () => log.push("error") });
  try {
    output.enqueue("Hello there.");
    await settle();
    net.calls[0]!.feed.enqueue(pcm(200));
    await settle();
    net.calls[0]!.feed.error(new Error("connection reset"));
    await settle();
    assert.equal(audio.nodes.length, 1);
    finish(audio.nodes[0]!);
    await settle();
    assert.deepEqual(log, ["idle"], "half a sentence was heard: it is not said again in another voice");
    assert.deepEqual(spoken, []);
  } finally {
    output.dispose();
    net.restore();
  }
});

test("a short remark is fetched once and is instant the next time; replies are never cached", async () => {
  reset();
  const net = streamingFetch();
  const output = createSpeechOutput(settings, {});
  try {
    output.enqueue("Got it.", { kind: "aside" });
    await settle();
    net.calls[0]!.feed.enqueue(pcm(200, 2_000));
    net.calls[0]!.feed.close();
    await settle();
    finish(audio.nodes[0]!);
    await settle();

    output.enqueue("Got it.", { kind: "aside" });
    await settle();
    assert.equal(net.calls.length, 1, "the same remark in the same voice is not synthesized again");
    assert.equal(audio.nodes.length, 2);
    assert.equal(audio.nodes[1]!.buffer!.length, 24 * 200);
    assert.ok(Math.abs(audio.nodes[1]!.buffer!.data[0]! - 2_000 / 32_768) < 1e-6);
    finish(audio.nodes[1]!);
    await settle();

    output.enqueue("Got it.");
    await settle();
    assert.equal(net.calls.length, 2, "a reply chunk is content, not a stock phrase");
    net.calls[1]!.feed.close();
    await settle();
  } finally {
    output.dispose();
    net.restore();
  }
});

test("a whole clip from a service that cannot stream is decoded and played as before", async () => {
  reset();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(64).buffer, { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
  const log: string[] = [];
  const output = createSpeechOutput(settings, { onChunk: (text) => log.push(text) });
  try {
    output.enqueue("Whole clip.");
    await settle();
    assert.equal(audio.decoded, 1);
    assert.equal(audio.nodes.length, 1);
    assert.deepEqual(log, ["Whole clip."]);
  } finally {
    output.dispose();
    globalThis.fetch = original;
  }
});
