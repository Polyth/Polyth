// Host directory browsing for the project folder picker. Unlike FileService
// this is NOT project-scoped: it lists directories anywhere the server user
// can read, so the HTTP layer must expose it to localhost only. Sensitive
// pseudo-filesystems are refused outright.
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface BrowseEntry {
  name: string;
  /** Absolute path of the directory. */
  path: string;
  /** Last modification time (ms since epoch), when readable. */
  modifiedAt?: number;
  hidden: boolean;
}

export interface BrowseResult {
  /** Absolute, resolved path that was listed. */
  path: string;
  /** Absolute parent path, or null at the filesystem root. */
  parent: string | null;
  /** The server user's home directory (the picker's default root). */
  home: string;
  entries: BrowseEntry[];
}

export interface BrowseOptions {
  /** Include dot-directories. Default false. */
  hidden?: boolean;
}

/** Path prefixes that are never browsable: kernel/device pseudo-filesystems
 *  hold nothing a project picker should touch and can hang on read. */
const BLOCKED_PREFIXES = ["/proc", "/sys", "/dev"];

const browseError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

export function isBlockedHostPath(abs: string): boolean {
  const norm = path.resolve(abs);
  return BLOCKED_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`));
}

/** Expand `~`, default to the home directory, and resolve to an absolute path. */
export function resolveHostPath(raw: string | undefined | null, home: string = homedir()): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "~") return home;
  const expanded = trimmed === "~" ? home
    : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2))
    : trimmed;
  if (!path.isAbsolute(expanded)) {
    throw browseError("invalid-path", `Path must be absolute (or start with ~): ${trimmed}`);
  }
  return path.resolve(expanded);
}

/** List the sub-directories of an absolute host path (folders only). */
export async function browseHost(rawPath?: string | null, opts: BrowseOptions = {}): Promise<BrowseResult> {
  const home = homedir();
  const abs = resolveHostPath(rawPath, home);
  if (isBlockedHostPath(abs)) throw browseError("invalid-path", `Browsing ${abs} is not allowed`);

  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw browseError("not-found", `No such directory: ${abs}`);
  }
  if (isBlockedHostPath(real)) throw browseError("invalid-path", `Browsing ${real} is not allowed`);
  const st = await lstat(real);
  if (!st.isDirectory()) throw browseError("invalid-path", `Not a directory: ${abs}`);

  const showHidden = opts.hidden === true;
  const names = await readdir(real, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const ent of names) {
    const hidden = ent.name.startsWith(".");
    if (hidden && !showHidden) continue;
    const childAbs = path.join(real, ent.name);
    // Follow symlinks one level so linked folders are enterable, but skip
    // anything that resolves into a blocked pseudo-filesystem.
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try {
        const target = await realpath(childAbs);
        if (isBlockedHostPath(target)) continue;
        isDir = (await stat(target)).isDirectory();
      } catch {
        continue; // broken link
      }
    }
    if (!isDir) continue;
    if (isBlockedHostPath(childAbs)) continue;
    const entry: BrowseEntry = { name: ent.name, path: childAbs, hidden };
    try {
      const cs = await lstat(childAbs);
      entry.modifiedAt = Math.round(cs.mtimeMs);
    } catch { /* unreadable child: still listed, just without a date */ }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.hidden !== b.hidden ? (a.hidden ? 1 : -1) : a.name.localeCompare(b.name)));

  const parent = path.dirname(real);
  return {
    path: real,
    parent: parent === real ? null : parent,
    home,
    entries,
  };
}

/** Create a directory (recursively) on the host, for "create folder if missing". */
export async function mkdirHost(rawPath: string): Promise<{ path: string }> {
  const abs = resolveHostPath(rawPath);
  if (isBlockedHostPath(abs)) throw browseError("invalid-path", `Creating ${abs} is not allowed`);
  await mkdir(abs, { recursive: true });
  return { path: abs };
}
