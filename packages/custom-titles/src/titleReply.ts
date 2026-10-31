// Turns whatever a title generator answered into a session title, or says why
// it cannot. Weak and agent-tuned models wrap the answer in reasoning blocks,
// XML/JSON, labels and chatter, so the title is *found* in the reply rather
// than the reply being trusted to be the title. A reply that holds no title
// (tool-call markup, prose, code, an echoed example) is refused, never clipped.

export const CUSTOM_TITLE_MAX_CHARS = 96;
// A reply this long is not a title reply, whatever it holds; the CLI adapters
// already cap output at 128 KB, so this also bounds the work spent on it.
const MAX_REPLY_CHARS = 64 * 1024;
const MAX_LINE_CHARS = 400;

export type TitleRejection = "empty" | "reasoning" | "markup" | "code" | "chatter" | "prose" | "echo";

export type GeneratedTitle = { title: string } | { rejected: TitleRejection };

// Few-shot pairs the prompt shows the model. Rare topics on purpose: a model
// copies an example whose subject resembles the message, and a repeated example
// title is refused as an echo unless the message is about it.
export const TITLE_EXAMPLES = [
  { message: "the cron job runs twice every night, find out why", en: "Cron job runs twice nightly", uk: "Cron-завдання запускається двічі щоночі" },
  { message: "Додай експорт звіту у CSV", en: "Add CSV report export", uk: "Експорт звіту у CSV" },
  { message: "how do I rotate API keys without downtime?", en: "Rotating API keys without downtime", uk: "Ротація API-ключів без простою" },
] as const;

const EXAMPLE_TITLES: ReadonlySet<string> = new Set(
  TITLE_EXAMPLES.flatMap((example) => [example.en, example.uk].map((title) => title.toLowerCase())),
);

// An example's title is an echo only when the message is not about it: a job
// that runs twice a night can truly be titled "Cron job runs twice nightly".
const echoesExample = (title: string, message: string | undefined): boolean => {
  if (!EXAMPLE_TITLES.has(title.toLowerCase())) return false;
  if (message === undefined) return true;
  const text = message.toLowerCase();
  return !(title.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).some((word) => text.includes(word));
};

const ANSI_ESCAPES = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
const INVISIBLE = /[​-‍⁠﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const REASONING_TAG = /<(\/?)(?:think(?:ing)?|thought|reasoning|reflection|scratchpad|analysis|antthinking)\b[^>]*>/gi;

// A model that wraps its answer in a tag means that as the answer; whatever
// surrounds it is explanation.
const ANSWER_OPEN = /<(title|session[_-]?title|answer|final(?:[_-]?answer)?|output|result|response|reply)\b[^>]*>/i;
const INLINE_TAG = /<\/?(?:title|session[_-]?title|answer|final(?:[_-]?answer)?|output|result|response|reply|name|headline|heading|summary|text|content|b|i|u|em|strong|code|span|a)\b[^>]*>/gi;
const BLOCK_TAG = /<\/?(?:p|br|div|li|ul|ol|pre|blockquote|h[1-6])\b[^>]*>/gi;

// Tool-call or special-token markup (`<tool_call>`, `<function=…>`, `<|im_start|>`)
// means an agent-style model ignored the title prompt, so none of its reply is
// trusted. Observed from commandcode/xiaomi/mimo-v2.5-pro through `pi -p --no-tools`:
// "Let me explore the project structure first.<tool_call>" became a final title.
// ponytail: any tag is refused, so a title naming `<Select>` falls back to the
// native/prompt title; narrow to tool/function/think names if that ever bites.
const MODEL_MARKUP = /<\/?[a-z|\u{FF5C}][^<>\n]*>/iu;

const FENCE = /```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
const PLAIN_FENCE = /^(?:|text|txt|plain|plaintext|markdown|md|title|json)$/i;

const TITLE_KEYS = ["title", "session_title", "sessionTitle", "name", "headline", "heading", "summary"] as const;

const LIST_MARKER = /^(?:[-*•–—+>]\s+|#{1,6}\s+|\d{1,2}[.)]\s+)+/;
// "Title: X", `"title": "X"`, "Session title (English) - X", "Назва: X". A hyphen
// only counts after a space, so "Title-case headings" stays a title.
const LABEL = new RegExp([
  "^[\"“]?(?:(?:suggested|proposed|new|session|chat|conversation|final|best|generated|short)\\s+)*(?:title|name|heading|headline|subject)[\"”]?(?:\\s*\\([^)\\n]*\\))?(?:\\s*[:：]|\\s+[—–-])\\s*",
  "^(?:нова\\s+|запропонована\\s+)?(?:назва|заголовок|тема)(?:\\s+(?:сесії|чату|розмови))?(?:\\s*[:：]|\\s+[—–-])\\s*",
  "^(?:название|заголовок)(?:\\s*[:：]|\\s+[—–-])\\s*",
].join("|"), "iu");

const INTERJECTION = /^(?:sure|certainly|of course|absolutely|okay|ok|alright|great|yes|yeah|звісно|звичайно|добре|гаразд)[,.!:]+\s+/iu;
// First-person, apologetic or narrating openers: the model is talking, not titling.
const CHATTER = new RegExp(`^(?:${[
  "(?:sure|certainly|of course|absolutely|okay|ok|alright|great|yes|yeah|no)[,.!:]",
  "here(?:'s| is| are)\\b",
  "i(?:'ll| will| can|'m| am|'d| would| cannot| can't| don't| do not| need| think| believe| suggest| recommend)\\b",
  "let me\\b",
  "as an ai\\b",
  "(?:i'm |i am )?sorry\\b",
  "unfortunately\\b",
  "apologies\\b",
  "(?:could|can|would|will) you\\b",
  "please (?:provide|share|specify|clarify|tell|give)\\b",
  "it (?:looks|seems|appears)\\b",
  "(?:looking|based) (?:at|on)\\b",
  "(?:first|so|well|now|hmm)[,:]",
  "(?:so|well|now|then|right|okay|alright)\\s+(?:the|this|that|i|we|it|they|you)\\b",
  "(?:basically|essentially|actually|honestly)(?=[\\s,])",
  "this (?:is|looks|seems)\\b",
  "the (?:user|message|request|session|conversation) (?:is|wants|asks|wanted|asked|has|needs|says|seems)\\b",
  "(?:the|a) (?:good |best |suitable )?title (?:is|would|could|might|should)\\b",
  "title (?:for|of) (?:this|the|your)\\b",
  "to (?:title|name|summari[sz]e|generate|create|write) (?:this|the|a)\\b",
  "(?:отже|тож|ну)[,:]",
  "(?:звісно|звичайно|добре|гаразд)[,.!:]",
  "(?:ось|вибач\\p{L}*|дякую|на жаль|я\\s+(?:можу|не можу|буду|пропоную|думаю|вважаю))(?![\\p{L}\\p{N}])",
].join("|")})`, "iu");

// A clipped title must not end on a dangling connective ("…after a").
const TRAILING_CONNECTIVE = /(?:\s+(?:a|an|the|of|to|in|on|at|for|with|and|or|but|after|before|when|that|which|from|by|as|is|are|if|в|у|на|з|із|до|і|й|та|а|але|що|як|чи|по|за|від|для)(?![\p{L}\p{N}]))+$/iu;

const OPENING_QUOTES = /^["“«„]/;
const CLOSING_QUOTES = /["”»]$/;
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"', "“": "”", "‘": "’", "'": "'", "`": "`", "«": "»", "„": "“", "「": "」",
};

// One pass, so a reply made of thousands of tags costs no more than its length.
const withoutReasoning = (text: string): string => {
  let out = "";
  let from = 0;
  let depth = 0;
  for (const tag of text.matchAll(REASONING_TAG)) {
    if (tag[1] !== "/") {
      if (depth++ === 0) out += text.slice(from, tag.index);
    } else if (depth > 0) {
      if (--depth === 0) from = tag.index + tag[0].length;
    } else {
      // Some servers strip the opening tag: everything before a stray close was thinking.
      out = "";
      from = tag.index + tag[0].length;
    }
  }
  // A block that never closed swallowed the answer: the budget ran out thinking.
  return depth === 0 ? out + text.slice(from) : out;
};

const answerElement = (text: string): string | undefined => {
  const open = ANSWER_OPEN.exec(text);
  if (!open) return undefined;
  const from = open.index + open[0].length;
  const close = new RegExp(`</${open[1]}\\s*>`, "i").exec(text.slice(from));
  return close ? text.slice(from, from + close.index) : undefined;
};

const titleOfJson = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return value.map(titleOfJson).find(Boolean);
  if (value && typeof value === "object") {
    for (const key of TITLE_KEYS) {
      const found = titleOfJson((value as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return undefined;
};

/** undefined: not JSON. null: JSON that carries no title. */
const jsonTitle = (text: string): string | null | undefined => {
  const trimmed = text.trim();
  if (!/^(?:\{|\[\s*["{[])/.test(trimmed)) return undefined;
  try {
    return titleOfJson(JSON.parse(trimmed)) ?? null;
  } catch {
    // Cut off or followed by prose: the title field can still be intact.
    const loose = /"(?:title|session_title|name|headline|heading|summary)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/i.exec(trimmed);
    return loose ? loose[1]!.replace(/\\(.)/g, "$1").trim() || null : null;
  }
};

const cleanLine = (raw: string): string => {
  let line = raw.replace(/\*\*/g, "").trim().replace(LIST_MARKER, "").trim();
  // Emphasis or inline code wrapped around the whole line.
  for (let wrapped = /^(\*|_|~~|`)((?:(?!\1).)+)\1$/.exec(line); wrapped; wrapped = /^(\*|_|~~|`)((?:(?!\1).)+)\1$/.exec(line)) {
    line = wrapped[2]!.trim();
  }
  return line;
};

interface Candidate { text: string; labelled: boolean }

const candidatesOf = (text: string): Candidate[] => {
  const out: Candidate[] = [];
  for (const raw of text.split("\n")) {
    let line = cleanLine(raw).replace(INTERJECTION, "");
    if (!line) continue;
    const label = LABEL.exec(line);
    if (label) {
      line = line.slice(label[0].length).trim();
      if (line) out.push({ text: line, labelled: true });
      continue;
    }
    if (/[:：]$/.test(line)) continue; // "Here is a title:" introduces the answer
    if (CHATTER.test(line)) {
      // "Here is a title: Fix login" still carries one after the colon.
      const colon = line.search(/[:：]/);
      const rest = colon > 0 ? line.slice(colon + 1).trim() : "";
      if (rest && !CHATTER.test(rest)) out.push({ text: rest, labelled: true });
      continue;
    }
    out.push({ text: line, labelled: false });
  }
  return out;
};

const unquote = (value: string): string => {
  let out = value;
  // `"Fix login" - this names the issue`: the quoted part is the title.
  const quoted = /^["“«„]([^"“”«»„\n]{2,})["”»]\s*(?:[-–—:(,]\s|$)/.exec(out);
  if (quoted) out = quoted[1]!.trim();
  for (let close = QUOTE_PAIRS[out[0] ?? ""]; close && out.length > 2 && out.at(-1) === close; close = QUOTE_PAIRS[out[0] ?? ""]) {
    out = out.slice(1, -1).trim();
  }
  // A quote the model opened or closed without its partner. An opening mark
  // with nothing after it, or a closing one with nothing before it, is never part of a title.
  for (let before = ""; before !== out;) {
    before = out;
    if (/[“„«「‘]$/.test(out) || (CLOSING_QUOTES.test(out) && !/["“«„]/.test(out.slice(0, -1)))) out = out.slice(0, -1).trim();
    if (/^[”»」’]/.test(out) || (OPENING_QUOTES.test(out) && !/["”»“]/.test(out.slice(1)))) out = out.slice(1).trim();
  }
  return out;
};

const tidy = (value: string): string => {
  const text = value.replace(/^[\s\-–—:]+/, "").replace(LIST_MARKER, "").trim();
  return /(?:\.{3}|…)$/.test(text) ? text : text.replace(/[.,;:!]+$/, "").trim();
};

const finalize = (value: string, message: string | undefined): GeneratedTitle => {
  // Quotes and sentence punctuation hide each other (`"Fix login."`): settle both.
  let title = tidy(value.replace(/\s+/g, " "));
  for (let next = tidy(unquote(title)); next !== title; next = tidy(unquote(title))) title = next;
  if (!/[\p{L}\p{N}].*[\p{L}\p{N}]/su.test(title)) return { rejected: "empty" };
  if (CHATTER.test(title)) return { rejected: "chatter" };
  if (echoesExample(title, message)) return { rejected: "echo" };
  if (title.length <= CUSTOM_TITLE_MAX_CHARS) return { title };
  // A reply far over the limit or made of several sentences ignored the
  // instructions (free models do); clipping it would still show prose.
  if (title.length > CUSTOM_TITLE_MAX_CHARS * 1.5 || /[.!?]\s+\S/.test(title)) return { rejected: "prose" };
  const clipped = title.slice(0, CUSTOM_TITLE_MAX_CHARS - 1);
  const boundary = clipped.lastIndexOf(" ");
  const cut = (boundary >= 48 ? clipped.slice(0, boundary) : clipped).trimEnd().replace(TRAILING_CONNECTIVE, "");
  return { title: `${cut}…` };
};

/** Find the title in a generator's reply, or report why there is none. The
 * message the title is for, when known, tells a repeated prompt example from a
 * title that happens to match it. */
export function readGeneratedTitle(raw: string, message?: string): GeneratedTitle {
  if (!raw.trim()) return { rejected: "empty" };
  if (raw.length > MAX_REPLY_CHARS) return { rejected: "prose" };
  let text = raw
    .replace(ANSI_ESCAPES, "")
    .replace(INVISIBLE, "")
    .replace(CONTROL, " ")
    .replace(/\r\n?/g, "\n");
  text = withoutReasoning(text);
  if (!text.trim()) return { rejected: "reasoning" };
  text = answerElement(text) ?? text;
  text = text.replace(INLINE_TAG, "").replace(BLOCK_TAG, "\n");
  if (MODEL_MARKUP.test(text)) return { rejected: "markup" };
  // Fenced code is an answer to the request, not a title; a plain or JSON fence
  // only wrapped the title.
  text = text.replace(FENCE, (_block, language: string, body: string) => PLAIN_FENCE.test(language) ? body : "");
  if (!text.trim()) return { rejected: "code" };
  const json = jsonTitle(text);
  if (json === null) return { rejected: "markup" };
  if (json !== undefined) text = json;
  const candidates = candidatesOf(text);
  const chosen = candidates.find((candidate) => candidate.labelled) ?? candidates[0];
  if (!chosen) return { rejected: "chatter" };
  // Quotes, labels and markup add a few characters, never hundreds.
  if (chosen.text.length > MAX_LINE_CHARS) return { rejected: "prose" };
  return finalize(chosen.text, message);
}

/** The title in `raw`, or "" when the reply holds none. */
export function sanitizeGeneratedTitle(raw: string): string {
  const result = readGeneratedTitle(raw);
  return "title" in result ? result.title : "";
}
