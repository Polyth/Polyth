// Conservative file-reference grammar: `path`, `path:line`,
// `path:line:column`, `path:start-end`. Pure and DOM-free. URLs, bare words,
// and windows-style separators are not file references. A path that appears as
// a shell-command operand (e.g. `node server/dist/index.cjs`) is NOT a file
// reference — it is part of a command, so it is left as text. A bare `a/b`
// pair is a ratio, a CSS value pair, an event name or a directory far more
// often than a file, so the last segment must name a file (see below).
import type { EditorLocation } from "@polyth/contracts";

const EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|rs|go|java|kt|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|yml|yaml|toml|ini|sql|txt|svg|vue|svelte|lock|env|xml|proto|graphql|prisma|tf|dockerfile)$/i;

/** Well-known extension-less file names. Accepted only inside a path
 *  (`docs/README`), never as a bare word: a lone `README` in prose is a file
 *  the reader is talking about, not a link target. */
const EXTENSIONLESS_FILES = new Set([
  "readme", "license", "licence", "notice", "changelog", "authors", "contributing",
  "copying", "dockerfile", "makefile", "procfile", "gemfile", "rakefile", "brewfile",
]);

const REF_RE = /^([\p{L}\p{N}_@][\p{L}\p{N}\p{M}_@\-./]*?)(?::(\d+)(?:(?::(\d+))|(?:-(\d+)))?)?$/u;

// Common shell/command executables. When one of these begins a text run (or
// immediately precedes a path token), the path is a command operand, not a
// file reference the reader would want to open.
const COMMAND_WORDS = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "tsc", "ts-node",
  "python", "python3", "pip", "pip3", "go", "cargo", "rustc",
  "git", "gh", "cd", "ls", "ll", "cat", "less", "more", "grep", "rg", "ag",
  "sed", "awk", "cut", "sort", "uniq", "wc", "find", "xargs", "tar", "gzip",
  "gunzip", "zip", "unzip", "rsync", "scp", "ssh",
  "bash", "sh", "zsh", "fish", "sudo", "env", "time", "watch", "make", "cmake",
  "docker", "docker-compose", "podman", "kubectl", "helm", "terraform", "tofu",
  "curl", "wget", "jq", "yq",
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown", "ln", "source",
  "export", "unset", "alias", "nvm", "which", "where", "echo", "printf",
  "top", "htop", "ps", "kill", "systemctl", "journalctl",
  "apt", "apt-get", "brew", "snap", "dnf", "yum", "pacman",
]);

/** First bare word of a run (a command name, not a path). */
function firstWord(text: string): string | undefined {
  return /^[A-Za-z0-9_@][A-Za-z0-9_@-]*/.exec(text.trimStart())?.[0];
}

/** Does the run begin with a known command word? If so, treat the whole run as
 *  command text (no file references, no matter whose operands look like paths). */
function isCommandRun(text: string): boolean {
  const first = firstWord(text);
  return first !== undefined && COMMAND_WORDS.has(first);
}

/** Does the text before a path token end with a known command word? Catches a
 *  command embedded mid-prose (e.g. "Let me run node server/dist/index.cjs"). */
function precededByCommand(gap: string): boolean {
  const words = gap.trim().split(/\s+/);
  const last = words[words.length - 1];
  return last !== undefined && COMMAND_WORDS.has(last);
}

/** Parse one candidate token into an EditorLocation, or null when it does not
 *  look like a real repository path. */
const TRAILING_PUNCTUATION_RE = /[.,;:)\]}>"']+$/;

export function parseFileRef(token: string): EditorLocation | null {
  const t = token.replace(TRAILING_PUNCTUATION_RE, "");
  if (!t || t.length > 512) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return null; // URL
  if (t.includes("\\")) return null;                        // windows-like separators stay text
  if (t.startsWith("/") || t.split("/").includes("..")) return null; // absolute/traversal
  const m = REF_RE.exec(t);
  if (!m) return null;
  const path = m[1]!;
  if (path.endsWith("/")) return null;
  // The last segment must name a file. Without this, any token containing a
  // slash becomes a link: `static/visible` and `fixed/hidden` (CSS value
  // pairs), `35/35` (a test count), `turn/stopped` (an event name), `v1/v2`
  // and `Europe/Kyiv` are hijacked, drop their inline-code styling and open a
  // nonexistent editor path when tapped.
  const base = path.split("/").pop() ?? "";
  if (!EXT_RE.test(base) && !(path.includes("/") && EXTENSIONLESS_FILES.has(base.toLowerCase()))) return null;
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

// ---------------------------------------------------------------- link hrefs

/** A workspace checkout an absolute link path may live in. */
export interface FileLinkRoot { repositoryId: string; path: string }

/** Where a local markdown link points: a workspace-relative file locator
 *  (`repositoryId` when an absolute path named its checkout). */
export type FileLinkTarget = EditorLocation & { repositoryId?: string };

const LINK_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** True when a markdown link names a local path rather than a web address:
 *  a `file:` URL, an absolute path or a relative path. Such a link never works
 *  as a browser address — the browser would ask the Polyth server for
 *  `/home/…/INDEX.md` and get "not found" — so it opens in Project files.
 *  In-page `#anchors`, protocol-relative `//host` and every other scheme
 *  (http(s), mailto, javascript:…) stay with the URL policy in sanitize.ts. */
export function isLocalLinkHref(href: string): boolean {
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("//")) return false;
  const scheme = LINK_SCHEME_RE.exec(h)?.[1];
  return scheme === undefined || scheme.toLowerCase() === "file";
}

/** Path segments with `.`/empty parts dropped and `..` applied; null when
 *  `..` climbs above the start. */
function normalizeSegments(path: string): string[] | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

function decodePath(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** `L12`, `L12-L20`, `L12-20` or `L12C3` (the GitHub fragment forms). */
const FRAGMENT_LINE_RE = /^L(\d+)(?:C(\d+)|-L?(\d+))?$/;
/** `:12`, `:12:3` or `:12-20` after the path, as in a prose file reference. */
const SUFFIX_LINE_RE = /:(\d+)(?::(\d+)|-(\d+))?$/;

function withLines(loc: FileLinkTarget, start?: string, column?: string, end?: string): FileLinkTarget {
  if (start === undefined) return loc;
  const first = Number(start);
  if (!Number.isFinite(first) || first < 1 || first > 1_000_000) return loc;
  loc.startLine = first;
  if (column !== undefined) {
    const col = Number(column);
    if (col >= 1 && col <= 100_000) loc.column = col;
  } else if (end !== undefined) {
    const last = Number(end);
    if (Number.isFinite(last) && last >= first) loc.endLine = last;
  }
  return loc;
}

/** Resolve a local markdown link (see isLocalLinkHref) to a workspace file.
 *
 *  - An absolute path (or `file://` URL) inside a known checkout becomes that
 *    checkout's relative path; the longest matching root wins. Any other
 *    absolute path reads as repository-root-relative (`/docs/a.md`), the way a
 *    repository README links — the file is then looked up like any prose path.
 *  - A relative path resolves against `baseDir` (the directory of the
 *    document being previewed) or the workspace root.
 *  - `?query` is dropped; a `#L12`-style fragment or a `:12` suffix selects
 *    lines.
 *
 *  Returns null when the href cannot name a workspace file (climbs above the
 *  root, names a directory, a remote `file://host/`, Windows separators). */
export function parseFileLinkHref(
  href: string,
  options: { roots?: readonly FileLinkRoot[]; baseDir?: string } = {},
): FileLinkTarget | null {
  if (!isLocalLinkHref(href)) return null;
  let raw = href.trim();
  if (/^file:/i.test(raw)) {
    const rest = raw.slice(5);
    if (rest.startsWith("//")) {
      const slash = rest.indexOf("/", 2);
      const host = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
      if (host !== "" && host.toLowerCase() !== "localhost") return null;
      raw = slash < 0 ? "/" : rest.slice(slash);
    } else {
      raw = rest;
    }
    if (!raw.startsWith("/")) return null;
  }
  const hashAt = raw.indexOf("#");
  const fragment = hashAt < 0 ? "" : raw.slice(hashAt + 1);
  if (hashAt >= 0) raw = raw.slice(0, hashAt);
  const queryAt = raw.indexOf("?");
  if (queryAt >= 0) raw = raw.slice(0, queryAt);
  let path = decodePath(raw);
  if (!path || path.length > 4096 || path.includes("\\") || path.includes("\0")) return null;
  if (path.endsWith("/")) return null; // a directory, not a file Project files can open
  const suffix = SUFFIX_LINE_RE.exec(path);
  if (suffix) path = path.slice(0, suffix.index);
  let segments: string[] | null;
  let repositoryId: string | undefined;
  if (path.startsWith("/")) {
    const absolute = normalizeSegments(path);
    if (!absolute) return null;
    let best: { repositoryId: string; depth: number } | undefined;
    for (const root of options.roots ?? []) {
      const rootSegments = normalizeSegments(root.path);
      if (!rootSegments || rootSegments.length === 0 || rootSegments.length > absolute.length) continue;
      if (!rootSegments.every((part, i) => absolute[i] === part)) continue;
      if (rootSegments.length === absolute.length) return null; // the checkout directory itself
      if (!best || rootSegments.length > best.depth) best = { repositoryId: root.repositoryId, depth: rootSegments.length };
    }
    segments = best ? absolute.slice(best.depth) : absolute;
    repositoryId = best?.repositoryId;
  } else {
    const base = options.baseDir ? options.baseDir.replace(/\/+$/, "") : "";
    segments = normalizeSegments(base ? `${base}/${path}` : path);
  }
  if (!segments || segments.length === 0) return null;
  const loc: FileLinkTarget = { path: segments.join("/"), ...(repositoryId ? { repositoryId } : {}) };
  const lines = FRAGMENT_LINE_RE.exec(fragment);
  if (lines) return withLines(loc, lines[1], lines[2], lines[3]);
  return suffix ? withLines(loc, suffix[1], suffix[2], suffix[3]) : loc;
}

/** Split a text run into literal/ref segments so plain prose (and code spans)
 *  can be linkified without touching non-path tokens. */
export function findFileRefs(text: string): Array<{ kind: "text"; text: string } | { kind: "ref"; text: string; loc: EditorLocation }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "ref"; text: string; loc: EditorLocation }> = [];
  const re = /[\p{L}\p{N}_@][\p{L}\p{N}\p{M}_@\-./:]*/gu;
  const commandRun = isCommandRun(text);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const token = m[0];
    const loc = parseFileRef(token);
    if (!loc || commandRun || precededByCommand(text.slice(last, m.index))) continue;
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    // The link shows the reference itself; the sentence's closing period or
    // comma stays prose after it, as parseFileRef read it.
    const shown = token.replace(TRAILING_PUNCTUATION_RE, "");
    out.push({ kind: "ref", text: shown, loc });
    last = m.index + shown.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  if (out.length === 0) out.push({ kind: "text", text });
  return out;
}
