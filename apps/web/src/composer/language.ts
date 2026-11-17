// Pure prompt-token grammar: /commands, #snippets and @file mentions
// highlight and complete at any caret position, not only when the whole input
// is one token. Fenced code spans are opaque.
//
// A host path (`/Users/me/a.zip`, `~/notes`) is never a command: command names
// cannot hold a slash, so a slash token with a second slash is a `path` token,
// and so is `~/…`, at a line start or anywhere after whitespace.
export type PromptToken =
  | { kind: "command"; from: number; to: number; value: string }
  | { kind: "snippet"; from: number; to: number; value: string }
  | { kind: "file"; from: number; to: number; path: string }
  | { kind: "path"; from: number; to: number; path: string };

interface Span { from: number; to: number }

export type ComposerMode = "prompt" | "shell";

/** A bang is shell mode only when it is the first non-whitespace character. */
export function composerMode(text: string): ComposerMode {
  return text.trimStart().startsWith("!") ? "shell" : "prompt";
}

export function shellCommand(text: string): string | null {
  if (composerMode(text) !== "shell") return null;
  return text.trimStart().slice(1).trim();
}

/** Ranges covered by ``` fences (including unterminated trailing fences). */
export function fencedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /```/g;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (open < 0) open = m.index;
    else {
      spans.push({ from: open, to: m.index + 3 });
      open = -1;
    }
  }
  if (open >= 0) spans.push({ from: open, to: text.length });
  return spans;
}

const inSpan = (spans: Span[], i: number): boolean => spans.some((s) => i >= s.from && i < s.to);

/** `/a/…` or `~/a…`: the first segment names something (`//` and a bare `~/`
 *  do not). */
const HOST_PATH_RE = /^(?:\/[^/\s]+\/|~\/[^/\s])/;

/** Parse all prompt tokens. `/name` is recognized at a line start; `#alias`,
 *  `@path` and host paths anywhere after whitespace or start-of-text. */
export function parsePromptTokens(text: string): PromptToken[] {
  const fences = fencedSpans(text);
  const out: PromptToken[] = [];
  const re = /(^|[\s(])([/#@~])([^\s]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lead = m[1]!;
    const sigil = m[2]!;
    const body = m[3] ?? "";
    const from = m.index + lead.length;
    if (inSpan(fences, from)) continue;
    const to = from + 1 + body.length;
    if (HOST_PATH_RE.test(sigil + body)) {
      out.push({ kind: "path", from, to, path: sigil + body });
    } else if (sigil === "~") {
      continue;
    } else if (sigil === "/") {
      // command semantics: only at the start of a line
      const lineStart = from === 0 || text[from - 1] === "\n";
      if (!lineStart) continue;
      out.push({ kind: "command", from, to, value: body });
    } else if (sigil === "#") {
      out.push({ kind: "snippet", from, to, value: body });
    } else {
      out.push({ kind: "file", from, to, path: body });
    }
  }
  return out;
}

/** The path a `path` token asks the host about: a sentence's closing
 *  punctuation is prose, not part of the name. */
export function hostPathQuery(path: string): string | null {
  const trimmed = path.replace(/[.,;:!?)\]}>"']+$/, "");
  return trimmed.length <= 4096 && HOST_PATH_RE.test(trimmed.endsWith("/") ? trimmed : `${trimmed}/`) ? trimmed : null;
}

/** Token whose range contains the caret (caret at token end counts). */
export function activeToken(text: string, caret: number): PromptToken | null {
  for (const t of parsePromptTokens(text)) {
    if (caret > t.from && caret <= t.to) return t;
  }
  return null;
}

/** Replace only the active token; returns new text and caret position. */
export function completeToken(text: string, token: PromptToken, replacement: string): { text: string; caret: number } {
  const next = text.slice(0, token.from) + replacement + text.slice(token.to);
  return { text: next, caret: token.from + replacement.length };
}
