import type { JsonObject } from "@polyth/contracts";
import type { GitStatus } from "@polyth/session/web-api";

/** File-mutating names used by Cursor, Claude, Codex and ACP (`StrReplace`, `Write`, `edit`). */
function isFileMutatingTool(tool: string): boolean {
  const value = tool.toLowerCase();
  if (!value) return false;
  if (/(?:^|[./:_-])(?:task|subagent)(?:[./:_-]|$)/.test(value)) return false;
  if (/read/.test(value) && !/write|edit|replace|patch/.test(value)) return false;
  if (/(?:grep|glob|ripgrep|(?:^|[./:_-])search(?:[./:_-]|$))/.test(value) && !/replace/.test(value)) return false;
  return /apply[_-]?patch|create[_-]?file|delete[_-]?file|multiedit|edit|patch|replace|sed[._-]?file|(?:^|[./:_-])(?:write|save|delete|unlink|move|rename)(?:[./:_-]|$)/.test(value);
}
const PATH_KEY = /^(changedFiles|file|file_?path|filename|files|path|paths|target|target_?file|absolute_?path|notebook_?path|old_?path|new_?path)$/i;
const MUTATION_KEY = /^(old_?string|old_?text|new_?string|new_?text|patch|patch_?text|changes|target_?content|replacement_?content|code_?content|replacement_?chunks)$/i;
const PATCH_FILE = /^\*{3} (?:Add|Delete|Update) File:\s*(.+)$/gm;

function hasMutationFields(value: JsonObject): boolean {
  for (const [key, child] of Object.entries(value)) {
    if (MUTATION_KEY.test(key)) return true;
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && hasMutationFields(item as JsonObject)) return true;
      }
    } else if (child && typeof child === "object") {
      if (hasMutationFields(child as JsonObject)) return true;
    }
  }
  return false;
}

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
  const namedWrite = isFileMutatingTool(tool);
  const genericWrite = /^(?:other|tool)$/i.test(tool)
    && (hasMutationFields(input) || (metadata !== undefined && hasMutationFields(metadata)));
  if (!namedWrite && !genericWrite) return [];
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
  dirtyPaths: string[];
}

function usableToolPaths(toolPaths: readonly string[]): string[] {
  return [...new Set(toolPaths.map((path) => usablePath(path)).filter((path): path is string => path !== null))];
}

/** Map an OpenCode absolute path onto the git-relative form once it leaves the dirty set. */
export function relativizeToRepo(path: string, repoRoot: string): string {
  const normalized = path.replaceAll("\\", "/");
  const root = repoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!root) return normalized;
  if (normalized === root) return ".";
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
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
 * Session edit-tool paths are the source of truth. Git dirt is not a filter
 * for inclusion: leftover worktree files this session did not write never
 * appear, and empty session tools hide the control even when git is dirty.
 * After commit/push, session files stay listed with `source: "tools"`.
 */
export function selectPendingChanges(
  status: GitStatus | null,
  toolPaths: readonly string[],
  repoRoot?: string | null,
): PendingChangeSource {
  const sessionPaths = usableToolPaths(toolPaths);
  if (sessionPaths.length === 0) return { source: status ? "git" : "tools", paths: [], dirtyPaths: [] };
  if (!status) return { source: "tools", paths: sessionPaths, dirtyPaths: [] };
  const dirty = gitChangedFiles(status);
  const paths: string[] = [];
  const dirtyPaths: string[] = [];
  const seen = new Set<string>();
  for (const sessionPath of sessionPaths) {
    const match = longestMatchingDirtyPath(sessionPath, dirty);
    const display = match
      ?? (repoRoot ? relativizeToRepo(sessionPath, repoRoot) : sessionPath);
    if (seen.has(display)) continue;
    seen.add(display);
    paths.push(display);
    if (match !== undefined) dirtyPaths.push(display);
  }
  return { source: dirtyPaths.length > 0 ? "git" : "tools", paths, dirtyPaths };
}
