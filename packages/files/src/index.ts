// Project-scoped filesystem. Every path is relative to a project root;
// escapes (`..`, absolute, symlink-out) are rejected.
import { mkdir, open, readFile, readdir, lstat, realpath, rename as move, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export { browseHost, mkdirHost, resolveHostPath, isBlockedHostPath } from "./browse.ts";
export type { BrowseEntry, BrowseOptions, BrowseResult } from "./browse.ts";

const MAX_READ = 512 * 1024;
const BINARY_SCAN = 8 * 1024;
const MAX_RAW = 20 * 1024 * 1024;

/** Shared binary cap: raw serving, uploads, and message attachments (F2). */
export const MAX_RAW_BYTES = MAX_RAW;
/** Text-read cap shared with the remote implementation (see remote.ts). */
export const MAX_READ_BYTES = MAX_READ;
/** NUL-scan length shared with the remote implementation (see remote.ts). */
export const BINARY_SCAN_BYTES = BINARY_SCAN;

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
  tooLarge?: boolean;
  /** On-disk revision at read time; pass back as baseRevision to guard writes. */
  revision?: string;
}

export interface FileStatResult {
  path: string;
  kind: "file" | "dir";
  size: number;
  mime?: string;
  revision?: string;
}

export interface FileRawResult {
  data: Uint8Array;
  mime: string;
  size: number;
}

// Only types the raw endpoint may serve inline. HTML/SVG/JS are deliberately
// absent: model output must never become an executable document origin.
const RAW_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
  ".ogv": "video/ogg", ".webm": "video/webm",
  ".aac": "audio/aac", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg", ".oga": "audio/ogg", ".ogg": "audio/ogg",
  ".wav": "audio/wav", ".weba": "audio/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/plain", ".json": "text/plain",
  ".csv": "text/plain", ".log": "text/plain",
};

export function rawMimeOf(rel: string): string {
  return RAW_MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
}

export interface WriteOptions {
  /** Revision the caller loaded (from stat/read). A mismatch with the on-disk
   *  revision rejects the write with code "conflict" — autosave can never
   *  clobber an externally changed file. */
  baseRevision?: string;
}

export interface FileSearchHit {
  path: string;
  kind: "file" | "dir";
  /** 0..1 — exact basename > basename prefix > substring > segment > fuzzy. */
  score: number;
  /** [start, end) ranges into `path` for highlight (empty for fuzzy/folded). */
  matches: Array<[number, number]>;
}

export interface SearchOptions {
  limit?: number;
  includeDirs?: boolean;
}

export interface FileService {
  tree(root: string, opts?: { path?: string; hidden?: boolean }): Promise<FileEntry[]>;
  read(root: string, rel: string): Promise<FileReadResult>;
  stat(root: string, rel: string): Promise<FileStatResult>;
  readRaw(root: string, rel: string): Promise<FileRawResult>;
  write(root: string, rel: string, content: string, opts?: WriteOptions): Promise<{ revision: string }>;
  writeBytes(root: string, rel: string, data: Uint8Array): Promise<void>;
  mkdir(root: string, rel: string): Promise<void>;
  remove(root: string, rel: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  /** Legacy string results (paths only), ordered by relevance. */
  search(root: string, q: string, limit: number): Promise<string[]>;
  /** Scored search over names and paths (WP13 palette/mentions). */
  searchScored(root: string, q: string, opts?: SearchOptions): Promise<FileSearchHit[]>;
}

const posix = (p: string): string => p.split(path.sep).join("/");

/** Cheap revision token: changes whenever content plausibly changed. */
const revisionOf = (st: { mtimeMs: number; size: number }): string =>
  `${st.mtimeMs.toString(36)}-${st.size.toString(36)}`;

export function createFileService(): FileService {
  return {
    async tree(root, opts = {}) {
      const rel = opts.path ?? "";
      const abs = await resolveInside(root, rel);
      const st = await lstat(abs);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${rel || "."}`);
      const hidden = opts.hidden === true;
      const entries = await readdir(abs, { withFileTypes: true });
      const out: FileEntry[] = [];
      for (const ent of entries) {
        if (ent.name === ".git") continue;
        if (!hidden && ent.name.startsWith(".")) continue;
        const childRel = posix(rel ? path.join(rel, ent.name) : ent.name);
        const isDir = ent.isDirectory();
        const item: FileEntry = { name: ent.name, path: childRel, dir: isDir };
        if (!isDir) {
          try {
            const s = await lstat(path.join(abs, ent.name));
            if (s.isFile()) item.size = s.size;
          } catch { /* ignore */ }
        }
        out.push(item);
      }
      out.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return out;
    },

    async read(root, rel) {
      const abs = await resolveInside(root, rel, { allowAbsolute: true });
      const fh = await open(abs, "r");
      try {
        const st = await fh.stat();
        const revision = revisionOf(st);
        const scanLen = Math.min(BINARY_SCAN, st.size);
        if (scanLen > 0) {
          const head = Buffer.alloc(scanLen);
          await fh.read(head, 0, scanLen, 0);
          if (head.includes(0)) {
            return { path: posix(rel), content: "", truncated: false, tooLarge: true, revision };
          }
        }
        if (st.size > MAX_READ) {
          const buf = Buffer.alloc(MAX_READ);
          await fh.read(buf, 0, MAX_READ, 0);
          return { path: posix(rel), content: buf.toString("utf8"), truncated: true, revision };
        }
        const content = await readFile(abs, "utf8");
        return { path: posix(rel), content, truncated: false, revision };
      } finally {
        await fh.close();
      }
    },

    async stat(root, rel) {
      const abs = await resolveInside(root, rel, { allowAbsolute: true });
      const st = await lstat(abs);
      const kind = st.isDirectory() ? "dir" as const : "file" as const;
      const out: FileStatResult = { path: posix(rel), kind, size: st.size };
      if (kind === "file") {
        out.mime = rawMimeOf(rel);
        out.revision = revisionOf(st);
      }
      return out;
    },

    async readRaw(root, rel) {
      const abs = await resolveInside(root, rel, { allowAbsolute: true });
      const st = await lstat(abs);
      if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
      if (st.size > MAX_RAW) throw new Error(`File too large to serve raw: ${rel}`);
      const data = await readFile(abs);
      return { data, mime: rawMimeOf(rel), size: st.size };
    },

    async write(root, rel, content, opts = {}) {
      const abs = await resolveInside(root, rel, { forWrite: true });
      let existing: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        existing = await lstat(abs);
      } catch { /* new file */ }
      if (existing?.isFile()) {
        const currentRev = revisionOf(existing);
        if (opts.baseRevision !== undefined && opts.baseRevision !== currentRev) {
          throw Object.assign(new Error(`File changed on disk: ${rel}`), { code: "conflict", revision: currentRev });
        }
        // Text writes never overwrite binary content — that is upload territory.
        const scanLen = Math.min(BINARY_SCAN, existing.size);
        if (scanLen > 0) {
          const fh = await open(abs, "r");
          try {
            const head = Buffer.alloc(scanLen);
            await fh.read(head, 0, scanLen, 0);
            if (head.includes(0)) {
              throw Object.assign(new Error(`Refusing to overwrite binary file with text: ${rel}`), { code: "invalid-input" });
            }
          } finally {
            await fh.close();
          }
        }
      } else if (opts.baseRevision !== undefined) {
        throw Object.assign(new Error(`File no longer exists: ${rel}`), { code: "conflict" });
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      // Refuse if the written file (or a parent symlink) landed outside root.
      await resolveInside(root, rel);
      const st = await lstat(abs);
      return { revision: revisionOf(st) };
    },

    async writeBytes(root, rel, data) {
      const abs = await resolveInside(root, rel, { forWrite: true });
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, data);
      await resolveInside(root, rel);
    },

    async mkdir(root, rel) {
      const abs = await resolveInside(root, rel, { forWrite: true });
      await mkdir(abs, { recursive: true });
      await resolveInside(root, rel);
    },

    async remove(root, rel) {
      const abs = await resolveInside(root, rel);
      await rm(abs, { recursive: true });
    },

    async rename(root, from, to) {
      const source = await resolveInside(root, from);
      const target = await resolveInside(root, to, { forWrite: true });
      await lstat(target).then(() => { throw new Error(`Path already exists: ${to}`); }).catch((err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
        throw err;
      });
      await move(source, target);
      await resolveInside(root, to);
    },

    async search(root, q, limit) {
      const hits = await this.searchScored(root, q, { limit });
      return hits.map((h) => h.path);
    },

    async searchScored(root, q, opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
      const includeDirs = opts.includeDirs === true;
      const rootAbs = path.resolve(root);
      const query = fold(q.trim());
      const hits: FileSearchHit[] = [];
      // Bounded traversal: heavy dirs skipped, entry and time caps enforced so
      // one giant repo cannot stall the palette.
      let visited = 0;
      const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
      const walk = async (dirAbs: string, rel: string): Promise<void> => {
        if (visited >= SEARCH_MAX_ENTRIES || Date.now() > deadline) return;
        let entries;
        try {
          entries = await readdir(dirAbs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (visited >= SEARCH_MAX_ENTRIES || Date.now() > deadline) return;
          visited++;
          if (IGNORED_DIRS.has(ent.name)) continue;
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          // Symlinks are never followed: loops and root escapes stay impossible.
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (includeDirs) {
              const scored = scorePath(childRel, query);
              if (scored) hits.push({ path: posix(childRel), kind: "dir", ...scored });
            }
            await walk(path.join(dirAbs, ent.name), childRel);
            continue;
          }
          const scored = scorePath(childRel, query);
          if (scored) hits.push({ path: posix(childRel), kind: "file", ...scored });
        }
      };
      await walk(rootAbs, "");
      hits.sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length) || a.path.localeCompare(b.path));
      return hits.slice(0, limit);
    },
  };
}

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".cache", "target", "__pycache__", ".venv",
]);
const SEARCH_MAX_ENTRIES = 20_000;
const SEARCH_TIME_BUDGET_MS = 400;

/** Case/diacritic fold for matching ("Café" → "cafe"). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Score a relative path against a folded query. Null = no match. */
export function scorePath(relPath: string, query: string): { score: number; matches: Array<[number, number]> } | null {
  const p = posix(relPath);
  if (!query) return { score: 0.1, matches: [] };
  const folded = fold(p);
  const slash = folded.lastIndexOf("/");
  const base = folded.slice(slash + 1);
  const baseStart = slash + 1;
  // Highlight ranges only when fold preserved offsets (pure-ASCII case fold).
  const offsetsSafe = folded.length === p.length;
  const range = (start: number): Array<[number, number]> =>
    offsetsSafe ? [[start, start + query.length]] : [];

  const noExt = base.replace(/\.[^.]+$/, "");
  if (base === query || noExt === query) return { score: 1, matches: range(baseStart) };
  if (base.startsWith(query)) return { score: 0.9, matches: range(baseStart) };
  const inBase = base.indexOf(query);
  if (inBase >= 0) return { score: 0.8, matches: range(baseStart + inBase) };
  // Path-segment prefix ("comp" matches src/components/x.ts).
  let segStart = 0;
  for (const seg of folded.split("/")) {
    if (seg.startsWith(query)) return { score: 0.7, matches: range(segStart) };
    segStart += seg.length + 1;
  }
  const inPath = folded.indexOf(query);
  if (inPath >= 0) return { score: 0.6, matches: range(inPath) };
  // Fuzzy subsequence over the whole path; density nudges tighter matches up.
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < folded.length && qi < query.length; i++) {
    if (folded[i] === query[qi]) {
      if (first < 0) first = i;
      last = i;
      qi++;
    }
  }
  if (qi < query.length) return null;
  const span = Math.max(1, last - first + 1);
  const density = query.length / span; // 1 = contiguous
  return { score: 0.2 + 0.2 * density, matches: [] };
}

/** Reject rel paths that could escape the project root (`..`, absolute). */
export function assertRelative(rel: string): void {
  if (!rel || rel === ".") return;
  if (path.isAbsolute(rel) || rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  const parts = rel.split(/[/\\]/);
  if (parts.includes("..")) throw new Error(`Path escapes project root: ${rel}`);
}

async function resolveInside(
  root: string,
  rel: string,
  opts: { forWrite?: boolean; allowAbsolute?: boolean } = {},
): Promise<string> {
  // Read-only escape hatch: files the agent generated or read may live
  // anywhere (e.g. /tmp/opencode/…). An absolute path resolves as-is, so
  // the editor can view it; writes stay strictly project-scoped.
  if (opts.allowAbsolute && path.isAbsolute(rel)) return realpath(rel);
  // Markdown strips the leading slash from Unix paths so `/tmp/a.png` reaches
  // the file pane as `tmp/a.png`. For read-only operations, recover that path
  // only when the project-relative candidate does not exist.
  if (opts.allowAbsolute && rel.startsWith("tmp/")) {
    try {
      return await realpath(path.resolve(root, rel));
    } catch {
      return realpath(`/${rel}`);
    }
  }
  assertRelative(rel);
  const rootAbs = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  const joined = path.resolve(rootAbs, rel || ".");
  const relToRoot = path.relative(rootAbs, joined);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  try {
    const real = await realpath(joined);
    const relReal = path.relative(rootReal, real);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
      throw new Error(`Path escapes project root: ${rel}`);
    }
    return real;
  } catch (err) {
    if (!opts.forWrite) throw err instanceof Error ? err : new Error(String(err));
    // File may not exist yet — walk up to an existing ancestor and realpath it.
    let dir = path.dirname(joined);
    for (;;) {
      try {
        const realDir = await realpath(dir);
        const relDir = path.relative(rootReal, realDir);
        if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
          throw new Error(`Path escapes project root: ${rel}`);
        }
        return joined;
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith("Path escapes")) throw inner;
        const parent = path.dirname(dir);
        if (parent === dir) return joined;
        dir = parent;
      }
    }
  }
}
