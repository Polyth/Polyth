// Conservative file-reference grammar (WP4): `path`, `path:line`,
// `path:line:column`, `path:start-end`. Pure and DOM-free. URLs, bare words,
// and windows-style separators are not file references.
import type { EditorLocation } from "@polyth/contracts";

const EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|java|kt|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|yml|yaml|toml|ini|sql|txt|svg|vue|svelte|lock|env|xml|proto|graphql|prisma|tf|dockerfile)$/i;

const REF_RE = /^([A-Za-z0-9_@][A-Za-z0-9_@\-./]*?)(?::(\d+)(?:(?::(\d+))|(?:-(\d+)))?)?$/;

/** Parse one candidate token into an EditorLocation, or null when it does not
 *  look like a real repository path. */
export function parseFileRef(token: string): EditorLocation | null {
  const t = token.replace(/[.,;:)\]}>"']+$/, ""); // trailing punctuation
  if (!t || t.length > 512) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return null; // URL
  if (t.includes("\\")) return null;                        // windows-like separators stay text
  if (t.startsWith("/") || t.split("/").includes("..")) return null; // absolute/traversal
  const m = REF_RE.exec(t);
  if (!m) return null;
  const path = m[1]!;
  // must look like a path: contains a slash or a known file extension
  if (!path.includes("/") && !EXT_RE.test(path)) return null;
  if (path.endsWith("/") || !EXT_RE.test(path.split("/").pop() ?? "") && !path.includes("/")) return null;
  const loc: EditorLocation = { path };
  if (m[2]) {
    const start = Number(m[2]);
    if (!Number.isFinite(start) || start < 1 || start > 1_000_000) return null;
    loc.startLine = start;
    if (m[3]) {
      const col = Number(m[3]);
      if (col >= 1 && col <= 100_000) loc.column = col;
    } else if (m[4]) {
      const end = Number(m[4]);
      if (!Number.isFinite(end) || end < start) return null;
      loc.endLine = end;
    }
  }
  return loc;
}

/** Split a text run into literal/ref segments so plain prose (and code spans)
 *  can be linkified without touching non-path tokens. */
export function findFileRefs(text: string): Array<{ kind: "text"; text: string } | { kind: "ref"; text: string; loc: EditorLocation }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "ref"; text: string; loc: EditorLocation }> = [];
  const re = /[A-Za-z0-9_@][A-Za-z0-9_@\-./:]*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const token = m[0];
    const loc = parseFileRef(token);
    if (!loc) continue;
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    // preserve the exact matched token text (minus what parseFileRef trimmed)
    out.push({ kind: "ref", text: token, loc });
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  if (out.length === 0) out.push({ kind: "text", text });
  return out;
}
