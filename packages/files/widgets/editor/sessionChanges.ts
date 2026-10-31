/** Pure, browser-safe derivation of "what did this session change" for the Files tree.
 *
 * The canonical source is the session's file-edit tool messages (`changedFiles`
 * extracted by the shared reducer, so it works for every harness). Git status
 * only refines the kind (untracked → created, deleted → deleted); dirt this
 * session did not write is never highlighted.
 */

export type ChangeKind = "created" | "modified" | "deleted";

export interface SessionChange {
  kind: ChangeKind;
  /** Event sequence of the last tool call that touched the path. */
  seq: number;
  /** Touched after the session's latest user message (the current/last turn). */
  latestTurn: boolean;
}

export interface ChangeSourceMessage {
  kind: string;
  tool?: string;
  eventSeq?: number;
  changedFiles?: readonly string[];
  undone?: boolean;
  status?: string;
}

export interface GitKindEntry {
  path: string;
  status: string;
}

const DELETE_TOOL = /(?:^|[./:_-])(?:delete|unlink|remove|rm)(?:[./:_-]|$)|delete[_-]?file/i;
const CREATE_TOOL = /create[_-]?file|new[_-]?file|(?:^|[./:_-])create(?:[./:_-]|$)/i;

export function toolChangeKind(tool: string | undefined): ChangeKind {
  if (!tool) return "modified";
  if (DELETE_TOOL.test(tool)) return "deleted";
  if (CREATE_TOOL.test(tool)) return "created";
  return "modified";
}

const normalize = (value: string): string => value.trim().replaceAll("\\", "/");

/** Repo-relative path, or null when the path is absolute and outside every known root. */
export function relativeToRoots(path: string, roots: readonly string[]): string | null {
  let value = normalize(path);
  if (!value || value.includes("\0")) return null;
  const sorted = roots
    .map((root) => normalize(root).replace(/\/+$/, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    if (value === root) return null;
    if (value.startsWith(`${root}/`)) { value = value.slice(root.length + 1); break; }
  }
  value = value.replace(/^(?:\.\/)+/, "");
  if (/^(?:\/|[a-z]:\/)/i.test(value)) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

function merge(previous: ChangeKind | undefined, next: ChangeKind): ChangeKind {
  if (next === "deleted") return "deleted";
  if (previous === "deleted") return "modified"; // recreated
  if (previous === "created") return "created";
  return next;
}

/**
 * Per-path change map for one repository. `roots` are the absolute prefixes
 * (repository path, session worktree path) used to relativize tool paths.
 */
export function collectSessionChanges(
  messages: readonly ChangeSourceMessage[],
  roots: readonly string[],
  git: readonly GitKindEntry[] = [],
): Map<string, SessionChange> {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.kind === "user" && !message.undone) lastUser = index;
  });
  const changes = new Map<string, SessionChange>();
  messages.forEach((message, index) => {
    if (message.kind !== "tool" || message.undone || message.status === "error") return;
    const toolKind = toolChangeKind(message.tool);
    for (const file of message.changedFiles ?? []) {
      const path = relativeToRoots(file, roots);
      if (!path) continue;
      const existing = changes.get(path);
      changes.set(path, {
        kind: merge(existing?.kind, toolKind),
        seq: message.eventSeq ?? index,
        latestTurn: index > lastUser,
      });
    }
  });
  for (const entry of git) {
    const path = relativeToRoots(entry.path, []);
    const change = path ? changes.get(path) : undefined;
    if (!path || !change) continue;
    if (entry.status === "untracked" || entry.status === "added") {
      if (change.kind !== "deleted") change.kind = "created";
    } else if (entry.status === "deleted") {
      change.kind = "deleted";
    }
  }
  return changes;
}

export interface FolderRollup {
  count: number;
  latestTurn: boolean;
  /** Only deletions below this folder. */
  deletedOnly: boolean;
}

/** Every ancestor folder → number of changed descendants (root `""` excluded). */
export function rollupFolders(changes: ReadonlyMap<string, SessionChange>): Map<string, FolderRollup> {
  const folders = new Map<string, FolderRollup>();
  for (const [path, change] of changes) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const entry = folders.get(current) ?? { count: 0, latestTurn: false, deletedOnly: true };
      entry.count += 1;
      entry.latestTurn ||= change.latestTurn;
      entry.deletedOnly &&= change.kind === "deleted";
      folders.set(current, entry);
    }
  }
  return folders;
}

/** Changed-only filter: keep changed files and folders that contain one. */
export function isVisibleWhenChangedOnly(
  path: string,
  isDir: boolean,
  changes: ReadonlyMap<string, SessionChange>,
  folders: ReadonlyMap<string, FolderRollup>,
): boolean {
  return isDir ? folders.has(path) : changes.has(path);
}

/** Deleted files absent from the listing, to render as ghost rows under `dir`. */
export function deletedChildren(
  dir: string,
  listed: readonly { path: string }[],
  changes: ReadonlyMap<string, SessionChange>,
): string[] {
  const present = new Set(listed.map((entry) => entry.path));
  const result: string[] = [];
  for (const [path, change] of changes) {
    if (change.kind !== "deleted" || present.has(path)) continue;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent === dir) result.push(path);
  }
  return result.sort();
}

/**
 * Folders under `dir` that hold deleted files but are missing from the listing
 * (the whole folder was removed), so their ghost files stay reachable.
 */
export function deletedFolders(
  dir: string,
  listed: readonly { path: string }[],
  changes: ReadonlyMap<string, SessionChange>,
): string[] {
  const present = new Set(listed.map((entry) => entry.path));
  const prefix = dir ? `${dir}/` : "";
  const result = new Set<string>();
  for (const [path, change] of changes) {
    if (change.kind !== "deleted" || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length).split("/");
    if (rest.length < 2) continue;
    const folder = `${prefix}${rest[0]}`;
    if (!present.has(folder)) result.add(folder);
  }
  return [...result].sort();
}

/** Stable key; changes when the changed set (or a kind) changes, to trigger a tree refresh. */
export function changesKey(changes: ReadonlyMap<string, SessionChange>): string {
  return [...changes].map(([path, change]) => `${path}:${change.kind}`).sort().join("\0");
}
