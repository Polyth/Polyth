import { DictationError } from "../src/providers.ts";

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
  onEnded?: () => void;
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

export async function startPcm16Capture(options: Pcm16CaptureOptions): Promise<Pcm16Capture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DictationError("mic_denied", "Microphone capture is not available in this environment");
  }
  const targetSampleRate = options.targetSampleRate ?? 16_000;
  const chunkMs = Math.max(20, Math.min(100, options.chunkMs ?? 40));
  const chunkSamples = Math.max(1, Math.round(targetSampleRate * chunkMs / 1000));

  let media: MediaStream;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw microphoneError(error);
  }

  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let objectUrl: string | null = null;
  let stopped = false;
  const tracks = media.getAudioTracks();

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    for (const track of tracks) track.onended = null;
    try { node?.disconnect(); } catch { /* already detached */ }
    try { source?.disconnect(); } catch { /* already detached */ }
    for (const track of media.getTracks()) track.stop();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (context) void context.close().catch(() => {});
  };

  try {
    context = new AudioContext({ latencyHint: "interactive" });
    if (!context.audioWorklet) throw new Error("AudioWorklet is not supported by this browser");
    objectUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    await context.audioWorklet.addModule(objectUrl);
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;

    source = context.createMediaStreamSource(media);
    node = new AudioWorkletNode(context, "polyth-pcm16-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: { targetRate: targetSampleRate, chunkSamples },
    });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!stopped && event.data instanceof ArrayBuffer && event.data.byteLength) {
        options.onChunk(new Uint8Array(event.data));
      }
    };
    source.connect(node);
    for (const track of tracks) {
      track.onended = () => {
        if (!stopped) options.onEnded?.();
      };
    }
    if (context.state === "suspended") await context.resume();
  } catch (error) {
    cleanup();
    throw microphoneError(error);
  }

  return {
    sampleRate: targetSampleRate,
    channels: 1,
    async pause() {
      if (!stopped && context?.state === "running") await context.suspend();
    },
    async resume() {
      if (!stopped && context?.state === "suspended") await context.resume();
    },
    stop: cleanup,
  };
}
