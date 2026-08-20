// Voice: dictation (speech→text) and read-aloud (text→speech) built on the
// browser Web Speech API — no npm deps, no audio leaves the machine beyond
// what the browser engine does. Pure helpers here; the web app owns DOM glue.
// Server-authoritative streaming dictation (WP15) lives in ./streaming.ts.

export {
  createDictationService, createChunkBuffer, DICTATION_FORMAT,
  type DictationFormat, type DictationSessionDto, type DictationChunkResult,
  type DictationService, type DictationServiceOptions,
  type SttAdapter, type SttStream, type ChunkBuffer, type BufferedChunk,
} from "./streaming.ts";
export {
  createWhisperSttAdapter, downsampleToPcm16, pcmToWav,
  type WhisperSttOptions,
} from "./whisper.ts";

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
  /** F8: dictation engine — server needs a configured STT endpoint. */
  sttEngine: VoiceEngine;
  /** F8: read-aloud engine — server needs a configured TTS endpoint. */
  ttsEngine: VoiceEngine;
  /** Playback pitch 0.5–2 (browser: utterance pitch; server: playbackRate). */
  pitch: number;
  /** Playback volume 0–1. */
  volume: number;
  /** F8: summarize long replies with the Small Model before speaking. */
  summarize: boolean;
}

export const VOICE_PREFS_KEY = "polyth.voice";

export function defaultVoicePrefs(): VoicePrefs {
  return {
    dictation: true, tts: false, lang: "en-US", rate: 1,
    sttEngine: "browser", ttsEngine: "browser", pitch: 1, volume: 1, summarize: false,
  };
}

const engineOf = (v: unknown, fallback: VoiceEngine): VoiceEngine =>
  v === "browser" || v === "server" ? v : fallback;

export function parseVoicePrefs(raw: string | null): VoicePrefs {
  const d = defaultVoicePrefs();
  try {
    const data = JSON.parse(raw ?? "") as Partial<VoicePrefs>;
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

// ---- browser feature detection (safe to call in Node: returns false) -------

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

/** SpeechRecognition constructor from a window-like object, if available. */
export function recognitionCtor(w: unknown): (new () => SpeechRecognitionLike) | null {
  const win = (w ?? {}) as SpeechWindowLike;
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as new () => SpeechRecognitionLike) : null;
}

// Minimal structural type for the Web Speech recognition object; DOM lib does
// not ship it and we only rely on these members.
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
