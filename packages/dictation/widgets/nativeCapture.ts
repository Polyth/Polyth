import { DictationError } from "../src/providers.ts";
import type { Pcm16Capture, Pcm16CaptureOptions } from "./audioCapture.ts";

/**
 * The host's native microphone capture, when the shell offers one.
 *
 * The iOS app installs it on `globalThis.__polythNativeAudioCapture`
 * (`apps/mobile/src/nativeAudioCapture.ts`, AVAudioEngine underneath),
 * because WKWebView's getUserMedia → Web Audio path delivered no audio there.
 * The shape is structural so this package never imports the host.
 */
export const NATIVE_AUDIO_CAPTURE_GLOBAL = "__polythNativeAudioCapture";

export interface NativeAudioCaptureHandle {
  readonly sampleRate: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeAudioCapture {
  start(
    options: { sampleRate: number; chunkMs: number },
    events: { onChunk(pcm: Uint8Array): void; onEnded(): void },
  ): Promise<NativeAudioCaptureHandle>;
}

/** Native capture restarts itself after interruptions; only a longer silence
 *  than the web graph's is reported as a stall. */
export const NATIVE_CAPTURE_STALL_MS = 4000;

export function nativeAudioCapture(): NativeAudioCapture | null {
  const value = (globalThis as Record<string, unknown>)[NATIVE_AUDIO_CAPTURE_GLOBAL];
  return value && typeof (value as { start?: unknown }).start === "function" ? value as NativeAudioCapture : null;
}

const errorCode = (error: unknown): string =>
  error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";

/** True when the native capture refused for a reason the web path cannot fix. */
export const nativeCaptureDenied = (error: unknown): boolean =>
  error instanceof DictationError && error.code === "mic_denied";

export async function startNativePcm16Capture(
  native: NativeAudioCapture,
  options: Pcm16CaptureOptions,
  sampleRate: number,
  chunkMs: number,
  levelOf: (pcm: Uint8Array) => number,
): Promise<Pcm16Capture> {
  let stopped = false;
  let paused = false;
  let stallReported = false;
  let lastAudioAt = Date.now();
  let handle: NativeAudioCaptureHandle | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    void handle?.stop().catch(() => {});
  };

  try {
    handle = await native.start({ sampleRate, chunkMs }, {
      onChunk(pcm) {
        if (stopped || paused || !pcm.byteLength) return;
        lastAudioAt = Date.now();
        // Level first: onChunk may transfer or retain the buffer.
        options.onLevel?.(levelOf(pcm));
        options.onChunk(pcm);
      },
      onEnded() {
        if (stopped) return;
        cleanup();
        options.onEnded?.();
      },
    });
  } catch (error) {
    stopped = true;
    if (errorCode(error) === "mic_denied") {
      throw new DictationError("mic_denied", "Microphone permission was denied", { cause: error });
    }
    throw new DictationError("audio_format_error", error instanceof Error ? error.message : "Microphone capture failed", { cause: error });
  }
  if (stopped) {
    void handle.stop().catch(() => {});
  } else {
    lastAudioAt = Date.now();
    watchdog = setInterval(() => {
      if (stopped || paused || stallReported) return;
      if (Date.now() - lastAudioAt < NATIVE_CAPTURE_STALL_MS) return;
      stallReported = true;
      options.onStalled?.();
    }, 500);
  }

  return {
    sampleRate,
    channels: 1,
    async pause() {
      if (stopped) return;
      paused = true;
      await handle?.pause();
    },
    async resume() {
      if (stopped) return;
      paused = false;
      lastAudioAt = Date.now();
      await handle?.resume();
    },
    stop: cleanup,
  };
}
