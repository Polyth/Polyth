import { markProjectPresentationChanged } from "../../../../apps/web/src/projectPresentationSync.ts";

/** Pure, browser-safe state helpers for the Files tree.
 *
 * Tree presentation is scoped to the active project/session. It is deliberately
 * separate from pane/editor state: selecting a row does not change the active
 * editor, and an active editor does not rewrite the selected row.
 */

export interface TreeScope {
  projectId: string | null;
  sessionId: string | null;
  repositoryId?: string | null;
  storageNamespace?: string;
}

export interface TreePrefs {
  open: string[];
  selected: string;
  scrollTop: number;
}

export interface TreeRequestToken {
  scopeKey: string;
  generation: number;
}

const MAX_OPEN = 256;
const MAX_SELECTED = 2_048;

export const emptyTreePrefs: TreePrefs = { open: [], selected: "", scrollTop: 0 };

export function treeScopeKey(scope: TreeScope): string {
  const namespace = scope.storageNamespace
    ?? `polyth.files.tree.${scope.projectId ?? "none"}:${scope.sessionId ?? "project"}`;
  return `${namespace}:${JSON.stringify(scope.repositoryId ?? "primary")}`;
}

export function readTreePrefs(scope: TreeScope, storage: Storage | null = globalThis.localStorage): TreePrefs {
  if (!storage) return emptyTreePrefs;
  try {
    const raw = storage.getItem(treeScopeKey(scope));
    if (!raw) return emptyTreePrefs;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const open = Array.isArray(data.open)
      ? [...new Set(data.open.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, MAX_OPEN))]
      : [];
    const selected = typeof data.selected === "string" ? data.selected.slice(0, MAX_SELECTED) : "";
    const scrollTop = typeof data.scrollTop === "number" && Number.isFinite(data.scrollTop)
      ? Math.max(0, Math.round(data.scrollTop))
      : 0;
    return { open, selected, scrollTop };
  } catch {
    return emptyTreePrefs;
  }
}

export function writeTreePrefs(scope: TreeScope, prefs: TreePrefs, storage: Storage | null = globalThis.localStorage): void {
  if (!storage) return;
  try {
    storage.setItem(treeScopeKey(scope), JSON.stringify({
      open: [...new Set(prefs.open)].filter(Boolean).slice(0, MAX_OPEN),
      selected: prefs.selected.slice(0, MAX_SELECTED),
      scrollTop: Math.max(0, Math.round(prefs.scrollTop)),
    }));
    if (scope.projectId) markProjectPresentationChanged(scope.projectId, "workspaceState");
  } catch {
    // Browser storage is a best-effort presentation preference.
  }
}

/** Directory paths that must be opened, in fetch order, before revealing a file. */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const result: string[] = [];
  let current = "";
  result.push(current);
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    result.push(current);
  }
  return result;
}

export function beginTreeRequest(scope: TreeScope, generation: number): TreeRequestToken {
  return { scopeKey: treeScopeKey(scope), generation };
}

export function isCurrentTreeRequest(token: TreeRequestToken, scope: TreeScope, generation: number): boolean {
  return token.scopeKey === treeScopeKey(scope) && token.generation === generation;
}

/** Where a dragged entry may move: a different folder that is not inside it. */
export function canMoveInto(entry: { path: string; dir: boolean }, toDir: string): boolean {
  if (toDir === entry.path.split("/").slice(0, -1).join("/")) return false;
  if (!entry.dir) return true;
  return toDir !== entry.path && !toDir.startsWith(`${entry.path}/`);
}
