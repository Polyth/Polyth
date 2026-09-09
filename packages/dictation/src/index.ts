// Voice: dictation (speech→text) and read-aloud (text→speech). Browser DOM
// glue lives in widgets; server-authoritative streaming lives in streaming.ts.
import {
  DEFAULT_DICTATION_PREFERENCES,
  migrateDictationPreferences,
  type DictationLatencyPreference,
  type DictationProviderId,
  type DictationTransport,
} from "./providers.ts";

export {
  createDictationService, createChunkBuffer, DICTATION_FORMAT,
  type DictationFormat, type DictationSessionDto, type DictationChunkResult,
  type DictationService, type DictationServiceOptions,
  type SttAdapter, type SttStream, type ChunkBuffer, type BufferedChunk,
  type DictationTimingDto,
} from "./streaming.ts";
export {
  createWhisperSttAdapter, downsampleToPcm16, pcmToWav,
  type WhisperSttOptions,
} from "./whisper.ts";
export {
  createElevenLabsSttAdapter,
  type ElevenLabsSttOptions,
} from "./elevenlabs.ts";
export {
  createLocalModelManager,
  localModelCatalog,
  type LocalModelDescriptor,
  type LocalModelManager,
  type LocalModelState,
  type LocalModelStatus,
} from "./localModels.ts";
export * from "./providers.ts";
export * from "./wire.ts";

export type VoiceEngine = "browser" | "server";

export interface VoicePrefs {
  /** Show the mic button and allow dictation. */
  dictation: boolean;
  /** Read completed assistant replies aloud. */
  tts: boolean;
  /** BCP-47 recognition + speech language, e.g. "en-US". */
  lang: string;
  /** Speech rate 0.5–2. */
  rate: number;
  /** Preferred speechSynthesis voice name. */
  voice?: string;
  /** Compatibility placement switch; provider/transport own new STT routing. */
  sttEngine: VoiceEngine;
  /** Read-aloud engine. */
  ttsEngine: VoiceEngine;
  pitch: number;
  volume: number;
  summarize: boolean;
  /** Provider-neutral realtime dictation preferences. */
  dictationProvider: DictationProviderId;
  dictationTransport: DictationTransport;
  dictationModel?: string;
  localModel?: string;
  contextInjection: boolean;
  cloudFallback: boolean;
  latencyPreference: DictationLatencyPreference;
}

export const VOICE_PREFS_KEY = "polyth.voice";

export function defaultVoicePrefs(): VoicePrefs {
  return {
    dictation: true,
    tts: false,
    lang: "en-US",
    rate: 1,
    // Prefer the server/provider path for new profiles. The mic control already
    // falls back to Web Speech when the server truthfully reports unavailable.
    sttEngine: "server",
    ttsEngine: "browser",
    pitch: 1,
    volume: 1,
    summarize: false,
    dictationProvider: DEFAULT_DICTATION_PREFERENCES.provider,
    dictationTransport: DEFAULT_DICTATION_PREFERENCES.transport,
    contextInjection: DEFAULT_DICTATION_PREFERENCES.contextInjection,
    cloudFallback: DEFAULT_DICTATION_PREFERENCES.cloudFallback,
    latencyPreference: DEFAULT_DICTATION_PREFERENCES.latencyPreference,
  };
}

const engineOf = (v: unknown, fallback: VoiceEngine): VoiceEngine =>
  v === "browser" || v === "server" ? v : fallback;

export function parseVoicePrefs(raw: string | null): VoicePrefs {
  const d = defaultVoicePrefs();
  try {
    const data = JSON.parse(raw ?? "") as Partial<VoicePrefs> & Record<string, unknown>;
    const dictation = migrateDictationPreferences({
      ...data,
      provider: data.dictationProvider,
      transport: data.dictationTransport,
      model: data.dictationModel,
      language: data.lang,
    });
    return {
      dictation: typeof data.dictation === "boolean" ? data.dictation : d.dictation,
      tts: typeof data.tts === "boolean" ? data.tts : d.tts,
      lang: typeof data.lang === "string" && data.lang ? data.lang : d.lang,
      rate: typeof data.rate === "number" && data.rate >= 0.5 && data.rate <= 2 ? data.rate : d.rate,
      ...(typeof data.voice === "string" && data.voice ? { voice: data.voice } : {}),
      sttEngine: engineOf(data.sttEngine, d.sttEngine),
      ttsEngine: engineOf(data.ttsEngine, d.ttsEngine),
      pitch: typeof data.pitch === "number" && data.pitch >= 0.5 && data.pitch <= 2 ? data.pitch : d.pitch,
      volume: typeof data.volume === "number" && data.volume >= 0 && data.volume <= 1 ? data.volume : d.volume,
      summarize: typeof data.summarize === "boolean" ? data.summarize : d.summarize,
      dictationProvider: dictation.provider,
      dictationTransport: dictation.transport,
      ...(dictation.model ? { dictationModel: dictation.model } : {}),
      ...(dictation.localModel ? { localModel: dictation.localModel } : {}),
      contextInjection: dictation.contextInjection,
      cloudFallback: dictation.cloudFallback,
      latencyPreference: dictation.latencyPreference,
    };
  } catch {
    return d;
  }
}

export function serializeVoicePrefs(p: VoicePrefs): string {
  return JSON.stringify(p);
}

/** Append a finalized recognition chunk with sane single-space joining. */
export function mergeTranscript(current: string, chunk: string): string {
  const next = chunk.trim();
  if (!next) return current;
  if (!current) return next;
  return `${current.replace(/\s+$/, "")} ${next}`;
}

/** Strip markdown noise so read-aloud doesn't spell out syntax. */
export function speakableText(markdown: string, maxChars = 2000): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " image ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

interface SpeechWindowLike {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  speechSynthesis?: unknown;
}

export function speechSupport(w: unknown): { stt: boolean; tts: boolean } {
  const win = (w ?? {}) as SpeechWindowLike;
  return {
    stt: typeof win.SpeechRecognition === "function" || typeof win.webkitSpeechRecognition === "function",
    tts: typeof win.speechSynthesis === "object" && win.speechSynthesis !== null,
  };
}

export function recognitionCtor(w: unknown): (new () => SpeechRecognitionLike) | null {
  const win = (w ?? {}) as SpeechWindowLike;
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as new () => SpeechRecognitionLike) : null;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
