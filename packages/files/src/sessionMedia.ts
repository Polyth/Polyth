// Session-lifetime chat media: the project-relative image/media paths a
// session's canonical history depends on.
//
// A chat image is stored as a PROJECT-RELATIVE path (a ```ui fence image
// field, a Markdown image, or an attachment `path`). It is rendered through
// `/api/files/raw`, which resolves the path against the session's *current*
// execution root. While a session is isolated that root is its worktree; after
// merge/discard the session is rebound to the project root and the worktree is
// deleted. An untracked file that only lived in the worktree (agent scratch
// media, a non-`_inbox` upload) then resolves to a 404 and the image is
// broken.
//
// `preserveSessionMedia` copies exactly those referenced files from the
// released checkout into the destination checkout before deletion, so the same
// project-relative path keeps resolving. It is deliberately narrow: only paths
// history references, only when the destination does not already hold them, and
// every path goes through the same `assertRelative` jail as the Files API.
// Pure and filesystem-agnostic: callers supply the reader/writer closures.
import type { SessionEvent } from "@polyth/contracts";
import { assertRelative } from "./index.ts";

/** Below this size the copy is a real file; anything larger is refused rather
 *  than moved through memory. Chat media is small; a large file is not it. */
export const MAX_SESSION_MEDIA_BYTES = 64 * 1024 * 1024;

/** A `from=` data file is parsed to find the images it renders, so it gets a
 *  smaller bound than a copied media file. */
export const MAX_SESSION_DATA_FILE_BYTES = 8 * 1024 * 1024;

/** File extensions a chat image/media field may name. */
const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp4|mov|m4v|ogv|webm)$/i;

/** File extensions a ```ui block's `from=` may name. */
const DATA_EXT_RE = /\.(?:json|jsonl|csv)$/i;

/** Markdown image destination: `![alt](path "title")`. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** A `ui`/`data` fence opener; the body is scanned line-wise. */
const FENCE_OPENER_RE = /^\s*(?:`{3,}|~{3,})\s*(ui|data|page)\b[^\n]*$/i;
const FENCE_CLOSER_RE = /^\s*(?:`{3,}|~{3,})\s*$/;

const isUrl = (value: string): boolean => /^(?:https?:)?\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value);

/** A single field of a `- a | b | c` block row or `key=value` option. Returns
 *  the trimmed token only when it is a plain project-relative path with one of
 *  `extensions`. URLs, absolute paths and traversal are refused here, before
 *  the token can reach a reader. */
function relativeToken(raw: string | undefined, extensions: RegExp): string | null {
  if (!raw) return null;
  const token = raw.trim().replace(/^\.\//, "");
  if (!token || isUrl(token) || token.startsWith("/")) return null;
  if (!extensions.test(token.split(/[?#]/, 1)[0] ?? "")) return null;
  if (/\s/.test(token)) return null;
  try {
    assertRelative(token);
  } catch {
    return null;
  }
  return token;
}

/** A media token from an image field. */
function imageToken(raw: string | undefined): string | null {
  return relativeToken(raw, IMAGE_EXT_RE);
}

/** A `from=` path: the data file a block renders its rows from. */
function dataToken(raw: string | undefined): string | null {
  return relativeToken(raw, DATA_EXT_RE);
}

/** Every project-relative image/media path on one fence-body line. Handles the
 *  positional block rows (`- image | title | …`) and `… image=<path> …`
 *  options without trying to be the full block grammar: it only ever returns a
 *  token that is a plain relative path to an image file. */
function mediaPathsInFenceLine(line: string): string[] {
  const out: string[] = [];
  const trimmed = line.trim();
  if (!trimmed) return out;
  const row = trimmed.match(/^[-*]\s+(.*)$/);
  if (row) {
    // The image is the first positional field of a cards/list/media row.
    const [first] = row[1]!.split("|");
    const token = imageToken(first);
    if (token) out.push(token);
  }
  // Explicit `image=<path>` (or `photo=`, `cover=`) options anywhere on the line.
  for (const match of trimmed.matchAll(/\b(?:image|photo|cover|picture|thumb|thumbnail)\s*=\s*([^\s|]+)/gi)) {
    const token = imageToken(match[1]);
    if (token) out.push(token);
  }
  // `from=<path>` names the data file the block renders (`cards Big · from=…`),
  // so the file itself must survive the checkout that owns it.
  for (const match of trimmed.matchAll(/\bfrom\s*=\s*([^\s|]+)/gi)) {
    const token = dataToken(match[1]);
    if (token) out.push(token);
  }
  return out;
}

/** Every media path referenced by the message text of one canonical event. */
function mediaPathsInText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const token = imageToken(match[1]);
    if (token) out.push(token);
  }
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (!fenced) {
      if (FENCE_OPENER_RE.test(line)) fenced = true;
      continue;
    }
    if (FENCE_CLOSER_RE.test(line)) {
      fenced = false;
      continue;
    }
    out.push(...mediaPathsInFenceLine(line));
  }
  return out;
}

/** The project-relative media paths a session's canonical history references.
 *  Reads `attachments[].path` plus the message text of user/assistant
 *  messages; ignores every other event kind. Order-stable and de-duplicated. */
export function referencedSessionMediaPaths(events: readonly SessionEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (candidate: string | null): void => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };
  for (const event of events) {
    if (event.type !== "user/message" && event.type !== "assistant/message") continue;
    const data = event.data as { text?: unknown; attachments?: unknown };
    if (Array.isArray(data.attachments)) {
      for (const attachment of data.attachments) {
        const path = (attachment as { path?: unknown })?.path;
        // Attachment paths are already repository-relative; keep the exact
        // stored token so the read path resolves it identically.
        if (typeof path === "string" && path && !isUrl(path)) {
          try {
            assertRelative(path.replace(/^\.\//, ""));
            add(path.replace(/^\.\//, ""));
          } catch { /* reject traversal */ }
        }
      }
    }
    if (typeof data.text === "string") {
      for (const path of mediaPathsInText(data.text)) add(path);
    }
  }
  return out;
}

/** A `from=` row's image: a bare string, the first cell of a row array, or an
 *  explicit image-like field on an object. */
function dataRowImage(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (Array.isArray(item)) return typeof item[0] === "string" ? item[0] : undefined;
  if (item && typeof item === "object") {
    for (const key of ["image", "photo", "cover", "picture", "thumb", "thumbnail"]) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

/** Split one CSV line, honouring doubled-quote escapes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (line[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

const MAX_DATA_ROWS = 20_000;

/** Image paths inside one `from=` data file. Deliberately bounded to
 *  top-level rows: a JSON array (or `{ rows: [...] }`), JSONL lines, and CSV
 *  rows whose named image column — or first column — holds the image. */
export function mediaPathsInDataFile(content: string, format: "json" | "jsonl" | "csv"): string[] {
  const collect = (items: readonly unknown[]): string[] => {
    const out: string[] = [];
    for (const item of items.slice(0, MAX_DATA_ROWS)) {
      const token = imageToken(dataRowImage(item));
      if (token) out.push(token);
    }
    return out;
  };
  if (format === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return []; }
    if (Array.isArray(parsed)) return collect(parsed);
    if (parsed && typeof parsed === "object") {
      const rows = (parsed as { rows?: unknown }).rows;
      return collect(Array.isArray(rows) ? rows : [parsed]);
    }
    return [];
  }
  if (format === "jsonl") {
    const items: unknown[] = [];
    for (const line of content.split(/\r?\n/).slice(0, MAX_DATA_ROWS)) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch { /* skip one bad line */ }
    }
    return collect(items);
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  const named = header.findIndex((cell) => /^(?:image|photo|cover|picture|thumb|thumbnail)$/i.test(cell.trim()));
  const column = named >= 0 ? named : 0;
  const out: string[] = [];
  for (const line of lines.slice(1, MAX_DATA_ROWS + 1)) {
    const token = imageToken(splitCsvLine(line)[column]);
    if (token) out.push(token);
  }
  return out;
}

/** The `json`/`jsonl`/`csv` format of a `from=` path. */
export function dataFileFormat(rel: string): "json" | "jsonl" | "csv" | null {
  const match = /\.(json|jsonl|csv)$/i.exec(rel);
  return match ? match[1]!.toLowerCase() as "json" | "jsonl" | "csv" : null;
}

export interface PreserveSessionMediaResult {
  copied: string[];
  /** Present at the destination already; the newer file is never overwritten. */
  skipped: string[];
  /** Unavailable in the source or refused (too large / unreadable). */
  missing: string[];
  /** Not Git-ignored at the destination. Git carries these on merge and
   *  abandons them on discard; copying them here would duplicate work or
   *  dirty the destination, so they are never copied. */
  notIgnored: string[];
}

/** Copy session-referenced media that exists only in the released checkout
 *  into the destination checkout. Never overwrites an existing destination
 *  file, never leaves the two roots (both go through `assertRelative` and the
 *  caller's confined readers), and never throws for one bad path: cleanup must
 *  not be blocked by a missing or oversized file.
 *
 *  `ignored` is the Git-ignore filter: only paths Git ignores are copied. A
 *  non-ignored untracked file is Git's to carry on merge (it is in the
 *  publication snapshot) and must *not* reappear after a discard, so copying
 *  it here would either duplicate work or dirty the user's checkout. */
export async function preserveSessionMedia(input: {
  paths: readonly string[];
  /** The released checkout (worktree). */
  sourceRoot: string;
  /** The checkout the session is being rebound to (usually the project root). */
  destinationRoot: string;
  exists(root: string, rel: string): Promise<boolean>;
  read(root: string, rel: string): Promise<Uint8Array | null>;
  write(root: string, rel: string, data: Uint8Array): Promise<void>;
  /** The subset of `paths` Git ignores at the destination, in one batch.
   *  Absent: every path is eligible (pure copy callers and tests). */
  ignored?(paths: readonly string[]): Promise<readonly string[]>;
  maxBytes?: number;
}): Promise<PreserveSessionMediaResult> {
  const maxBytes = input.maxBytes ?? MAX_SESSION_MEDIA_BYTES;
  const eligible = new Set(input.ignored ? await input.ignored(input.paths) : input.paths);
  const copied: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  const notIgnored: string[] = [];
  for (const rel of input.paths) {
    if (!eligible.has(rel)) {
      notIgnored.push(rel);
      continue;
    }
    try {
      assertRelative(rel);
    } catch {
      missing.push(rel);
      continue;
    }
    try {
      if (await input.exists(input.destinationRoot, rel)) {
        skipped.push(rel);
        continue;
      }
      if (!(await input.exists(input.sourceRoot, rel))) {
        missing.push(rel);
        continue;
      }
      const data = await input.read(input.sourceRoot, rel);
      if (!data || data.byteLength > maxBytes) {
        missing.push(rel);
        continue;
      }
      await input.write(input.destinationRoot, rel, data);
      copied.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { copied, skipped, missing, notIgnored };
}
