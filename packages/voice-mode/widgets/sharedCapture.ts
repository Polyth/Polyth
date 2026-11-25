// One microphone capture for a whole spoken conversation.
//
// Without it every turn opens the microphone again, and while the agent speaks
// the recognizer is closed: whoever talks over the reply loses the words said
// before the recognizer is back. Here the echo-cancelled capture stays open
// from the first turn to the end, and recognizers attach to it:
//
// - a recognizer that starts after a barge-in is first given the last moment
//   of audio (the pre-roll), so the sentence arrives whole;
// - the loudness watcher that notices the barge-in reads the same stream,
//   instead of opening a second one for every reply.
//
// While the agent speaks no recognizer is attached: the audio goes nowhere
// but a short in-memory ring that is overwritten as it fills. Nothing more
// leaves the device than before.
//
// Not for Apple mobile WebKit, where an open microphone sends playback to the
// quiet earpiece route; the controller only uses this where talking over a
// reply is enabled (`bargeInEnabled`).
import { createVoiceActivityDetector } from "@polyth/dictation";
import type { Pcm16Capture, Pcm16CaptureOptions } from "@polyth/dictation/voice-runtime";
import type { MicMonitor, MicMonitorEvents } from "./micMonitor.ts";

export type CaptureFactory = (options: Pcm16CaptureOptions) => Promise<Pcm16Capture>;

export const SHARED_SAMPLE_RATE = 16_000;
const SHARED_CHUNK_MS = 40;
/** Audio kept for a recognizer that starts late. */
export const PREROLL_KEEP_MS = 3_000;

export interface SharedCapture {
  /** A capture for one recognizer: everything from `prerollMs` before this
   *  call onward — so nothing said while the recognizer connects is lost —
   *  then live audio. */
  factory(prerollMs?: number): CaptureFactory;
  /** The room's loudness with nobody talking, from the quietest moments of
   *  the last seconds; undefined until enough was heard. A recognizer that
   *  starts while the user is already speaking cannot learn it by itself. */
  noiseFloor(): number | undefined;
  /** Watch for the user starting to talk (while the agent speaks). */
  watch(events: MicMonitorEvents): MicMonitor;
  /** The microphone is gone (ended, stalled or stopped): start a new one. */
  readonly dead: boolean;
  stop(): void;
}

interface Subscriber {
  options: Pcm16CaptureOptions;
  /** Bytes per chunk the recognizer asked for. */
  chunkBytes: number;
  /** Audio not yet handed over: the pre-roll, then a partial chunk. */
  backlog: Uint8Array[];
  /** Held until the recognizer has its capture handle. */
  primed: boolean;
  paused: boolean;
}

const rmsOf = (pcm: Uint8Array): number => {
  const samples = pcm.byteLength >> 1;
  if (!samples) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let index = 0; index < samples; index++) {
    const sample = view.getInt16(index * 2, true) / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
};

export async function startSharedCapture(deps: {
  /** The real microphone capture (`startPcm16Capture`). */
  start: CaptureFactory;
  now?: () => number;
  /** Runs once the caller has its handle (a macrotask by default). */
  defer?: (run: () => void) => void;
}): Promise<SharedCapture> {
  const now = deps.now ?? (() => performance.now());
  const defer = deps.defer ?? ((run) => { setTimeout(run, 0); });
  const ring: Uint8Array[] = [];
  /** Loudness of each ring chunk. */
  const levels: number[] = [];
  /** Chunks captured so far (the ring holds the last of them). */
  let total = 0;
  const keepChunks = Math.ceil(PREROLL_KEEP_MS / SHARED_CHUNK_MS);
  let capture: Pcm16Capture | null = null;
  const subscribers = new Set<Subscriber>();
  const watchers = new Set<(rms: number) => void>();
  let dead = false;

  /** Hand a subscriber its audio in the chunk size it asked for. Replayed
   *  audio carries no level: a burst is not a loudness reading. */
  const deliver = (subscriber: Subscriber, live = true) => {
    if (!subscriber.primed || subscriber.paused) return;
    let waiting = subscriber.backlog.reduce((sum, part) => sum + part.byteLength, 0);
    while (waiting >= subscriber.chunkBytes && subscribers.has(subscriber)) {
      const chunk = new Uint8Array(subscriber.chunkBytes);
      let filled = 0;
      while (filled < chunk.byteLength) {
        const head = subscriber.backlog[0]!;
        const take = Math.min(head.byteLength, chunk.byteLength - filled);
        chunk.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.byteLength) subscriber.backlog.shift();
        else subscriber.backlog[0] = head.subarray(take);
      }
      waiting -= chunk.byteLength;
      // Level first, like the real capture: the recognizer may keep the buffer.
      if (live) subscriber.options.onLevel?.(rmsOf(chunk));
      subscriber.options.onChunk(chunk);
    }
  };

  const fail = (report: (options: Pcm16CaptureOptions) => void) => {
    if (dead) return;
    dead = true;
    for (const subscriber of [...subscribers]) report(subscriber.options);
    subscribers.clear();
    watchers.clear();
    ring.length = 0;
    levels.length = 0;
    capture?.stop();
  };

  capture = await deps.start({
    targetSampleRate: SHARED_SAMPLE_RATE,
    chunkMs: SHARED_CHUNK_MS,
    onChunk(pcm) {
      if (dead) return;
      // The capture may reuse its buffer; the ring and the recognizers keep theirs.
      const copy = pcm.slice();
      const rms = rmsOf(copy);
      total++;
      ring.push(copy);
      levels.push(rms);
      if (ring.length > keepChunks) {
        ring.shift();
        levels.shift();
      }
      for (const watcher of [...watchers]) watcher(rms);
      for (const subscriber of [...subscribers]) {
        if (subscriber.paused) continue;
        subscriber.backlog.push(copy);
        deliver(subscriber);
      }
    },
    onEnded() { fail((options) => options.onEnded?.()); },
    onStalled() { fail((options) => options.onStalled?.()); },
  });

  return {
    get dead() { return dead; },
    noiseFloor() {
      // A second of audio at least; the quiet tenth of it is the room.
      if (levels.length < 25) return undefined;
      const sorted = [...levels].sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length / 10)]!;
      return Math.max(0.0005, Math.min(0.05, floor));
    },
    factory(prerollMs = 0) {
      // Fixed now: a recognizer that takes a while to connect still gets the
      // audio from this moment (and the pre-roll before it), not from later.
      const from = total - Math.max(0, Math.ceil(prerollMs / SHARED_CHUNK_MS));
      return async (options) => {
        // Another format than the shared one gets a capture of its own.
        if (dead || (options.targetSampleRate ?? SHARED_SAMPLE_RATE) !== SHARED_SAMPLE_RATE) return deps.start(options);
        const chunkMs = Math.max(20, Math.min(100, options.chunkMs ?? SHARED_CHUNK_MS));
        const oldest = total - ring.length;
        const subscriber: Subscriber = {
          options,
          chunkBytes: Math.round(SHARED_SAMPLE_RATE * chunkMs / 1000) * 2,
          backlog: ring.slice(Math.max(0, from - oldest)),
          primed: false,
          paused: false,
        };
        subscribers.add(subscriber);
        // The recognizer assigns its capture handle after this resolves; the
        // replayed audio follows it, ahead of the live audio queued behind.
        defer(() => {
          subscriber.primed = true;
          deliver(subscriber, false);
        });
        return {
          sampleRate: SHARED_SAMPLE_RATE,
          channels: 1,
          async pause() { subscriber.paused = true; },
          async resume() { subscriber.paused = false; },
          stop() { subscribers.delete(subscriber); },
        };
      };
    },
    watch(events) {
      // Stricter than turn-taking: residual echo of the agent's own voice must
      // not count, so speech needs a clear margin and a deliberate onset. The
      // detector is new for every reply, so it learns the room with that
      // reply's echo in it.
      const vad = createVoiceActivityDetector({ minSpeechRms: 0.035, speechRatio: 3.4, onsetMs: 240, calibrationMs: 300 });
      let stopped = false;
      const watcher = (rms: number) => {
        if (stopped) return;
        events.onLevel?.(vad.level(rms));
        if (vad.push(rms, now()) === "speech-start") events.onSpeech();
      };
      watchers.add(watcher);
      return {
        stop() {
          stopped = true;
          watchers.delete(watcher);
        },
      };
    },
    stop() {
      if (dead) return;
      dead = true;
      subscribers.clear();
      watchers.clear();
      ring.length = 0;
      levels.length = 0;
      capture?.stop();
    },
  };
}
