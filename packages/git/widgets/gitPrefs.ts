import { useSyncExternalStore } from "react";
import { workspacePresentationKey } from "../../../apps/web/src/store.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../../apps/web/src/projectPresentationSync.ts";

export interface GitPrefs {
  reviewScope?: "working" | "branch";
  layout: "unified" | "split";
  ignoreWhitespace: boolean;
  wrap: boolean;
  changesView: "flat" | "tree";
  /** Row rhythm of every Source Control list: one scanning line or two. */
  density: "compact" | "comfortable";
  /** How a changed file reports its size: numbers, a five-cell bar, or nothing. */
  lineStats: "numbers" | "bar" | "hidden";
  /** Lane graph beside the commit log. */
  logGraph: boolean;
  /** Commit, stash and worktree dates: "2h ago" or the locale date. */
  dateStyle: "relative" | "absolute";
  /** An isolated chat's landing also pushes the branch it integrated into. */
  pushAfterIntegrate: boolean;
}

export type GitTabId = "changes" | "log" | "branches" | "stashes";

export interface GitViewState {
  selected?: { path: string; staged: boolean };
  closedGroups: string[];
  tab?: GitTabId;
}

export interface SplitDiffRow {
  left: string;
  right: string;
  kind: "context" | "change" | "hunk";
}

export const GIT_PREFS_KEY = "polyth.gitPrefs";
export const GIT_REPOSITORY_SELECTIONS_NAMESPACE = "git-repository";
const ALL_REPOSITORIES = "__all_repositories__";
export const GIT_PREFS_DEFAULTS: GitPrefs = {
  layout: "unified",
  ignoreWhitespace: false,
  wrap: false,
  changesView: "tree",
  density: "compact",
  lineStats: "numbers",
  logGraph: true,
  dateStyle: "relative",
  pushAfterIntegrate: true,
};

const legacyScopedPrefsKey = (scope: string): string => `${GIT_PREFS_KEY}:${encodeURIComponent(scope)}`;
const scopedProjectId = (scope: string): string => scope.split("\0", 1)[0] ?? "";
const scopedPrefsKey = (scope?: string): string => {
  if (!scope) return GIT_PREFS_KEY;
  const projectId = scopedProjectId(scope);
  if (!projectId) return legacyScopedPrefsKey(scope);
  const [, sessionId = "", variant = ""] = scope.split("\0");
  const key = workspacePresentationKey("git-prefs", projectId, sessionId || null);
  return variant ? `${key}:${encodeURIComponent(variant)}` : key;
};

/** Only the keys a stored object actually carries, each validated. A scope
 *  stores overrides, so a missing key must stay missing, not become a default. */
export function parseGitPrefOverrides(raw: string | null): Partial<GitPrefs> {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    data = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Partial<GitPrefs> = {};
  if (data.reviewScope === "working" || data.reviewScope === "branch") out.reviewScope = data.reviewScope;
  if (data.layout === "split" || data.layout === "unified") out.layout = data.layout;
  if (typeof data.ignoreWhitespace === "boolean") out.ignoreWhitespace = data.ignoreWhitespace;
  if (typeof data.wrap === "boolean") out.wrap = data.wrap;
  if (data.changesView === "flat" || data.changesView === "tree") out.changesView = data.changesView;
  if (data.density === "compact" || data.density === "comfortable") out.density = data.density;
  if (data.lineStats === "numbers" || data.lineStats === "bar" || data.lineStats === "hidden") out.lineStats = data.lineStats;
  if (typeof data.logGraph === "boolean") out.logGraph = data.logGraph;
  if (data.dateStyle === "relative" || data.dateStyle === "absolute") out.dateStyle = data.dateStyle;
  if (typeof data.pushAfterIntegrate === "boolean") out.pushAfterIntegrate = data.pushAfterIntegrate;
  return out;
}

export function parseGitPrefs(raw: string | null): GitPrefs {
  return { ...GIT_PREFS_DEFAULTS, ...parseGitPrefOverrides(raw) };
}

const read = (scope?: string): string | null => {
  try {
    const value = localStorage.getItem(scopedPrefsKey(scope));
    if (value !== null || !scope) return value;
    const legacy = localStorage.getItem(legacyScopedPrefsKey(scope));
    if (legacy !== null) {
      localStorage.setItem(scopedPrefsKey(scope), legacy);
      localStorage.removeItem(legacyScopedPrefsKey(scope));
    }
    return legacy;
  } catch { return null; }
};
let prefs = parseGitPrefs(read());
const scopedPrefsCache = new Map<string, GitPrefs>();
const listeners = new Set<() => void>();

/** Account defaults, overlaid by whatever a repository scope overrides. The
 *  overlay is cached per scope and rebuilt whenever the defaults change, so a
 *  Settings edit reaches every scope that never chose differently. */
export function getGitPrefs(scope?: string): GitPrefs {
  if (!scope) return prefs;
  const cached = scopedPrefsCache.get(scope);
  if (cached) return cached;
  const loaded = { ...prefs, ...parseGitPrefOverrides(read(scope)) };
  scopedPrefsCache.set(scope, loaded);
  return loaded;
}

export function replaceGitPrefs(value: unknown): void {
  prefs = parseGitPrefs(JSON.stringify(value));
  scopedPrefsCache.clear();
  try { localStorage.setItem(GIT_PREFS_KEY, JSON.stringify(prefs)); } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

export function subscribeGitPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

if (typeof window !== "undefined") {
  window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, (event) => {
    if (!projectPresentationEventProjectId(event) || !projectPresentationEventHasKey(event, "workspaceState")) return;
    scopedPrefsCache.clear();
    for (const listener of [...listeners]) listener();
  });
}

export function setGitPrefs(patch: Partial<GitPrefs>, scope?: string): void {
  if (scope) {
    const projectId = scopedProjectId(scope);
    if (patch.reviewScope && projectId) setReviewScope(projectId, patch.reviewScope);
    const overrides = { ...parseGitPrefOverrides(read(scope)), ...patch };
    scopedPrefsCache.set(scope, { ...prefs, ...overrides });
    try {
      localStorage.setItem(scopedPrefsKey(scope), JSON.stringify(overrides));
      const projectId = scopedProjectId(scope);
      if (projectId) markProjectPresentationChanged(projectId, "workspaceState");
    } catch { /* best effort */ }
  } else {
    prefs = { ...prefs, ...patch };
    scopedPrefsCache.clear();
    try { localStorage.setItem(GIT_PREFS_KEY, JSON.stringify(prefs)); } catch { /* best effort */ }
  }
  for (const listener of [...listeners]) listener();
}

export function useGitPrefs(scope?: string): GitPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getGitPrefs(scope),
  );
}

const legacyViewStateKey = (scope: string): string => `${GIT_PREFS_KEY}:view:${encodeURIComponent(scope)}`;
const viewStateKey = (scope: string): string => {
  const [projectId, sessionId = "", variant = ""] = scope.split("\0");
  if (!projectId) return legacyViewStateKey(scope);
  const key = workspacePresentationKey("git-view", projectId, sessionId || null);
  return variant ? `${key}:${encodeURIComponent(variant)}` : key;
};
export function getGitViewState(scope: string): GitViewState {
  try {
    const key = viewStateKey(scope);
    let raw = localStorage.getItem(key);
    if (raw === null) {
      raw = localStorage.getItem(legacyViewStateKey(scope));
      if (raw !== null) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(legacyViewStateKey(scope));
      }
    }
    const data = JSON.parse(raw ?? "") as { selected?: { path?: unknown; staged?: unknown }; closedGroups?: unknown; tab?: unknown };
    return {
      ...(data.tab === "changes" || data.tab === "log" || data.tab === "branches" || data.tab === "stashes" ? { tab: data.tab } : {}),
      ...(typeof data.selected?.path === "string" && typeof data.selected.staged === "boolean"
        ? { selected: { path: data.selected.path, staged: data.selected.staged } }
        : {}),
      closedGroups: Array.isArray(data.closedGroups) ? data.closedGroups.filter((value): value is string => typeof value === "string").slice(0, 256) : [],
    };
  } catch {
    return { closedGroups: [] };
  }
}

export function setGitViewState(scope: string, state: GitViewState): void {
  try {
    localStorage.setItem(viewStateKey(scope), JSON.stringify({ ...state, closedGroups: state.closedGroups.slice(0, 256) }));
    const projectId = scopedProjectId(scope);
    if (projectId) markProjectPresentationChanged(projectId, "workspaceState");
  } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

const repositorySelectionKey = (projectId: string, sessionId?: string | null): string =>
  workspacePresentationKey(GIT_REPOSITORY_SELECTIONS_NAMESPACE, projectId, sessionId ?? null);

export function getGitRepositorySelection(projectId: string, sessionId?: string | null): string | null | undefined {
  const key = repositorySelectionKey(projectId, sessionId);
  try {
    const value = localStorage.getItem(key);
    if (value === ALL_REPOSITORIES) return null;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setGitRepositorySelection(projectId: string, sessionId: string | null | undefined, repositoryId: string | null): void {
  const key = repositorySelectionKey(projectId, sessionId);
  try {
    if (repositoryId === null) localStorage.setItem(key, ALL_REPOSITORIES);
    else localStorage.setItem(key, repositoryId);
    markProjectPresentationChanged(projectId, "workspaceState");
  } catch { /* best effort */ }
}

const remoteSelectionKey = (projectId: string, sessionId?: string | null, repositoryId?: string | null): string => {
  const key = workspacePresentationKey("git-remote", projectId, sessionId ?? null);
  return repositoryId ? `${key}:${encodeURIComponent(repositoryId)}` : key;
};

const SAFE_REMOTE_NAME = /^[\w.-]{1,120}$/;

export function getGitRemoteSelection(projectId: string, sessionId?: string | null, repositoryId?: string | null): string | undefined {
  try {
    const value = localStorage.getItem(remoteSelectionKey(projectId, sessionId, repositoryId))
      ?? (repositoryId ? localStorage.getItem(remoteSelectionKey(projectId, sessionId)) : null);
    return value && SAFE_REMOTE_NAME.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function setGitRemoteSelection(projectId: string, sessionId: string | null | undefined, remoteName: string | null, repositoryId?: string | null): void {
  if (remoteName !== null && !SAFE_REMOTE_NAME.test(remoteName)) return;
  try {
    const key = remoteSelectionKey(projectId, sessionId, repositoryId);
    if (remoteName === null) localStorage.removeItem(key);
    else localStorage.setItem(key, remoteName);
    markProjectPresentationChanged(projectId, "workspaceState");
  } catch { /* best effort */ }
}

/** Align adjacent delete/add runs for a compact side-by-side renderer. */
export function splitDiffRows(diff: string): SplitDiffRow[] {
  const lines = diff.split("\n");
  const rows: SplitDiffRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? "";
    if (line.startsWith("@@")) {
      rows.push({ left: line, right: line, kind: "hunk" });
      i += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("-") && !lines[i]!.startsWith("---")) removed.push(lines[i++]!);
      while (i < lines.length && lines[i]!.startsWith("+") && !lines[i]!.startsWith("+++")) added.push(lines[i++]!);
      const count = Math.max(removed.length, added.length);
      for (let j = 0; j < count; j++) rows.push({ left: removed[j] ?? "", right: added[j] ?? "", kind: "change" });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ left: "", right: line, kind: "change" });
    } else {
      rows.push({ left: line, right: line, kind: "context" });
    }
    i += 1;
  }
  return rows;
}

export function getReviewScope(projectId: string): GitPrefs["reviewScope"] {
  try {
    const value = localStorage.getItem(workspacePresentationKey("git-review-scope", projectId, null));
    return value === "working" || value === "branch" ? value : undefined;
  } catch { return undefined; }
}
export function setReviewScope(projectId: string, scope: NonNullable<GitPrefs["reviewScope"]>): void {
  try {
    localStorage.setItem(workspacePresentationKey("git-review-scope", projectId, null), scope);
    markProjectPresentationChanged(projectId, "workspaceState");
  } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

export function useReviewScopePreference(projectId: string | null | undefined): GitPrefs["reviewScope"] {
  return useSyncExternalStore(subscribeGitPrefs, () => projectId ? getReviewScope(projectId) : undefined);
}
