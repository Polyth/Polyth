// One spoken turn: capture, live transcript, loudness and end-of-turn
// detection over whichever recognizer the route names. The dictation package
// owns the transports; this file adds what a conversation needs on top —
// noticing that the speaker has finished.
import {
  DictationError,
  applySpokenPunctuation,
  createVoiceActivityDetector,
  mergeTranscript,
  recognitionCtor,
  type DictationProviderId,
  type SpeechRecognitionLike,
} from "@polyth/dictation";
import {
  startDirectProvider,
  startStreamingDictation,
  type StreamingDictation,
} from "@polyth/dictation/voice-runtime";
import { formatVoiceString, voiceModeStrings } from "../src/strings.ts";
import { getLocale } from "../../../apps/web/src/i18n/index.ts";

const words = () => voiceModeStrings(getLocale());

export type RecognitionRoute =
  | { kind: "browser"; lang: string; onDevice: boolean; punctuation: boolean }
  | { kind: "server"; language: string; sessionId?: string }
  | { kind: "direct"; provider: DictationProviderId; model?: string; language: string };

export interface ListenerEvents {
  /** Cumulative transcript of this turn (never a delta). */
  onPartial(text: string): void;
  /** Input loudness 0..1. */
  onLevel(level: number): void;
  /** The speaker started talking. */
  onSpeechStart(): void;
  /** The speaker paused long enough to end the turn. */
  onEndOfTurn(): void;
  /** The recognizer failed; the listener is already released. */
  onError(error: Error): void;
}

export interface ListenerOptions {
  /** Silence that ends the turn. */
  pauseMs: number;
  /** False: never end the turn by itself (tap to send). */
  autoEndpoint: boolean;
}

export interface Listener {
  readonly route: RecognitionRoute;
  /** End the turn and resolve the final transcript. */
  stop(): Promise<string>;
  /** Abandon the turn. */
  cancel(): void;
}

type BrowserRecognition = SpeechRecognitionLike & {
  onspeechstart?: (() => void) | null;
  onsoundstart?: (() => void) | null;
};

const asError = (value: unknown, fallback = words().recognitionFailed): Error =>
  value instanceof Error ? value : new Error(typeof value === "string" && value ? value : fallback);

/** Browser recognizers report errors as short codes. */
function browserError(code: string | undefined): Error {
  if (code === "not-allowed" || code === "service-not-allowed") {
    return new DictationError("mic_denied", words().micPermissionDenied);
  }
  if (code === "audio-capture") return new DictationError("mic_denied", words().micUnavailable);
  if (code === "network") return new DictationError("network_error", words().recognitionNetworkLost);
  if (code === "language-not-supported") return new DictationError("unsupported_language", words().recognitionLanguageUnsupported);
  return new DictationError("provider_unavailable", code ? formatVoiceString(words().recognitionFailedCode, { code }) : words().recognitionFailed);
}

function startBrowserListener(
  route: Extract<RecognitionRoute, { kind: "browser" }>,
  events: ListenerEvents,
  options: ListenerOptions,
): Listener {
  const Ctor = recognitionCtor(typeof window !== "undefined" ? window : undefined);
  if (!Ctor) throw new DictationError("provider_unavailable", words().recognitionUnsupportedBrowser);
  let finalText = "";
  let interim = "";
  let rec: BrowserRecognition | null = null;
  let stopping: ((text: string) => void) | null = null;
  let closed = false;
  let heard = false;
  let endpoint: ReturnType<typeof setTimeout> | null = null;
  let level = 0;
  let decay: ReturnType<typeof setInterval> | null = null;
  const restarts: number[] = [];
  let onDevice = route.onDevice;

  const transcript = () => {
    const text = mergeTranscript(finalText, interim);
    return route.punctuation ? applySpokenPunctuation(text, route.lang) : text;
  };

  const clearEndpoint = () => {
    if (endpoint) clearTimeout(endpoint);
    endpoint = null;
  };

  // Browser recognition exposes no audio, so recognized words stand in for
  // loudness: each result lifts the level and it relaxes between them.
  const pulse = (value: number) => {
    level = Math.max(level, value);
    events.onLevel(level);
    decay ??= setInterval(() => {
      level *= 0.8;
      if (level < 0.02) {
        level = 0;
        if (decay) clearInterval(decay);
        decay = null;
      }
      events.onLevel(level);
    }, 60);
  };

  const close = () => {
    closed = true;
    clearEndpoint();
    if (decay) clearInterval(decay);
    decay = null;
    events.onLevel(0);
    const current = rec;
    rec = null;
    if (current) {
      current.onresult = null;
      current.onerror = null;
      current.onend = null;
      current.onspeechstart = null;
      current.onsoundstart = null;
    }
    return current;
  };

  const armEndpoint = () => {
    clearEndpoint();
    if (!options.autoEndpoint || closed) return;
    // An unfinished (interim) phrase gets a little longer: the recognizer is
    // usually about to finalize it, and a cut mid-word sends half a sentence.
    const wait = interim ? options.pauseMs + 450 : options.pauseMs;
    endpoint = setTimeout(() => {
      endpoint = null;
      if (!closed && transcript().trim()) events.onEndOfTurn();
    }, wait);
  };

  const begin = () => {
    const next = new Ctor() as BrowserRecognition;
    next.lang = route.lang;
    next.continuous = true;
    next.interimResults = true;
    if (onDevice) next.processLocally = true;
    next.onresult = (event) => {
      if (closed || rec !== next) return;
      interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (result.isFinal) finalText = mergeTranscript(finalText, result[0].transcript);
        else interim = mergeTranscript(interim, result[0].transcript);
      }
      const text = transcript();
      if (!text.trim()) return;
      if (!heard) {
        heard = true;
        events.onSpeechStart();
      }
      pulse(0.9);
      events.onPartial(text);
      armEndpoint();
    };
    next.onspeechstart = () => { if (!closed && rec === next) pulse(0.5); };
    next.onerror = (event) => {
      if (closed || rec !== next) return;
      const code = event.error;
      // Silence and our own aborts are not failures: `onend` decides.
      if (code === "no-speech" || code === "aborted") return;
      if (onDevice && (code === "language-not-supported" || code === "service-not-allowed")) {
        // The on-device pack cannot serve this language; continue in the
        // browser's ordinary recognizer instead of failing the conversation.
        onDevice = false;
        return;
      }
      const current = close();
      try { current?.abort(); } catch { /* already closed */ }
      events.onError(browserError(code));
    };
    next.onend = () => {
      if (closed || rec !== next) return;
      if (stopping) {
        const resolve = stopping;
        stopping = null;
        const text = transcript();
        close();
        resolve(text);
        return;
      }
      // The recognizer ended by itself (a long silence, a platform limit).
      // Spoken words make that the end of the turn; otherwise keep listening.
      if (transcript().trim()) {
        if (options.autoEndpoint) {
          clearEndpoint();
          events.onEndOfTurn();
        } else {
          finalText = mergeTranscript(finalText, interim);
          interim = "";
          restart();
        }
        return;
      }
      restart();
    };
    rec = next;
    next.start();
  };

  const restart = () => {
    const now = Date.now();
    while (restarts.length && now - restarts[0]! > 4_000) restarts.shift();
    restarts.push(now);
    if (restarts.length > 4) {
      close();
      events.onError(new DictationError("provider_unavailable", words().recognitionKeepsStopping));
      return;
    }
    try {
      begin();
    } catch (error) {
      close();
      events.onError(asError(error));
    }
  };

  begin();

  return {
    route,
    stop() {
      if (closed) return Promise.resolve(transcript());
      clearEndpoint();
      const current = rec;
      if (!current) {
        const text = transcript();
        close();
        return Promise.resolve(text);
      }
      return new Promise<string>((resolve) => {
        stopping = resolve;
        // `stop` asks the recognizer to finalize pending words; a recognizer
        // that never reports `end` must not hang the conversation.
        setTimeout(() => {
          if (stopping !== resolve) return;
          stopping = null;
          const text = transcript();
          const leftover = close();
          try { leftover?.abort(); } catch { /* already closed */ }
          resolve(text);
        }, 1_500);
        try { current.stop(); } catch {
          stopping = null;
          const text = transcript();
          close();
          resolve(text);
        }
      });
    },
    cancel() {
      if (closed) return;
      stopping = null;
      const current = close();
      try { current?.abort(); } catch { /* already closed */ }
    },
  };
}

async function startStreamListener(
  route: Extract<RecognitionRoute, { kind: "server" | "direct" }>,
  events: ListenerEvents,
  options: ListenerOptions,
): Promise<Listener> {
  const vad = createVoiceActivityDetector({ hangoverMs: options.pauseMs });
  let text = "";
  let closed = false;
  let ended = false;
  const callbacks = {
    onPartial: (partial: string) => {
      if (closed) return;
      text = partial;
      if (partial.trim()) events.onPartial(partial);
    },
    onLevel: (rms: number) => {
      if (closed) return;
      events.onLevel(vad.level(rms));
      const change = vad.push(rms, performance.now());
      if (change === "speech-start") events.onSpeechStart();
      // Final-only providers (Whisper-compatible servers) have no partials,
      // so the pause alone ends the turn; an empty result just listens again.
      if (change === "speech-end" && options.autoEndpoint && !ended) {
        ended = true;
        events.onEndOfTurn();
      }
    },
    onError: (error: unknown) => {
      if (closed) return;
      closed = true;
      events.onLevel(0);
      events.onError(asError(error));
    },
  };
  let stream: StreamingDictation;
  if (route.kind === "direct") {
    stream = await startDirectProvider({
      provider: route.provider,
      ...(route.model ? { model: route.model } : {}),
      language: route.language,
      context: { language: route.language },
      ...callbacks,
    });
  } else {
    stream = await startStreamingDictation({
      ...(route.sessionId ? { sessionId: route.sessionId } : {}),
      language: route.language,
      ...callbacks,
    });
  }
  return {
    route,
    async stop() {
      if (closed) return text;
      closed = true;
      events.onLevel(0);
      const final = await stream.stop();
      return final.trim() ? final : text;
    },
    cancel() {
      if (closed) return;
      closed = true;
      events.onLevel(0);
      stream.cancel();
    },
  };
}

export async function startListener(
  route: RecognitionRoute,
  events: ListenerEvents,
  options: ListenerOptions,
): Promise<Listener> {
  return route.kind === "browser"
    ? startBrowserListener(route, events, options)
    : startStreamListener(route, events, options);
}
