// Pure prompt-token grammar (WP2): /commands, #snippets and @file mentions
// highlight and complete at any caret position, not only when the whole input
// is one token. Fenced code spans are opaque.
export type PromptToken =
  | { kind: "command"; from: number; to: number; value: string }
  | { kind: "snippet"; from: number; to: number; value: string }
  | { kind: "file"; from: number; to: number; path: string };

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

/** Parse all prompt tokens. `/name` is recognized at a line start; `#alias`
 *  and `@path` anywhere after whitespace or start-of-text. */
export function parsePromptTokens(text: string): PromptToken[] {
  const fences = fencedSpans(text);
  const out: PromptToken[] = [];
  const re = /(^|[\s(])([/#@])([^\s]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lead = m[1]!;
    const sigil = m[2]!;
    const body = m[3] ?? "";
    const from = m.index + lead.length;
    if (inSpan(fences, from)) continue;
    const to = from + 1 + body.length;
    if (sigil === "/") {
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
