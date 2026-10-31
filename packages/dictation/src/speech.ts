// Browser-safe speech helpers shared by read-aloud, dictation and voice mode.
// Everything here is pure: no DOM, audio or network access, so the timing and
// text rules are testable without a browser.

// ---------------------------------------------------------------------------
// Streaming speakable text
// ---------------------------------------------------------------------------

export interface SpeakableStreamOptions {
  /** Spoken once in place of each fenced code block; empty skips it silently. */
  codePlaceholder?: string;
  /** Spoken once in place of each table; empty skips it silently. */
  tablePlaceholder?: string;
  /** Later chunks are merged up to at least this length (fewer, smoother
   *  utterances). The first chunk is released as soon as one sentence ends so
   *  speech can start while the reply is still streaming. */
  minChars?: number;
  /** A sentence longer than this is split at the last comma/space before it. */
  maxChars?: number;
}

export interface SpeakableStream {
  /** Feed the next markdown delta; returns chunks that are ready to speak. */
  push(delta: string): string[];
  /** The source is complete; returns every remaining chunk. */
  flush(): string[];
  /** Forget all buffered text (a new reply). */
  reset(): void;
}

const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// Words whose trailing dot is not a sentence end ("e.g. this", "Dr. Smith").
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
  "no", "fig", "approx", "cf", "al", "inc", "ltd", "co", "dept", "est",
]);

/** Strip inline markdown from one line of prose. */
export function speakableLine(line: string): string {
  return line
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, " link ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

const endsSentence = (text: string): boolean => /[.!?…。！？:;]["'”’)\]]*$/.test(text);

/** Indexes just past each sentence boundary in `text`. A boundary is terminal
 *  punctuation followed by whitespace (or a CJK full stop), excluding known
 *  abbreviations and single initials ("J. Smith"). */
export function sentenceBoundaries(text: string): number[] {
  const out: number[] = [];
  const pattern = /([.!?…]+["'”’)\]]*)(\s+)|([。！？]+)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[3]) { out.push(match.index + match[0].length); continue; }
    const word = /([A-Za-z.]+)$/.exec(text.slice(0, match.index))?.[1]?.toLowerCase() ?? "";
    if (match[1]!.startsWith(".") && (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word))) continue;
    out.push(match.index + match[1]!.length + match[2]!.length);
  }
  return out;
}

/** Split prose into sentences (complete text, nothing held back). */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const boundary of sentenceBoundaries(text)) {
    const sentence = text.slice(from, boundary).trim();
    if (sentence) out.push(sentence);
    from = boundary;
  }
  const tail = text.slice(from).trim();
  if (tail) out.push(tail);
  return out;
}

/** Split an over-long sentence at the last natural pause before `max`. */
function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "), window.lastIndexOf(" — "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function createSpeakableStream(options: SpeakableStreamOptions = {}): SpeakableStream {
  const minChars = Math.max(1, options.minChars ?? 80);
  const maxChars = Math.max(40, options.maxChars ?? 260);
  let raw = "";
  let inFence = false;
  let inTable = false;
  let started = false;
  /** Complete sentences not yet released (merged up to minChars). */
  let held: string[] = [];

  const join = (parts: readonly string[]): string => parts
    .map((part, index) => index < parts.length - 1 && !endsSentence(part) ? `${part}.` : part)
    .join(" ");

  const release = (sentences: readonly string[], final: boolean): string[] => {
    const out: string[] = [];
    for (const sentence of sentences) {
      for (const piece of splitLong(sentence, maxChars)) {
        held.push(piece);
        const text = join(held);
        // Speech starts on the first sentence; later ones gather into
        // utterances of a comfortable length.
        if (!started || text.length >= minChars) {
          out.push(text);
          held = [];
          started = true;
        }
      }
    }
    if (final && held.length) {
      out.push(join(held));
      held = [];
      started = true;
    }
    return out;
  };

  /** One complete source line → zero or more speakable units. */
  const line = (source: string): string[] => {
    if (FENCE.test(source)) {
      inFence = !inFence;
      inTable = false;
      return inFence && options.codePlaceholder ? [options.codePlaceholder] : [];
    }
    if (inFence) return [];
    if (TABLE_ROW.test(source) || TABLE_RULE.test(source)) {
      if (inTable) return [];
      inTable = true;
      return options.tablePlaceholder ? [options.tablePlaceholder] : [];
    }
    inTable = false;
    const text = speakableLine(source);
    return text ? sentencesOf(text) : [];
  };

  return {
    push(delta) {
      raw += delta;
      const sentences: string[] = [];
      for (let newline = raw.indexOf("\n"); newline >= 0; newline = raw.indexOf("\n")) {
        sentences.push(...line(raw.slice(0, newline)));
        raw = raw.slice(newline + 1);
      }
      // The unfinished line may already hold complete sentences. Lines that
      // could still turn out to be a fence or a table row wait for their end.
      if (!inFence && raw && !/^\s*(`|~|\|)/.test(raw)) {
        const boundary = sentenceBoundaries(raw).at(-1) ?? -1;
        if (boundary > 0) {
          const text = speakableLine(raw.slice(0, boundary));
          if (text) sentences.push(...sentencesOf(text));
          raw = raw.slice(boundary);
        }
      }
      return release(sentences, false);
    },
    flush() {
      const sentences = raw ? line(raw) : [];
      raw = "";
      inFence = false;
      inTable = false;
      return release(sentences, true);
    },
    reset() {
      raw = "";
      inFence = false;
      inTable = false;
      started = false;
      held = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Browser voice ranking
// ---------------------------------------------------------------------------

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
  voiceURI?: string;
}

// macOS ships novelty and legacy voices that are never what anyone wants for a
// conversation; they stay selectable by name but never win automatically.
const NOVELTY_VOICES = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|fred|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy)\b/i;

const normLang = (lang: string): string => lang.replace(/_/g, "-").toLowerCase();

/** Higher is better; -Infinity means the voice cannot speak `lang`. */
export function scoreVoice(voice: VoiceLike, lang: string): number {
  const want = normLang(lang);
  const have = normLang(voice.lang || "");
  const wantBase = want.split("-")[0]!;
  const haveBase = have.split("-")[0]!;
  let score: number;
  if (have === want) score = 100;
  else if (haveBase === wantBase) score = 60;
  else return Number.NEGATIVE_INFINITY;
  const name = voice.name;
  if (/\b(natural|neural)\b/i.test(name)) score += 45;
  if (/\bpremium\b/i.test(name)) score += 40;
  if (/\benhanced\b/i.test(name)) score += 32;
  if (/\bsiri\b/i.test(name)) score += 28;
  if (/\bgoogle\b/i.test(name)) score += 22;
  if (/\bonline\b/i.test(name)) score += 8;
  if (voice.localService === false) score += 4;
  if (voice.default) score += 3;
  if (/\bcompact\b/i.test(name)) score -= 20;
  if (/espeak|\bmbrola\b/i.test(name)) score -= 50;
  if (NOVELTY_VOICES.test(name) && !/\b(natural|neural|premium|enhanced)\b/i.test(name)) score -= 80;
  return score;
}

/** Voices able to speak `lang`, best first. */
export function rankVoices<V extends VoiceLike>(voices: readonly V[], lang: string): V[] {
  return voices
    .map((voice, index) => ({ voice, index, score: scoreVoice(voice, lang) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.voice);
}

/** The explicitly chosen voice when it exists, otherwise the best voice for
 *  `lang`, otherwise null (the engine's default voice). */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: string, preferred?: string): V | null {
  if (preferred) {
    const chosen = voices.find((voice) => voice.name === preferred);
    if (chosen) return chosen;
  }
  return rankVoices(voices, lang)[0] ?? null;
}

/** Plain-language quality tier for a voice picker. */
export function voiceTier(voice: VoiceLike): "natural" | "enhanced" | "standard" {
  if (/\b(natural|neural|premium|siri)\b/i.test(voice.name)) return "natural";
  if (/\b(enhanced|google)\b/i.test(voice.name)) return "enhanced";
  return "standard";
}

// ---------------------------------------------------------------------------
// Spoken punctuation (dictation)
// ---------------------------------------------------------------------------

const SPOKEN_EN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\s*\bnew paragraph\b\s*/gi, "\n\n"],
  [/\s*\bnew ?line\b\s*/gi, "\n"],
  [/\s*\b(?:question mark)\b/gi, "?"],
  [/\s*\b(?:exclamation (?:mark|point))\b/gi, "!"],
  [/\s*\b(?:full stop|period)\b/gi, "."],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bsemicolon\b/gi, ";"],
  [/\s*\bcolon\b/gi, ":"],
];

/** Apply English spoken-punctuation commands ("comma", "new line", …) to a
 *  recognizer transcript. Other languages pass through unchanged: their
 *  recognizers either punctuate natively or use different command words. The
 *  transform is deterministic, so a cumulative transcript can be re-applied on
 *  every interim update without drifting. */
export function applySpokenPunctuation(text: string, lang: string): string {
  const base = normLang(lang || "").split("-")[0];
  if (base !== "en" && base !== "auto" && base !== "") return text;
  let out = text;
  for (const [pattern, replacement] of SPOKEN_EN) out = out.replace(pattern, replacement);
  out = out
    // "word ." → "word." and no doubled marks from "period period".
    .replace(/[ \t]+([,.;:?!])/g, "$1")
    .replace(/([,.;:?!])(?:[ \t]*\1)+/g, "$1")
    // Capitalize after a sentence end or a line break.
    .replace(/([.?!]\s+|\n\s*)([a-z])/g, (_m, lead: string, letter: string) => lead + letter.toUpperCase())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
  return out.trim() ? out.replace(/^[ \t]+|[ \t]+$/g, "") : "";
}

// ---------------------------------------------------------------------------
// Voice activity detection
// ---------------------------------------------------------------------------

export interface VoiceActivityOptions {
  /** Absolute RMS below which nothing counts as speech, however quiet the room. */
  minSpeechRms?: number;
  /** Speech must exceed the noise floor by this factor. */
  speechRatio?: number;
  /** Continuous speech needed before `speech-start` (ignores clicks/taps). */
  onsetMs?: number;
  /** Silence needed after speech before `speech-end` (the turn is over). */
  hangoverMs?: number;
  /** Noise floor used before any measurement. */
  initialFloor?: number;
  /** The first measurements after start/reset only learn the room. */
  calibrationMs?: number;
}

export type VoiceActivityEvent = "speech-start" | "speech-end";

export interface VoiceActivityDetector {
  /** Feed one RMS measurement taken at `now` (ms). */
  push(rms: number, now: number): VoiceActivityEvent | null;
  readonly speaking: boolean;
  readonly floor: number;
  /** Perceptual 0..1 loudness relative to the current noise floor. */
  level(rms: number): number;
  /** Change the hangover (e.g. a shorter pause ends a turn while the
   *  assistant waits, a longer one while the user is mid-thought). */
  setHangover(ms: number): void;
  reset(): void;
}

/** Energy VAD with an adaptive noise floor. Good enough to end a spoken turn
 *  on a pause and to notice speech over playback; it is not a speech/noise
 *  classifier, so callers keep explicit controls (tap to send, mute). */
export function createVoiceActivityDetector(options: VoiceActivityOptions = {}): VoiceActivityDetector {
  const minSpeechRms = options.minSpeechRms ?? 0.018;
  const ratio = options.speechRatio ?? 2.6;
  const onsetMs = options.onsetMs ?? 140;
  let hangoverMs = options.hangoverMs ?? 900;
  const initialFloor = options.initialFloor ?? 0.006;
  const calibrationMs = options.calibrationMs ?? 240;
  let floor = initialFloor;
  let calibrationStart: number | null = null;
  let calibrationSum = 0;
  let calibrationCount = 0;
  let speaking = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;

  const threshold = () => Math.max(minSpeechRms, floor * ratio);

  return {
    push(rms, now) {
      calibrationStart ??= now;
      if (now - calibrationStart < calibrationMs) {
        // Speech rarely starts within the first moments; treat them as room
        // tone so steady noise (a fan, a car) is not mistaken for a voice.
        calibrationSum += Math.min(rms, 0.1);
        calibrationCount++;
        floor = Math.max(0.0005, calibrationSum / calibrationCount);
        return null;
      }
      const loud = rms >= threshold();
      // The floor follows the room only while nobody is talking, quickly
      // downward (a door closed) and slowly upward (a fan started).
      if (!speaking && !loud) {
        floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.97 + rms * 0.03;
        floor = Math.max(0.0005, Math.min(floor, 0.2));
      }
      if (loud) {
        belowSince = null;
        aboveSince ??= now;
        if (!speaking && now - aboveSince >= onsetMs) {
          speaking = true;
          return "speech-start";
        }
        return null;
      }
      aboveSince = null;
      if (!speaking) return null;
      belowSince ??= now;
      if (now - belowSince >= hangoverMs) {
        speaking = false;
        belowSince = null;
        return "speech-end";
      }
      return null;
    },
    get speaking() { return speaking; },
    get floor() { return floor; },
    level(rms) {
      const low = floor * 1.4;
      const high = Math.max(threshold() * 4, 0.16);
      return Math.max(0, Math.min(1, (rms - low) / (high - low)));
    },
    setHangover(ms) { hangoverMs = Math.max(200, ms); },
    reset() {
      floor = initialFloor;
      calibrationStart = null;
      calibrationSum = 0;
      calibrationCount = 0;
      speaking = false;
      aboveSince = null;
      belowSince = null;
    },
  };
}
