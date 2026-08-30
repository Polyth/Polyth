import type { JsonObject } from "@polyth/contracts";
import type { GitStatus } from "@polyth/session/web-api";

const WRITE_TOOL = /(^|[./:_-])(apply[_-]?patch|create[_-]?file|delete[_-]?file|edit|multiedit|patch|write)([./:_-]|$)/i;
const PATH_KEY = /^(changedFiles|file|filePath|filename|files|path|paths|target)$/i;
const PATCH_FILE = /^\*{3} (?:Add|Delete|Update) File:\s*(.+)$/gm;

function usablePath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.includes("\0") || path.includes("\n") || /^[a-z]+:\/\//i.test(path)) return null;
  return path;
}

/** Equal paths, or the longer ends with `"/" + shorter` so `foo.ts` never matches `barfoo.ts`. */
function pathsShareSegmentSuffix(left: string, right: string): boolean {
  if (left === right) return true;
  const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left];
  return longer.endsWith(`/${shorter}`);
}

/** Prefer the longest dirty path when a session write matches several (`pkg/src/a.ts` over `src/a.ts`). */
function longestMatchingDirtyPath(sessionPath: string, dirtyPaths: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const dirty of dirtyPaths) {
    if (!pathsShareSegmentSuffix(sessionPath, dirty)) continue;
    if (best === undefined || dirty.length > best.length) best = dirty;
  }
  return best;
}

function collectPathValue(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const path = usablePath(value);
    if (path) out.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValue(item, out);
    return;
  }
  if (value && typeof value === "object") collectPathFields(value as JsonObject, out);
}

function collectPathFields(value: JsonObject, out: Set<string>): void {
  for (const [key, child] of Object.entries(value)) {
    if (PATH_KEY.test(key)) collectPathValue(child, out);
    else if (child && typeof child === "object") collectPathValue(child, out);
    if (typeof child === "string" && /^(patch|patchText)$/i.test(key)) {
      for (const match of child.matchAll(PATCH_FILE)) {
        const path = usablePath(match[1] ?? "");
        if (path) out.add(path);
      }
    }
  }
}

/** Extract file writes only from edit-like tools; read/search paths do not count. */
export function extractChangedFiles(tool: string, input: JsonObject, metadata?: JsonObject): string[] {
  if (!WRITE_TOOL.test(tool)) return [];
  const paths = new Set<string>();
  collectPathFields(input, paths);
  if (metadata) collectPathFields(metadata, paths);
  return [...paths];
}

export function gitChangedFiles(status: GitStatus): string[] {
  const paths = new Set<string>();
  for (const file of [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted]) {
    const path = usablePath(file.path);
    if (path) paths.add(path);
  }
  return [...paths];
}

export interface PendingChangeSource {
  source: "git" | "tools";
  paths: string[];
}

function usableToolPaths(toolPaths: readonly string[]): string[] {
  return [...new Set(toolPaths.map((path) => usablePath(path)).filter((path): path is string => path !== null))];
}

/** Union of edit-tool paths from every tool message in the active render model. */
export function sessionEditedPaths(
  messages: readonly { kind: string; changedFiles?: readonly string[] }[],
): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "tool") continue;
    for (const file of message.changedFiles ?? []) {
      const path = usablePath(file);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * Session edit-tool paths are the source of truth. When git status is
 * available, keep session writes that are still dirty (suffix-matched to
 * git-relative paths); extra worktree dirt never appears. Empty session
 * tools hide the card.
 */
export function selectPendingChanges(
  status: GitStatus | null,
  toolPaths: readonly string[],
): PendingChangeSource {
  const sessionPaths = usableToolPaths(toolPaths);
  if (sessionPaths.length === 0) return { source: status ? "git" : "tools", paths: [] };
  if (!status) return { source: "tools", paths: sessionPaths };
  const dirty = gitChangedFiles(status);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const sessionPath of sessionPaths) {
    const match = longestMatchingDirtyPath(sessionPath, dirty);
    if (match === undefined || seen.has(match)) continue;
    seen.add(match);
    paths.push(match);
  }
  return { source: "git", paths };
}
