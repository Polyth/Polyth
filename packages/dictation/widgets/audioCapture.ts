import { DictationError } from "../src/providers.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export interface Pcm16Capture {
  readonly sampleRate: number;
  readonly channels: 1;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): void;
}

export interface Pcm16CaptureOptions {
  targetSampleRate?: number;
  chunkMs?: number;
  onChunk(pcm: Uint8Array): void;
  /** Per-chunk RMS amplitude in 0..1. Raw loudness only — silence detection
   *  and any perceptual curve belong to the caller that renders it. */
  onLevel?: (rms: number) => void;
  onEnded?: () => void;
  /** No audio arrived for a while although capture is live and recovery
   *  (resume, then a fresh audio graph) did not help. Fired once. */
  onStalled?: () => void;
}

/** How long a live capture may go without a chunk before recovery starts. */
export const CAPTURE_STALL_MS = 1500;
/** Recovery steps (resume, rebuild) before the stall is reported. */
const STALL_RECOVERY_STEPS = 2;
const RESUME_WAIT_MS = 1000;

type CaptureState = AudioContextState | "interrupted";

/** Resume a context without letting a WebKit resume() that never settles
 *  (an interrupted iOS audio session) hold capture start hostage. */
const resumeBounded = async (context: AudioContext): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      context.resume().catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, RESUME_WAIT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** RMS of a little-endian PCM16 chunk, normalized to 0..1. */
export function pcm16Rms(pcm: Uint8Array): number {
  const samples = pcm.byteLength >> 1;
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = view.getInt16(i * 2, true) / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

// Resampling + PCM conversion deliberately live inside the AudioWorklet so the
// UI thread only forwards already-framed byte chunks.
const WORKLET_SOURCE = String.raw`
class PolythPcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions || {};
    this.targetRate = p.targetRate || 16000;
    this.chunkSamples = p.chunkSamples || 640;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(this.chunkSamples);
    this.outAt = 0;
  }

  emit() {
    if (!this.outAt) return;
    const bytes = new ArrayBuffer(this.outAt * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < this.outAt; i++) view.setInt16(i * 2, this.out[i], true);
    this.port.postMessage(bytes, [bytes]);
    this.outAt = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i] || 0));
      this.sum += sample;
      this.count++;
      this.phase += this.targetRate;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const averaged = this.count ? this.sum / this.count : 0;
      this.sum = 0;
      this.count = 0;
      this.out[this.outAt++] = Math.round(averaged < 0 ? averaged * 0x8000 : averaged * 0x7fff);
      if (this.outAt >= this.out.length) this.emit();
    }
    return true;
  }
}
registerProcessor("polyth-pcm16-capture", PolythPcm16Capture);
`;

const microphoneError = (error: unknown): DictationError => {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return new DictationError("mic_denied", "Microphone permission was denied", { cause: error });
  }
  return new DictationError("audio_format_error", error instanceof Error ? error.message : "Microphone capture failed", { cause: error });
};

const microphoneConstraints: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export async function startPcm16Capture(options: Pcm16CaptureOptions): Promise<Pcm16Capture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DictationError("mic_denied", "Microphone capture is not available in this environment");
  }
  const targetSampleRate = options.targetSampleRate ?? 16_000;
  const chunkMs = Math.max(20, Math.min(100, options.chunkMs ?? 40));
  const chunkSamples = Math.max(1, Math.round(targetSampleRate * chunkMs / 1000));

  let media: MediaStream;
  try {
    media = await navigator.mediaDevices.getUserMedia(microphoneConstraints);
  } catch (error) {
    throw microphoneError(error);
  }

  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let objectUrl: string | null = null;
  let tracks = media.getAudioTracks();
  let stopped = false;
  let paused = false;
  let replaceFlight: Promise<void> | null = null;
  let endedReported = false;
  let lastAudioAt = Date.now();
  let recoverySteps = 0;
  let stallReported = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const reportEnded = () => {
    if (stopped || endedReported) return;
    endedReported = true;
    options.onEnded?.();
  };

  const closeGraph = () => {
    try { node?.disconnect(); } catch { /* already detached */ }
    try { source?.disconnect(); } catch { /* already detached */ }
    if (node) node.port.onmessage = null;
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => {});
    }
    node = null;
    source = null;
    context = null;
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    for (const track of tracks) track.onended = null;
    closeGraph();
    for (const track of media.getTracks()) track.stop();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };

  /** Bring a live context back to "running". iOS WebKit parks a context in
   *  "interrupted" (or "suspended") when its audio session is taken — a
   *  call, Siri, another app's playback — and a context in that state renders
   *  nothing: the microphone indicator is lit, yet no chunk ever arrives. */
  const wake = async (): Promise<void> => {
    const current = context;
    if (stopped || paused || !current) return;
    const state = current.state as CaptureState;
    if (state === "running" || state === "closed") return;
    await resumeBounded(current);
  };

  const buildGraph = async (): Promise<void> => {
    const next = new AudioContext({ latencyHint: "interactive" });
    context = next;
    if (!next.audioWorklet) throw new Error(tr("dictation.error.audioWorkletUnsupported"));
    objectUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    await next.audioWorklet.addModule(objectUrl);
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (stopped || context !== next) return;

    source = next.createMediaStreamSource(media);
    node = new AudioWorkletNode(next, "polyth-pcm16-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: { targetRate: targetSampleRate, chunkSamples },
    });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!stopped && event.data instanceof ArrayBuffer && event.data.byteLength) {
        lastAudioAt = Date.now();
        recoverySteps = 0;
        const pcm = new Uint8Array(event.data);
        // Level first: onChunk may transfer or retain the buffer.
        options.onLevel?.(pcm16Rms(pcm));
        options.onChunk(pcm);
      }
    };
    source.connect(node);
    next.onstatechange = () => { void wake(); };
    lastAudioAt = Date.now();
    await wake();
  };

  const armTracks = () => {
    for (const track of tracks) {
      track.onended = () => {
        if (stopped) return;
        void replaceMicrophone().catch(reportEnded);
      };
    }
  };

  const replaceMicrophone = async (): Promise<void> => {
    if (stopped) return;
    if (replaceFlight) return replaceFlight;
    replaceFlight = (async () => {
      let replacement: MediaStream;
      try {
        replacement = await navigator.mediaDevices.getUserMedia(microphoneConstraints);
      } catch (error) {
        throw microphoneError(error);
      }
      if (stopped || !context || !node) {
        for (const track of replacement.getTracks()) track.stop();
        return;
      }
      const nextSource = context.createMediaStreamSource(replacement);
      nextSource.connect(node);

      const previousMedia = media;
      const previousSource = source;
      const previousTracks = tracks;
      media = replacement;
      source = nextSource;
      tracks = replacement.getAudioTracks();
      endedReported = false;
      armTracks();

      try { previousSource?.disconnect(); } catch { /* already detached */ }
      for (const track of previousTracks) track.onended = null;
      for (const track of previousMedia.getTracks()) track.stop();
    })().finally(() => {
      replaceFlight = null;
    });
    return replaceFlight;
  };

  /** A live capture that delivers nothing is recovered, then reported: first
   *  resume the context, then rebuild the audio graph on the same microphone,
   *  and only then tell the caller instead of showing a silent 0:00. */
  const checkStall = () => {
    if (stopped || paused || stallReported || replaceFlight) return;
    if (Date.now() - lastAudioAt < CAPTURE_STALL_MS) return;
    lastAudioAt = Date.now();
    if (recoverySteps >= STALL_RECOVERY_STEPS) {
      stallReported = true;
      options.onStalled?.();
      return;
    }
    recoverySteps++;
    if (recoverySteps === 1) {
      void wake();
      return;
    }
    closeGraph();
    void buildGraph().catch(() => {
      if (stopped || stallReported) return;
      stallReported = true;
      options.onStalled?.();
    });
  };

  try {
    await buildGraph();
    armTracks();
  } catch (error) {
    cleanup();
    throw microphoneError(error);
  }
  watchdog = setInterval(checkStall, Math.round(CAPTURE_STALL_MS / 3));

  return {
    sampleRate: targetSampleRate,
    channels: 1,
    async pause() {
      if (stopped) return;
      paused = true;
      if (context?.state === "running") await context.suspend();
    },
    async resume() {
      if (stopped) return;
      paused = false;
      lastAudioAt = Date.now();
      const current = context;
      if (current && (current.state as CaptureState) !== "running") await current.resume();
    },
    stop: cleanup,
  };
}
