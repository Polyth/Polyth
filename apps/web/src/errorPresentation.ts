// Transient error toast presentation (visual only). The UI error state keeps a
// single message string and one 7s lifetime; this module derives the compact
// two-level copy and the contextual icon category at the display boundary. It
// never changes what is stored, when the toast appears, or when it hides.

export type UiErrorCategory = "network" | "auth" | "storage" | "server" | "blocked" | "error";

export interface UiErrorPresentation {
  /** Short, dominant heading; empty when the message has no compact label. */
  title: string;
  /** Muted supporting line; empty when the message is a single short line. */
  description: string;
  category: UiErrorCategory;
}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 240;

// Category order matters: the first match wins. Transport symptoms are checked
// before the operation they failed ("cannot connect" is a network problem).
const CATEGORY_MATCHERS: ReadonlyArray<readonly [UiErrorCategory, RegExp]> = [
  ["network", /\b(network|offline|connect(?:ion|ed|ing|s)?|reconnect|fetch failed|econnrefused|econnreset|enotfound|socket hang up|timed? out|timeout|dns|unreachable|50[234])\b/i],
  ["auth", /\b(unauthori[sz]ed|forbidden|permission|denied|credentials?|passkey|40[13])\b/i],
  ["storage", /\b(disk|storage|quota|enospc|no space|filesystem|read[- ]?only|save|write)\b/i],
  ["server", /\b(server|backend|database|service unavailable|internal error|bad gateway|500)\b/i],
  ["blocked", /\b(unsupported|not supported|not available|unavailable operation|blocked|disabled)\b/i],
];

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** Split "Head: detail" / "Head — detail" only when the head is a compact
 *  label, so a URL or a sentence fragment never becomes a fake title. */
function splitOnSeparator(text: string): { title: string; description: string } {
  for (const separator of [": ", " — ", " – "]) {
    const at = text.indexOf(separator);
    if (at <= 0) continue;
    const head = text.slice(0, at).trim();
    const tail = text.slice(at + separator.length).trim();
    if (!tail || head.length > MAX_TITLE || URL_SCHEME.test(head)) continue;
    return { title: head, description: tail };
  }
  return { title: text, description: "" };
}

export function classifyUiError(message: string): UiErrorCategory {
  for (const [category, matcher] of CATEGORY_MATCHERS) {
    if (matcher.test(message)) return category;
  }
  return "error";
}

export function presentUiError(message: string): UiErrorPresentation {
  const normalized = collapse(message);
  let title = "";
  let description = "";
  if (normalized) {
    const newline = message.indexOf("\n");
    if (newline >= 0) {
      title = collapse(message.slice(0, newline));
      description = collapse(message.slice(newline + 1));
    } else {
      ({ title, description } = splitOnSeparator(normalized));
    }
  }
  return {
    title: cap(title, MAX_TITLE),
    // Never repeat the heading as the body; an empty body just renders the title.
    description: description && description !== title ? cap(description, MAX_DESCRIPTION) : "",
    category: classifyUiError(normalized),
  };
}
