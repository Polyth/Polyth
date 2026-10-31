// Which files an agent tool call wrote, read from its payload. One canonical
// rule shared by the web reducer (live session render model) and server-side
// readers of the canonical event log, so both agree on what counts as an edit.
// Pure and browser-safe: no filesystem access, paths are returned as written.
import type { JsonObject } from "./index.ts";

/** File-mutating names used by Cursor, Claude, Codex and ACP (`StrReplace`, `Write`, `edit`). */
export function isFileMutatingTool(tool: string): boolean {
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

/** A tool path usable as a file locator: trimmed, `/`-separated, no `./`
 *  prefix; null for empty, NUL/newline-bearing or URL values. */
export function usableToolPath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.includes("\0") || path.includes("\n") || /^[a-z]+:\/\//i.test(path)) return null;
  return path;
}

function collectPathValue(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const path = usableToolPath(value);
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
        const path = usableToolPath(match[1] ?? "");
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
