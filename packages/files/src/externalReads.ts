// Which files outside a project the read-only views (editor, raw media,
// stat) may open by absolute path. Installation-wide: folders are on the
// server's disk, not inside any one Space, so only the instance owner edits
// the list. Writes never leave the project, whatever this says.
import os from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";

export interface ExternalReadPolicy {
  /** Absolute folders; a file must sit inside one of them. */
  folders: string[];
  /** Lowercase extensions without the dot; a file must have one of them. */
  extensions: string[];
}

/** The temp folder (agents leave screenshots and renders there; chat links
 *  name the literal `/tmp` even when TMPDIR points elsewhere) and only the
 *  types the raw endpoint shows inline: media, PDF and plain text. */
export const DEFAULT_EXTERNAL_READ_POLICY: ExternalReadPolicy = {
  folders: [...new Set([os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])])],
  extensions: [
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
    "mp4", "m4v", "mov", "ogv", "webm",
    "aac", "flac", "m4a", "mp3", "oga", "ogg", "wav", "weba",
    "pdf", "txt", "md", "json", "csv", "log",
  ],
};

const MAX_FOLDERS = 32;
const MAX_EXTENSIONS = 64;
const EXTENSION_RE = /^[a-z0-9][a-z0-9_+-]{0,15}$/;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

/** Validate owner input. Bad entries are rejected, never silently dropped. */
export function normalizeExternalReadPolicy(input: unknown): ExternalReadPolicy {
  const value = (input ?? {}) as { folders?: unknown; extensions?: unknown };
  if (!Array.isArray(value.folders) || !Array.isArray(value.extensions)) {
    throw invalid("folders and extensions must be lists");
  }
  const folders = [...new Set(value.folders.map((folder) => {
    const text = typeof folder === "string" ? folder.trim() : "";
    if (!path.isAbsolute(text) || text.includes("\0")) throw invalid(`folder must be an absolute path: ${String(folder)}`);
    return path.resolve(text);
  }))];
  const extensions = [...new Set(value.extensions.map((extension) => {
    const text = typeof extension === "string" ? extension.trim().toLowerCase().replace(/^\./, "") : "";
    if (!EXTENSION_RE.test(text)) throw invalid(`not a file extension: ${String(extension)}`);
    return text;
  }))];
  if (folders.length > MAX_FOLDERS) throw invalid(`at most ${MAX_FOLDERS} folders`);
  if (extensions.length > MAX_EXTENSIONS) throw invalid(`at most ${MAX_EXTENSIONS} extensions`);
  return { folders, extensions };
}

const within = (folder: string, file: string): boolean => {
  const rel = path.relative(folder, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const allowed = (policy: ExternalReadPolicy, folders: readonly string[], file: string): boolean =>
  policy.extensions.includes(path.extname(file).slice(1).toLowerCase())
  && folders.some((folder) => within(folder, file));

const forbidden = (shown: string): Error => Object.assign(
  new Error(`Reading ${shown} is not allowed: files outside the project open only from the folders and file types in Settings → File editor`),
  { code: "forbidden" },
);

/** Lexical check, for hosts where the real path cannot be resolved (SSH). */
export function assertExternalReadPath(policy: ExternalReadPolicy, file: string, shown = file): void {
  if (!allowed(policy, policy.folders, file)) throw forbidden(shown);
}

/** Resolve an absolute path outside the project, or refuse it. The request is
 *  checked before the disk is touched (a refusal never reveals whether the
 *  file exists) and again after symlinks resolve, so a link inside an allowed
 *  folder cannot reach a file elsewhere or of another type. */
export async function resolveExternalRead(policy: ExternalReadPolicy, file: string, shown = file): Promise<string> {
  const realFolders = await Promise.all(policy.folders.map((folder) => realpath(folder).catch(() => folder)));
  const requested = path.resolve(file);
  if (!allowed(policy, [...policy.folders, ...realFolders], requested)) throw forbidden(shown);
  let real: string;
  try {
    real = await realpath(requested);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(`File not found: ${shown}`), { code: "not-found" });
    }
    throw err;
  }
  if (!allowed(policy, realFolders, real)) throw forbidden(shown);
  return real;
}

export interface ExternalReadStore {
  get(): ExternalReadPolicy;
  set(input: unknown): ExternalReadPolicy;
}

/** One JSON file in the package's installation data folder. A missing or
 *  unreadable file means the defaults. */
export function createExternalReadStore(dir: string): ExternalReadStore {
  const file = path.join(dir, "external-reads.json");
  let cached: ExternalReadPolicy | null = null;
  return {
    get() {
      if (cached) return cached;
      try {
        cached = normalizeExternalReadPolicy(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        cached = DEFAULT_EXTERNAL_READ_POLICY;
      }
      return cached;
    },
    set(input) {
      const next = normalizeExternalReadPolicy(input);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      cached = next;
      return next;
    },
  };
}
