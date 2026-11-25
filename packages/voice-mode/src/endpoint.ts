// How much silence ends a spoken turn. A fixed pause is pure delay in front of
// every reply, so the wait follows what was said: shorter after a finished
// sentence, the configured pause after words with no ending, longer after a
// phrase that plainly goes on ("…and", a comma).
//
// This reads the recognizer's own punctuation, nothing more. It is not a
// model of meaning: a finished sentence is not always a finished turn, so the
// short pause stays well above the gap people leave between two sentences
// only for "quick", and a recognizer that sends no punctuation simply keeps
// the configured pause.
import type { VoicePause } from "./prefs.ts";

export type PhraseEnding = "complete" | "question" | "open" | "continuing";

export interface PauseProfile {
  /** After a finished statement. */
  complete: number;
  /** After a question: the speaker is handing the turn over. */
  question: number;
  /** No ending yet (also every recognizer without punctuation). */
  open: number;
  /** The phrase goes on: a trailing connective, comma or filler. */
  continuing: number;
}

export const PAUSE_PROFILES: Readonly<Record<VoicePause, PauseProfile>> = {
  quick: { complete: 350, question: 320, open: 650, continuing: 1_000 },
  normal: { complete: 550, question: 450, open: 1_000, continuing: 1_500 },
  patient: { complete: 1_100, question: 1_000, open: 1_700, continuing: 2_300 },
};

/** Words a sentence does not end on: connectives, articles, prepositions and
 *  fillers. Wrongly listing a word only costs the longer pause, so the lists
 *  favour not cutting the speaker off. */
const TRAILING: Readonly<Record<string, readonly string[]>> = {
  en: ["and", "but", "or", "so", "because", "that", "which", "the", "a", "an", "to", "of", "with", "for", "if", "when", "while", "then", "um", "uh", "er", "hmm"],
  uk: ["і", "й", "та", "але", "або", "чи", "що", "щоб", "бо", "тому", "якщо", "коли", "як", "а", "в", "у", "на", "з", "із", "до", "для", "про", "від", "по", "за", "ну", "тобто", "е", "ем"],
  ru: ["и", "но", "или", "что", "чтобы", "потому", "если", "когда", "как", "а", "в", "на", "с", "к", "для", "про", "от", "по", "за", "ну", "э", "эм"],
  de: ["und", "aber", "oder", "weil", "dass", "wenn", "der", "die", "das", "ein", "eine", "zu", "mit", "für", "von", "äh", "ähm"],
  fr: ["et", "mais", "ou", "parce", "que", "qui", "le", "la", "les", "un", "une", "de", "à", "pour", "avec", "si", "euh"],
  es: ["y", "e", "pero", "o", "porque", "que", "el", "la", "los", "las", "un", "una", "de", "a", "para", "con", "si", "eh"],
  pt: ["e", "mas", "ou", "porque", "que", "o", "a", "os", "as", "um", "uma", "de", "para", "com", "se"],
  it: ["e", "ma", "o", "perché", "che", "il", "lo", "la", "i", "gli", "le", "un", "una", "di", "a", "per", "con", "se"],
  pl: ["i", "a", "ale", "lub", "albo", "bo", "że", "żeby", "który", "w", "na", "z", "do", "dla", "o", "od", "po", "za", "jeśli", "kiedy", "no"],
  bg: ["и", "но", "или", "че", "защото", "ако", "когато", "в", "на", "с", "за", "от", "до", "по"],
  ar: ["و", "لكن", "أو", "أن", "في", "من", "إلى", "على"],
};

const sets = new Map<string, ReadonlySet<string>>();

const wordSet = (key: string, languages: readonly string[]): ReadonlySet<string> => {
  let set = sets.get(key);
  if (!set) {
    set = new Set(languages.flatMap((language) => TRAILING[language] ?? []));
    sets.set(key, set);
  }
  return set;
};

/** The spoken language's words. When it is unknown ("auto"), the word's
 *  script narrows it down, and Latin script reads as English only: across all
 *  Latin languages half of the short words are someone's connective ("do",
 *  "a", "se"), and a needless long pause on every turn costs more than a
 *  missed one. */
function trailingWords(lang: string | undefined, word: string): ReadonlySet<string> {
  const primary = (lang ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  if (TRAILING[primary]) return wordSet(primary, [primary]);
  if (/\p{Script=Cyrillic}/u.test(word)) return wordSet("cyrillic", ["uk", "ru", "bg"]);
  if (/\p{Script=Arabic}/u.test(word)) return wordSet("ar", ["ar"]);
  return wordSet("en", ["en"]);
}

const CLOSERS = /["'”’»)\]]+$/u;
const LAST_WORD = /([\p{L}\p{M}\p{N}'’-]+)[^\p{L}\p{M}\p{N}]*$/u;

/** How the words so far end. */
export function phraseEnding(text: string, lang?: string): PhraseEnding {
  const trimmed = text.trim().replace(CLOSERS, "").trimEnd();
  if (!trimmed) return "open";
  // Trailing off, or stopping mid-list.
  if (/(?:\.{2,}|…|[,;:，、；：]|\s[-–—])$/u.test(trimmed)) return "continuing";
  const last = LAST_WORD.exec(trimmed)?.[1]?.toLocaleLowerCase() ?? "";
  if (last && trailingWords(lang, last).has(last)) return "continuing";
  if (/[?？]$/u.test(trimmed)) return "question";
  if (/[.!。！]$/u.test(trimmed)) return "complete";
  return "open";
}

/** The silence that ends a turn after `text`. */
export function endpointPauseMs(text: string, pause: VoicePause, lang?: string): number {
  return PAUSE_PROFILES[pause][phraseEnding(text, lang)];
}
