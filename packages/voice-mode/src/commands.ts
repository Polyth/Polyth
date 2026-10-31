// Spoken commands. A command acts at once instead of being sent as a message:
// "stop" stops the agent's turn, "send now" delivers immediately (what was
// just said, or the queued messages), "send" ends a turn by voice and
// "cancel" discards it. Phrases are configurable per command; the defaults
// cover English and the UI/recognition language.

export type VoiceCommandId = "stop" | "sendNow" | "send" | "cancel";

export const VOICE_COMMAND_IDS: readonly VoiceCommandId[] = ["stop", "sendNow", "send", "cancel"];

export type VoiceCommandPhrases = Readonly<Record<VoiceCommandId, readonly string[]>>;

/** Commands that may close a longer utterance ("fix the test, send now").
 *  "stop" only counts on its own: "please don't stop" is a message. */
const TRAILING: ReadonlySet<VoiceCommandId> = new Set(["sendNow", "send", "cancel"]);

const DEFAULTS: Readonly<Record<string, VoiceCommandPhrases>> = {
  en: {
    stop: ["stop", "stop it", "stop now"],
    sendNow: ["send now", "send it now", "send immediately"],
    send: ["send", "send it"],
    cancel: ["cancel", "cancel that", "scratch that", "never mind"],
  },
  uk: {
    stop: ["стоп", "зупинись", "зупинити", "зупини", "припини"],
    sendNow: ["надіслати зараз", "надішли зараз", "надішли вже", "відправити вже", "відправ вже", "відправити зараз", "відправ зараз"],
    send: ["надіслати", "надішли", "відправити", "відправ"],
    cancel: ["скасувати", "скасуй", "відміна", "відмінити"],
  },
  de: {
    stop: ["stopp", "stop", "halt", "anhalten"],
    sendNow: ["jetzt senden", "sofort senden"],
    send: ["senden", "abschicken"],
    cancel: ["abbrechen", "vergiss es"],
  },
  fr: {
    stop: ["stop", "arrête", "arrêter"],
    sendNow: ["envoie maintenant", "envoyer maintenant"],
    send: ["envoie", "envoyer"],
    cancel: ["annule", "annuler", "laisse tomber"],
  },
  pl: {
    stop: ["stop", "zatrzymaj", "przestań"],
    sendNow: ["wyślij teraz", "wyślij od razu"],
    send: ["wyślij"],
    cancel: ["anuluj", "nieważne"],
  },
  pt: {
    stop: ["parar", "para", "pare"],
    sendNow: ["enviar agora", "envia agora", "envie agora"],
    send: ["enviar", "envia", "envie"],
    cancel: ["cancelar", "cancela", "esquece"],
  },
  it: {
    stop: ["stop", "fermati", "ferma"],
    sendNow: ["invia ora", "invia subito", "manda ora"],
    send: ["invia", "manda"],
    cancel: ["annulla", "lascia perdere"],
  },
  es: {
    stop: ["para", "detente", "alto", "stop"],
    sendNow: ["envía ahora", "enviar ahora", "manda ahora"],
    send: ["envía", "enviar", "manda"],
    cancel: ["cancela", "cancelar", "olvídalo"],
  },
  zh: {
    stop: ["停", "停止", "停下"],
    sendNow: ["立即发送", "马上发送", "现在发送"],
    send: ["发送"],
    cancel: ["取消", "算了"],
  },
  bg: {
    stop: ["стоп", "спри", "спрете"],
    sendNow: ["изпрати сега", "изпрати веднага"],
    send: ["изпрати"],
    cancel: ["отказ", "откажи"],
  },
  ar: {
    stop: ["توقف", "قف"],
    sendNow: ["أرسل الآن", "ارسل الآن"],
    send: ["أرسل", "ارسل"],
    cancel: ["إلغاء", "الغاء"],
  },
};

const language = (tag: string): string => tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";

/** Compare spoken words, not punctuation, case or spacing. */
export function normalizeSpoken(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Comma- or newline-separated phrases as typed in settings. */
export function parsePhraseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n;]/)) {
    const phrase = raw.trim();
    const key = normalizeSpoken(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out;
}

/** The default phrases for these languages (English always included). */
export function defaultCommandPhrases(languages: readonly string[]): VoiceCommandPhrases {
  const tags = [...new Set([...languages.map(language), "en"])];
  const merged = {} as Record<VoiceCommandId, string[]>;
  for (const id of VOICE_COMMAND_IDS) {
    merged[id] = parsePhraseList(tags.flatMap((tag) => DEFAULTS[tag]?.[id] ?? []).join(","));
  }
  return merged;
}

/** Custom phrases replace a command's defaults; an empty list turns it off. */
export function resolveCommandPhrases(
  custom: Partial<Record<VoiceCommandId, readonly string[]>>,
  languages: readonly string[],
): VoiceCommandPhrases {
  const defaults = defaultCommandPhrases(languages);
  const resolved = {} as Record<VoiceCommandId, readonly string[]>;
  for (const id of VOICE_COMMAND_IDS) resolved[id] = custom[id] ?? defaults[id];
  return resolved;
}

export interface VoiceCommandMatch {
  command: VoiceCommandId;
  /** What was said before a trailing command, punctuation trimmed. */
  rest: string;
}

const HAN = /\p{Script=Han}/u;
const trimEdge = (text: string) => text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");

/** Drop the trailing phrase from the original wording. */
function withoutTrailing(original: string, phrase: string): string {
  const text = trimEdge(original);
  if (HAN.test(phrase) && !phrase.includes(" ")) {
    // No word spaces: remove the phrase's characters from the end.
    let cut = text.length;
    let matched = 0;
    while (cut > 0 && matched < phrase.length) {
      cut--;
      if (!/[\p{P}\s]/u.test(text[cut]!)) matched++;
    }
    return trimEdge(text.slice(0, cut));
  }
  const words = text.split(/\s+/);
  return trimEdge(words.slice(0, Math.max(0, words.length - phrase.split(" ").length)).join(" "));
}

/** Find a command in an utterance: the whole utterance, or a trailing
 *  command after other words. The longest matching phrase wins. */
export function matchVoiceCommand(text: string, phrases: VoiceCommandPhrases): VoiceCommandMatch | null {
  const spoken = normalizeSpoken(text);
  if (!spoken) return null;
  const candidates: Array<{ command: VoiceCommandId; phrase: string }> = [];
  for (const command of VOICE_COMMAND_IDS) {
    for (const raw of phrases[command]) {
      const phrase = normalizeSpoken(raw);
      if (phrase) candidates.push({ command, phrase });
    }
  }
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const { command, phrase } of candidates) {
    if (spoken === phrase) return { command, rest: "" };
  }
  for (const { command, phrase } of candidates) {
    if (!TRAILING.has(command)) continue;
    const joined = HAN.test(phrase) && !phrase.includes(" ");
    if (joined ? spoken.endsWith(phrase) && spoken.length > phrase.length : spoken.endsWith(` ${phrase}`)) {
      const rest = withoutTrailing(text, phrase);
      if (rest) return { command, rest };
    }
  }
  return null;
}
