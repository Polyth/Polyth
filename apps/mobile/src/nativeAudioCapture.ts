import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Native microphone capture, offered to packages as a host primitive.
 *
 * In the iOS app WKWebView's getUserMedia → Web Audio path delivered no
 * audio (record mode sat at 0:00 while Mobile Safari worked with the same
 * code), so the shell installs this capture on `globalThis` under
 * {@link NATIVE_AUDIO_CAPTURE_GLOBAL}. A package's microphone capture looks
 * it up structurally; the host never names the package. Native side:
 * `ios/App/App/PolythAudioCapturePlugin.swift`.
 */
export const NATIVE_AUDIO_CAPTURE_GLOBAL = "__polythNativeAudioCapture";

export interface NativeAudioCaptureOptions {
  /** Output rate of the 16-bit little-endian mono PCM. */
  sampleRate: number;
  /** Size of each chunk, 20..100 ms. */
  chunkMs: number;
}

export interface NativeAudioCaptureEvents {
  onChunk(pcm: Uint8Array): void;
  /** The microphone was lost and could not be restarted. */
  onEnded(): void;
}

export interface NativeAudioCaptureHandle {
  readonly sampleRate: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeAudioCapture {
  /** Rejects with `code: "mic_denied"` when the person refused the microphone. */
  start(options: NativeAudioCaptureOptions, events: NativeAudioCaptureEvents): Promise<NativeAudioCaptureHandle>;
}

interface AudioCapturePlugin {
  start(options: NativeAudioCaptureOptions): Promise<{ sampleRate?: number; channels?: number }>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  addListener(eventName: "audioChunk", listener: (event: { data?: unknown }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioEnded", listener: (event: { reason?: unknown }) => void): Promise<PluginListenerHandle>;
}

const PLUGIN = "PolythAudioCapture";

export function decodeBase64Pcm(data: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (value: string) => Uint8Array }).fromBase64;
  if (typeof native === "function") return native(data);
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

/** One capture at a time: a new start retires the previous handle. */
export function createNativeAudioCapture(plugin: AudioCapturePlugin): NativeAudioCapture {
  let current = 0;
  let retireCurrent: (() => Promise<void>) | null = null;

  return {
    async start(options, events) {
      await retireCurrent?.();
      const token = ++current;
      const live = () => token === current;
      const listeners: PluginListenerHandle[] = [];
      const removeListeners = async () => {
        const handles = listeners.splice(0);
        await Promise.all(handles.map((handle) => handle.remove().catch(() => undefined)));
      };
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (live()) {
          current++;
          retireCurrent = null;
          await plugin.stop().catch(() => undefined);
        }
        await removeListeners();
      };

      listeners.push(await plugin.addListener("audioChunk", (event) => {
        if (!live() || stopped || typeof event.data !== "string" || !event.data) return;
        events.onChunk(decodeBase64Pcm(event.data));
      }));
      listeners.push(await plugin.addListener("audioEnded", () => {
        if (!live() || stopped) return;
        void stop();
        events.onEnded();
      }));

      let started: { sampleRate?: number };
      try {
        retireCurrent = stop;
        started = await plugin.start(options);
      } catch (error) {
        stopped = true;
        if (live()) retireCurrent = null;
        await removeListeners();
        throw error;
      }
      if (!live()) {
        await removeListeners();
        throw new Error("Microphone capture was replaced");
      }
      return {
        sampleRate: typeof started.sampleRate === "number" ? started.sampleRate : options.sampleRate,
        pause: () => (live() && !stopped ? plugin.pause() : Promise.resolve()),
        resume: () => (live() && !stopped ? plugin.resume() : Promise.resolve()),
        stop,
      };
    },
  };
}

/** Publishes the capture for packages on iOS builds that carry the plugin.
 *  Android's WebView capture works and keeps the web path. */
export function installNativeAudioCapture(): () => void {
  if (Capacitor.getPlatform() !== "ios" || !Capacitor.isPluginAvailable(PLUGIN)) return () => {};
  const capture = createNativeAudioCapture(registerPlugin<AudioCapturePlugin>(PLUGIN));
  const target = globalThis as Record<string, unknown>;
  target[NATIVE_AUDIO_CAPTURE_GLOBAL] = capture;
  return () => {
    if (target[NATIVE_AUDIO_CAPTURE_GLOBAL] === capture) delete target[NATIVE_AUDIO_CAPTURE_GLOBAL];
  };
}
