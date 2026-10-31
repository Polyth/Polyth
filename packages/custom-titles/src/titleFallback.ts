// The last resort when the title model answered nothing usable. It reads only
// the user's own words, so it works with any model and any outage of one:
// drop greetings and "can you please", keep the opening phrase, never invent.

const MAX_WORDS = 8;
const MAX_CHARS = 60;
const RAW_MAX_CHARS = 48;
// The title comes from the opening words, so only the opening is ever read: a
// pasted log on one line must not cost more than a short message.
const MAX_INPUT_CHARS = 4_000;
const MAX_TOPIC_CHARS = 300;

const LIST_MARKER = /^(?:[-*•–—+>]\s+|#{1,6}\s+|\d{1,2}[.)]\s+)+/;

// Unicode-aware boundary: `\b` only knows ASCII word characters.
const END = "(?![\\p{L}\\p{N}_'])";
const LEADING_FILLER = new RegExp(`^(?:${[
  "(?:hi|hello|hey|hiya|yo|greetings)",
  "(?:ok|okay|so|well|basically|actually|um|uh|hmm)",
  "what\\s+(?:i|we)\\s+(?:want|need)\\s+is|the\\s+(?:thing|problem|issue)\\s+is",
  "good\\s+(?:morning|afternoon|evening)",
  "привіт\\p{L}*|вітаю|добр\\p{L}+\\s+(?:день|вечір|ранок)|доброго\\s+(?:дня|вечора|ранку)",
  "please|pls|plz|kindly|будь\\s+ласка|прошу",
  "(?:can|could|would|will)\\s+(?:you|we)",
  "(?:i|we)\\s+(?:need|want)\\s+(?:you\\s+)?to|(?:i|we)\\s+(?:need|want)|i(?:'d|\\s+would)\\s+like\\s+(?:you\\s+)?to|i(?:'d|\\s+would)\\s+like",
  "help\\s+me(?:\\s+to)?|let(?:'s|\\s+us)|we\\s+(?:need|have)\\s+to|you\\s+should|how\\s+(?:do|can|could|should)\\s+(?:i|we|you)|how\\s+to",
  "(?:ти\\s+)?(?:можеш|можете)|міг\\s+би|могли\\s+б|допоможи(?:\\s+мені)?|допоможіть|(?:мені|нам)\\s+(?:треба|потрібно)|потрібно|треба|хочу|давай(?:те)?",
].join("|")})${END}[\\s,:;!.-]*`, "iu");

// Where a long first sentence stops naming the task and starts explaining it.
const CLAUSE_BREAK = /\s*(?:[,;:]|\s[—–-]\s)\s*|\s+(?:that|which|because|since|but|so\s+that|then|when|where|while|if|щоб|бо|але|коли|якщо|який|яка|яке)(?![\p{L}\p{N}])\s*/giu;
const TRAILING_FILLER = /[\s,]*(?:please|pls|plz|thanks|thank\s+you|будь\s+ласка|дякую)[\s.!]*$/iu;

const TRAILING_CONNECTIVE = /(?:\s+(?:a|an|the|of|to|in|on|at|for|with|and|or|but|so|that|which|from|by|as|is|are|be|if|then|than|into|about|my|our|your|i|we|it|this|me|us|whether|how|what|why|where|who|в|у|на|з|із|до|і|й|та|а|але|що|щоб|як|це|чи|по|за|від|для)(?![\p{L}\p{N}]))+$/iu;

const clean = (line: string): string => line.replace(LIST_MARKER, "").replace(/\s+/g, " ").trim();
const wordCount = (line: string): number => line.split(" ").filter(Boolean).length;

const firstLine = (text: string): string => text.split("\n").map(clean).find(Boolean) ?? "";

// A link opening the message ("https://… please check this") is dropped; one
// inside a sentence stays as its host; a message that is only a link keeps it.
const withHosts = (line: string): string => line.replace(/https?:\/\/([^\s/)]+)[^\s)]*/gi, "$1");
const withoutLeadingLink = (line: string): string => {
  const rest = clean(withHosts(line.replace(/^\s*https?:\/\/\S+\s*/i, "")));
  return /\p{L}/u.test(rest) ? rest : clean(withHosts(line));
};

/** The first meaningful line of `text` with code, markup and links reduced to words.
 * A one- or two-word heading ("# Task") gives way to the sentence under it. */
const topicLine = (text: string): string => {
  const lines = text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/<[^<>\n]{1,200}>/g, " ")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    .replace(/\*\*|`+/g, "")
    .split("\n")
    .filter((line) => /\p{L}/u.test(line))
    .map(withoutLeadingLink);
  return lines.find((line) => wordCount(line) >= 3) ?? lines[0] ?? "";
};

const withoutFiller = (line: string): string => {
  let out = line;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(LEADING_FILLER, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
};

const capitalize = (text: string): string => {
  const [first = ""] = text;
  return `${first.toLocaleUpperCase()}${text.slice(first.length)}`;
};

/** A short title taken from the opening words of the user's first message.
 * Returns "" only for a message with no text at all. */
export function fallbackTitleFromRequest(fullPrompt: string): string {
  const prompt = fullPrompt.trimStart().slice(0, MAX_INPUT_CHARS);
  const topic = withoutFiller(topicLine(prompt)).slice(0, MAX_TOPIC_CHARS);
  // `split` keeps "v2.1" and "e.g.x" whole: a sentence ends at punctuation + space.
  const first = topic.split(/(?<=[.!?…])\s+/u)[0]?.replace(TRAILING_FILLER, "") ?? "";
  const fits = (text: string) => text.split(" ").filter(Boolean).length <= MAX_WORDS && text.length <= MAX_CHARS;
  // A short sentence is the title. A long one is cut where it starts explaining,
  // keeping at least three words, or else at the word limit.
  const head = fits(first)
    ? first
    : [...first.matchAll(CLAUSE_BREAK)].map((match) => first.slice(0, match.index))
      .filter((candidate) => fits(candidate) && candidate.split(" ").filter(Boolean).length >= 3).at(-1);
  let title = head ?? first.split(" ").filter(Boolean).slice(0, MAX_WORDS).join(" ");
  if (title.length > MAX_CHARS) title = title.slice(0, MAX_CHARS).replace(/\s+\S*$/, "");
  if (title.length < first.length) {
    title = title.replace(TRAILING_CONNECTIVE, "").replace(/\s*[([{][^)\]}]*$/, "");
  }
  title = title.replace(/[\s.,;:!?…\-–—]+$/u, "");
  if (/[\p{L}\p{N}]/u.test(title)) return capitalize(title);

  // Nothing but code or links: the opening line as written, like the canonical fallback.
  const raw = firstLine(prompt.replace(/^[ \t]*```[\w+#.-]*[ \t]*$/gm, ""));
  if (raw.length <= RAW_MAX_CHARS) return raw;
  return `${raw.slice(0, RAW_MAX_CHARS - 1).trimEnd()}…`;
}
