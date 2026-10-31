export { discoverRepositories } from "./repositoryDiscovery.ts";
// Project-scoped filesystem. Every path is relative to a project root;
// escapes (`..`, absolute, symlink-out) are rejected.
import { mkdir, open, readFile, readdir, lstat, realpath, rename as move, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { DEFAULT_EXTERNAL_READ_POLICY, resolveExternalRead, type ExternalReadPolicy } from "./externalReads.ts";

export { browseHost, mkdirHost, resolveHostPath, isBlockedHostPath } from "./browse.ts";
export type { BrowseEntry, BrowseOptions, BrowseResult } from "./browse.ts";

const MAX_READ = 512 * 1024;
const MAX_EDIT = 8 * 1024 * 1024;
const BINARY_SCAN = 8 * 1024;
const MAX_RAW = 20 * 1024 * 1024;

/** Shared binary cap: raw serving, uploads, and message attachments. */
export const MAX_RAW_BYTES = MAX_RAW;
/** Preview cap: how much text a browse/hover/inline read serves by default.
 *  Shared with the remote implementation (see remote.ts). This is a transfer
 *  cost decision, not a data boundary — a caller that is going to EDIT asks
 *  for `editable` and gets MAX_EDIT_BYTES instead. */
export const MAX_READ_BYTES = MAX_READ;
/** Editable cap. A document opened for editing must hold the file's complete
 *  contents, because that buffer is what a save writes back; a truncated
 *  buffer would silently delete the tail. Files past this cap stay `truncated`
 *  (and therefore read-only) rather than risk that. */
export const MAX_EDIT_BYTES = MAX_EDIT;
/** NUL-scan length shared with the remote implementation (see remote.ts). */
export const BINARY_SCAN_BYTES = BINARY_SCAN;

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  /** Last modification time (epoch ms) for sorting and row metadata. */
  mtime?: number;
  /** Git ignore state is advisory UI metadata; path authority remains scoped. */
  ignored?: boolean;
}

export interface FileReadOptions {
  /** Read for an editable document: serve up to MAX_EDIT_BYTES instead of the
   *  preview cap, so the caller's buffer is the whole file. */
  editable?: boolean;
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

export interface FileContentSearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface ContentSearchOptions {
  limit?: number;
  signal?: AbortSignal;
  /** Relative glob filters applied after Git-ignore filtering. */
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface FileContentSearchResult {
  hits: FileContentSearchHit[];
  /** True when traversal/time/result bounds prevented a complete scan. */
  truncated: boolean;
}

export interface FileListOptions {
  /** Folder to list under ("" = root). */
  path?: string;
  hidden?: boolean;
  /** Entry cap; the result says when it was reached. */
  limit?: number;
}

export interface FileListResult {
  /** Files only (folders are implied by their paths), path order. */
  entries: FileEntry[];
  /** True when the entry/time bound stopped the walk early. */
  truncated: boolean;
}

export interface FileService {
  tree(root: string, opts?: { path?: string; hidden?: boolean }): Promise<FileEntry[]>;
  /** Every file under a folder (flat list view, folder archives). Skips the
   *  same heavy dependency/build folders search does, `.git` and symlinks. */
  list(root: string, opts?: FileListOptions): Promise<FileListResult>;
  read(root: string, rel: string, opts?: FileReadOptions): Promise<FileReadResult>;
  stat(root: string, rel: string): Promise<FileStatResult>;
  readRaw(root: string, rel: string): Promise<FileRawResult>;
  write(root: string, rel: string, content: string, opts?: WriteOptions): Promise<{ revision: string }>;
  writeBytes(root: string, rel: string, data: Uint8Array): Promise<void>;
  mkdir(root: string, rel: string): Promise<void>;
  remove(root: string, rel: string): Promise<void>;
  rename(root: string, from: string, to: string): Promise<void>;
  /** Legacy string results (paths only), ordered by relevance. */
  search(root: string, q: string, limit: number): Promise<string[]>;
  /** Scored search over names and paths (palette/mentions). */
  searchScored(root: string, q: string, opts?: SearchOptions): Promise<FileSearchHit[]>;
  /** Bounded literal text search over project files. */
  searchContent(root: string, q: string, opts?: ContentSearchOptions): Promise<FileContentSearchResult>;
}

/** Internal seams used by deterministic service tests; production keeps the
 * platform `git` lookup. */
export interface FileServiceOptions {
  gitBinary?: string;
  gitIgnoreOutputBytes?: number;
  /** Folders and file types a read may open outside the project, read per
   *  call so an owner's change applies at once. Default: the temp folder,
   *  media/PDF/text only. */
  externalReads?: () => ExternalReadPolicy;
}

const posix = (p: string): string => p.split(path.sep).join("/");

const betaWriteDenied = (): never => {
  throw Object.assign(
    new Error("Agent beta mode is read-only for the workspace; filesystem mutations are disabled."),
    { code: "forbidden" },
  );
};

const assertBetaWritable = (): void => {
  if (process.env.POLYTH_AGENT_BETA === "1") betaWriteDenied();
};

/** Cheap revision token: changes whenever content plausibly changed. */
const revisionOf = (st: { mtimeMs: number; size: number }): string =>
  `${st.mtimeMs.toString(36)}-${st.size.toString(36)}`;

export function createFileService(options: FileServiceOptions = {}): FileService {
  const externalReads = options.externalReads ?? (() => DEFAULT_EXTERNAL_READ_POLICY);
  return {
    async tree(root, opts = {}) {
      const rel = opts.path ?? "";
      let abs: string;
      try {
        abs = await resolveInside(root, rel);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(rel, "Directory");
        throw err;
      }
      let st;
      try {
        st = await lstat(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(rel, "Directory");
        throw err;
      }
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
        try {
          const s = await lstat(path.join(abs, ent.name));
          if (!isDir && s.isFile()) item.size = s.size;
          item.mtime = Math.round(s.mtimeMs);
        } catch { /* ignore */ }
        out.push(item);
      }
      // Check one bounded batch for this directory. The tree can then render
      // ignored rows quietly or filter them without per-row Git probes.
      try {
        const ignored = await gitIgnoredPaths(
          root, out.map((item) => item.path), undefined, undefined, undefined, TREE_GIT_IGNORE_TIMEOUT_MS,
        );
        for (const item of out) if (ignored.has(item.path)) item.ignored = true;
      } catch {
        // Git is optional; absence or a transient check failure leaves rows
        // visible and avoids turning a browse request into an outage.
      }
      out.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return out;
    },

    async list(root, opts = {}) {
      const base = opts.path ?? "";
      const limit = boundedListLimit(opts.limit);
      const hidden = opts.hidden === true;
      let baseAbs: string;
      try {
        baseAbs = await resolveInside(root, base);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(base, "Directory");
        throw err;
      }
      const entries: FileEntry[] = [];
      let truncated = false;
      const deadline = Date.now() + LIST_TIME_BUDGET_MS;
      const walk = async (dirAbs: string, rel: string): Promise<void> => {
        if (truncated) return;
        let children;
        try {
          children = await readdir(dirAbs, { withFileTypes: true });
        } catch (error) {
          if (rel === base) throw error;
          return;
        }
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const ent of children) {
          if (entries.length >= limit || Date.now() > deadline) { truncated = true; return; }
          if (IGNORED_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
          if (!hidden && ent.name.startsWith(".")) continue;
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          const childAbs = path.join(dirAbs, ent.name);
          if (ent.isDirectory()) {
            await walk(childAbs, childRel);
            if (truncated) return;
          } else if (ent.isFile()) {
            const item: FileEntry = { name: ent.name, path: childRel, dir: false };
            try {
              const s = await lstat(childAbs);
              item.size = s.size;
              item.mtime = Math.round(s.mtimeMs);
            } catch { /* listed without metadata */ }
            entries.push(item);
          }
        }
      };
      await walk(baseAbs, posix(base));
      try {
        const ignored = await gitIgnoredPaths(root, entries.map((entry) => entry.path), undefined, options.gitBinary, options.gitIgnoreOutputBytes);
        for (const entry of entries) if (ignored.has(entry.path)) entry.ignored = true;
      } catch { /* Git is optional: rows stay unmarked */ }
      return { entries, truncated };
    },

    async read(root, rel, opts) {
      const abs = await resolveInside(root, rel, { external: externalReads() });
      const cap = opts?.editable ? MAX_EDIT : MAX_READ;
      let fh;
      try {
        fh = await open(abs, "r");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(rel);
        throw err;
      }
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
        if (st.size > cap) {
          const buf = Buffer.alloc(cap);
          await fh.read(buf, 0, cap, 0);
          return { path: posix(rel), content: buf.toString("utf8"), truncated: true, revision };
        }
        const content = await readFile(abs, "utf8");
        return { path: posix(rel), content, truncated: false, revision };
      } finally {
        await fh.close();
      }
    },

    async stat(root, rel) {
      const abs = await resolveInside(root, rel, { external: externalReads() });
      let st;
      try {
        st = await lstat(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(rel);
        throw err;
      }
      const kind = st.isDirectory() ? "dir" as const : "file" as const;
      const out: FileStatResult = { path: posix(rel), kind, size: st.size };
      if (kind === "file") {
        out.mime = rawMimeOf(rel);
        out.revision = revisionOf(st);
      }
      return out;
    },

    async readRaw(root, rel) {
      const abs = await resolveInside(root, rel, { external: externalReads() });
      let st;
      try {
        st = await lstat(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(rel);
        throw err;
      }
      if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
      if (st.size > MAX_RAW) throw new Error(`File too large to serve raw: ${rel}`);
      const data = await readFile(abs);
      return { data, mime: rawMimeOf(rel), size: st.size };
    },

    async write(root, rel, content, opts = {}) {
      assertBetaWritable();
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
      assertBetaWritable();
      const abs = await resolveInside(root, rel, { forWrite: true });
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, data);
      await resolveInside(root, rel);
    },

    async mkdir(root, rel) {
      assertBetaWritable();
      const abs = await resolveInside(root, rel, { forWrite: true });
      await mkdir(abs, { recursive: true });
      await resolveInside(root, rel);
    },

    async remove(root, rel) {
      assertBetaWritable();
      const abs = await resolveInside(root, rel);
      await rm(abs, { recursive: true });
    },

    async rename(root, from, to) {
      assertBetaWritable();
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

    async searchContent(root, q, opts = {}) {
      const query = q;
      if (!query.trim()) return { hits: [], truncated: false };
      const limit = boundedContentLimit(opts.limit);
      const signal = opts.signal;
      const deadline = Date.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
      const filesToCheck: string[] = [];
      let visited = 0;
      let truncated = false;
      const include = normalizeGlobs(opts.include);
      const exclude = normalizeGlobs(opts.exclude);

      const walk = async (dirAbs: string, rel: string): Promise<void> => {
        abortContentSearch(signal);
        if (visited >= CONTENT_SEARCH_MAX_ENTRIES || Date.now() > deadline) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = await readdir(dirAbs, { withFileTypes: true });
        } catch (error) {
          if (!rel) throw error;
          return;
        }
        for (const ent of entries) {
          abortContentSearch(signal);
          if (visited >= CONTENT_SEARCH_MAX_ENTRIES || Date.now() > deadline) {
            truncated = true;
            return;
          }
          visited++;
          if (IGNORED_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory() && exclude.some((pattern) => globMatches(pattern, childRel) || globMatches(pattern, `${childRel}/`))) continue;
          if (ent.isDirectory()) {
            await walk(path.join(dirAbs, ent.name), childRel);
          } else if (ent.isFile()) {
            if (!include.length || include.some((pattern) => globMatches(pattern, childRel))) {
              if (!exclude.some((pattern) => globMatches(pattern, childRel))) filesToCheck.push(childRel);
            }
          }
        }
      };
      await walk(path.resolve(root), "");
      if (Date.now() > deadline) truncated = true;
      filesToCheck.sort((a, b) => a.localeCompare(b));
      const ignored = await gitIgnoredPaths(root, filesToCheck, signal, options.gitBinary, options.gitIgnoreOutputBytes);
      const hits: FileContentSearchHit[] = [];
      for (const rel of filesToCheck) {
        abortContentSearch(signal);
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        if (ignored.has(rel)) continue;
        let fh;
        try {
          const abs = await resolveInside(root, rel);
          fh = await open(abs, "r");
          const st = await fh.stat();
          if (!st.isFile() || st.size > CONTENT_SEARCH_MAX_FILE_BYTES) continue;
          const buf = Buffer.alloc(st.size);
          await fh.read(buf, 0, st.size, 0);
          if (buf.subarray(0, BINARY_SCAN).includes(0)) continue;
          const text = buf.toString("utf8");
          let from = 0;
          while (from < text.length && hits.length < limit) {
            abortContentSearch(signal);
            const at = text.indexOf(query, from);
            if (at < 0) break;
            const lineStart = text.lastIndexOf("\n", at - 1) + 1;
            const lineEndAt = text.indexOf("\n", at);
            const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
            const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, "");
            hits.push({
              path: posix(rel),
              line: 1 + countNewlines(text, at),
              column: 1 + at - lineStart,
              preview: boundedPreview(lineText, at - lineStart, query.length),
            });
            from = at + Math.max(1, query.length);
          }
          if (hits.length >= limit) truncated = true;
        } catch (error) {
          // Files can disappear or become unreadable during a workspace scan.
          if (signal?.aborted) abortContentSearch(signal);
        } finally {
          if (fh) await fh.close().catch(() => {});
        }
      }
      if (Date.now() > deadline) truncated = true;
      return { hits, truncated };
    },
  };
}

const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".cache", "target", "__pycache__", ".venv",
]);
const SEARCH_MAX_ENTRIES = 20_000;
/** Flat listing bounds: enough for a large app, never a whole monorepo dump. */
export const LIST_MAX_ENTRIES = 10_000;
const LIST_TIME_BUDGET_MS = 3_000;
const boundedListLimit = (value: number | undefined): number =>
  Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value!) : LIST_MAX_ENTRIES, LIST_MAX_ENTRIES));
const SEARCH_TIME_BUDGET_MS = 400;
const CONTENT_SEARCH_MAX_FILE_BYTES = 1 * 1024 * 1024;
const CONTENT_SEARCH_MAX_ENTRIES = 20_000;
const CONTENT_SEARCH_MAX_RESULTS = 200;
const CONTENT_SEARCH_TIME_BUDGET_MS = 1_000;
const CONTENT_SEARCH_PREVIEW_CHARS = 240;

const MAX_GLOB_COUNT = 16;
const MAX_GLOB_LENGTH = 160;

function normalizeGlobs(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values
    .map((value) => value.trim().replaceAll("\\", "/"))
    .filter((value) => value.length > 0 && value.length <= MAX_GLOB_LENGTH
      && !value.startsWith("/") && !value.includes("\0")
      && !value.split("/").includes(".."))
    .slice(0, MAX_GLOB_COUNT);
}

function globMatches(glob: string, candidate: string): boolean {
  let expression = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") { expression += ".*"; i++; }
      else expression += "[^/]*";
    } else if (char === "?") expression += "[^/]";
    else expression += /[\\^$+{}()[\].|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${expression}$`).test(candidate);
}

function boundedContentLimit(value: number | undefined): number {
  return Math.max(1, Math.min(CONTENT_SEARCH_MAX_RESULTS, Number.isFinite(value) ? Math.floor(value!) : 50));
}

function abortContentSearch(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("content search aborted"), { name: "AbortError", code: "aborted" });
}

function countNewlines(text: string, end: number): number {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0 && at < end; at = text.indexOf("\n", at + 1)) count++;
  return count;
}

function boundedPreview(line: string, matchStart: number, matchLength: number): string {
  if (line.length <= CONTENT_SEARCH_PREVIEW_CHARS) return line;
  if (matchLength >= CONTENT_SEARCH_PREVIEW_CHARS) {
    return `${line.slice(matchStart, matchStart + CONTENT_SEARCH_PREVIEW_CHARS - 1)}…`;
  }
  const half = Math.floor((CONTENT_SEARCH_PREVIEW_CHARS - matchLength) / 2);
  let start = Math.max(0, matchStart - half);
  let end = Math.min(line.length, start + CONTENT_SEARCH_PREVIEW_CHARS);
  if (end - start < CONTENT_SEARCH_PREVIEW_CHARS) start = Math.max(0, end - CONTENT_SEARCH_PREVIEW_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  const room = CONTENT_SEARCH_PREVIEW_CHARS - prefix.length - suffix.length;
  return `${prefix}${line.slice(start, start + room)}${suffix}`;
}

async function gitIgnoredPaths(
  root: string,
  paths: string[],
  signal?: AbortSignal,
  gitBinary = "git",
  outputBytes = CONTENT_SEARCH_GIT_OUTPUT_BYTES,
  timeoutMs = CONTENT_SEARCH_GIT_TIMEOUT_MS,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  abortContentSearch(signal);
  return await new Promise<Set<string>>((resolve, reject) => {
    const child = spawn(gitBinary, ["check-ignore", "--stdin", "-z", "--no-index"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ignored = new Set<string>();
    let output = "";
    let outputTruncated = false;
    let done = false;
    const finish = (result?: Set<string>, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result ?? new Set());
    };
    const abort = () => {
      child.kill();
      finish(undefined, signal?.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("content search aborted"), { name: "AbortError", code: "aborted" }));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined, Object.assign(new Error("git ignore check timed out"), { code: "unavailable" }));
    }, timeoutMs);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputTruncated) return;
      const used = Buffer.byteLength(output, "utf8");
      const incoming = Buffer.byteLength(chunk, "utf8");
      const remaining = outputBytes - used;
      if (incoming >= remaining) outputTruncated = true;
      if (remaining > 0) {
        output += Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
      }
    });
    child.stdin.on("error", (error: Error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") finish(undefined, error);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") finish(new Set());
      else finish(undefined, error);
    });
    child.on("close", (code) => {
      if (outputTruncated) {
        finish(undefined, Object.assign(new Error("git ignore check output exceeded the search bound"), { code: "unavailable" }));
      } else if (code === 0) {
        for (const value of output.split("\0")) if (value) ignored.add(value);
        finish(ignored);
      } else if (code === 1 || (code === 128 && /not a git repository/i.test(stderr))) {
        // Git is unavailable as a repository-aware ignore source. The caller
        // still applies the portable heavy-directory defaults.
        finish(new Set());
      } else if (!done) {
        finish(undefined, Object.assign(new Error(stderr.trim() || `git check-ignore exited (${code ?? "unknown"})`), { code: "unavailable" }));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

const CONTENT_SEARCH_GIT_TIMEOUT_MS = 300;
// One check per listed directory; a cold or loaded host can need more than the
// search budget just to spawn Git, and a miss silently drops ignore marks.
const TREE_GIT_IGNORE_TIMEOUT_MS = 2_000;
const CONTENT_SEARCH_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

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

/** An absolute path inside the project (as given or after resolving the
 *  root's symlinks), relative to it; null when it lies outside. */
async function projectRelative(root: string, file: string): Promise<string | null> {
  const target = path.resolve(file);
  const base = path.resolve(root);
  for (const candidate of [base, await realpath(base).catch(() => base)]) {
    const rel = path.relative(candidate, target);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return null;
}

function notFound(rel: string, kind: "File" | "Directory" = "File"): Error {
  return Object.assign(new Error(`${kind} not found: ${rel || "."}`), { code: "not-found" });
}

async function resolveInside(
  root: string,
  rel: string,
  opts: { forWrite?: boolean; external?: ExternalReadPolicy } = {},
): Promise<string> {
  // Read-only views may open an absolute path (an agent's screenshot in /tmp,
  // a file a tool printed). Inside the project it is an ordinary jailed path;
  // outside, only the owner's folders and file types open. Writes never pass
  // `external`, so they stay project-scoped.
  if (opts.external && path.isAbsolute(rel)) {
    const inside = await projectRelative(root, rel);
    return inside === null ? resolveExternalRead(opts.external, rel) : resolveInside(root, inside);
  }
  // Markdown strips the leading slash from Unix paths so `/tmp/a.png` reaches
  // the file pane as `tmp/a.png`. For read-only operations, recover that path
  // only when the project-relative candidate does not exist.
  if (opts.external && rel.startsWith("tmp/")) {
    assertRelative(rel);
    try {
      return await resolveInside(root, rel);
    } catch (err) {
      if ((err as { code?: string }).code !== "not-found") throw err;
      return resolveExternalRead(opts.external, `/${rel}`, rel);
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
    // An existing link out of the root must not fall through to a write.
    if (err instanceof Error && err.message.startsWith("Path escapes")) throw err;
    // File may not exist yet — walk up to an existing ancestor and realpath it.
    // A write follows a dangling link, so one on the way counts as an escape.
    let dir = opts.forWrite ? joined : path.dirname(joined);
    for (;;) {
      try {
        const realDir = await realpath(dir);
        const relDir = path.relative(rootReal, realDir);
        if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
          throw new Error(`Path escapes project root: ${rel}`);
        }
        break;
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith("Path escapes")) throw inner;
        if (opts.forWrite && (await lstat(dir).catch(() => null))?.isSymbolicLink()) {
          throw new Error(`Path escapes project root: ${rel}`);
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    if (!opts.forWrite) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(rel);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return joined;
  }
}
