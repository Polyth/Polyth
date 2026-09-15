// Sidebar session grouping (WP13). Persisted under polyth.sidebar.groupingMode.
// Plugins may contribute extra groupings, but only as a pure key/label pair —
// never arbitrary row rendering.
import { useSyncExternalStore } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";

export const GROUPING_KEY = "polyth.sidebar.groupingMode";

export interface GroupingDescriptor {
  id: string;
  label: string;
  /** Pure grouping key for a session; omitted for structural modes (flat/folder). */
  keyOf?: (s: SessionProjection) => string;
}

const STATUS_LABELS: Record<string, string> = {
  working: tr("sidebarprefs.working"), waiting: tr("sidebarprefs.waiting"), idle: tr("sidebarprefs.idle"),
  finished: tr("sidebarprefs.finished"), failed: tr("sidebarprefs.failed"), archived: tr("sidebarprefs.archived"),
};

export const BUILTIN_GROUPINGS: ReadonlyArray<GroupingDescriptor> = [
  { id: "flat", label: tr("sidebarprefs.flat") },
  { id: "folder", label: tr("sidebarprefs.folder") },
  { id: "status", label: tr("sidebarprefs.status"), keyOf: (s) => STATUS_LABELS[s.status] ?? s.status },
  {
    id: "worktree",
    label: tr("sidebarprefs.worktree"),
    keyOf: (s) => s.branch ?? (s.worktreePath ? s.worktreePath.split("/").pop() ?? s.worktreePath : "Main workspace"),
  },
];

const pluginGroupings = new Map<string, GroupingDescriptor>();
const listeners = new Set<() => void>();
const notify = (): void => { for (const l of [...listeners]) l(); };

/** Contribute a grouping (plugins). keyOf is required for contributed modes. */
export function registerGrouping(desc: GroupingDescriptor): () => void {
  if (!desc.id || typeof desc.keyOf !== "function") {
    throw new Error(tr("sidebarprefs.contributedGroupingsNeedAnIdAndA"));
  }
  if (BUILTIN_GROUPINGS.some((g) => g.id === desc.id) || pluginGroupings.has(desc.id)) {
    throw new Error(tr("sidebarprefs.groupingAlreadyRegisteredValue", { id: desc.id }));
  }
  pluginGroupings.set(desc.id, desc);
  notify();
  return () => {
    pluginGroupings.delete(desc.id);
    notify(); // a disposed mode falls back to folder on next read
  };
}

export function listGroupings(): GroupingDescriptor[] {
  return [...BUILTIN_GROUPINGS, ...pluginGroupings.values()];
}

/** Validate a stored mode against currently known groupings. */
export function parseGroupingMode(raw: string | null, known: GroupingDescriptor[]): string {
  return raw && known.some((g) => g.id === raw) ? raw : "folder";
}

const read = (): string | null => {
  try { return localStorage.getItem(GROUPING_KEY); } catch { return null; }
};
const write = (v: string): void => {
  try { localStorage.setItem(GROUPING_KEY, v); } catch { /* private mode */ }
};

let stored: string | null = read();

export function getGroupingMode(): string {
  return parseGroupingMode(stored, listGroupings());
}

export function setGroupingMode(mode: string): void {
  stored = parseGroupingMode(mode, listGroupings());
  write(stored);
  notify();
}

// ---- sidebar view mode (UX-FILES-TIMELINE-03 finding 9) -----------------------
// "tree": project → worktrees → sessions for every expanded project.
// "rail": a compact project switcher beside the active project's sessions.

export const VIEW_MODE_KEY = "polyth.sidebar.viewMode";
export type SidebarViewMode = "tree" | "rail";

export function parseSidebarViewMode(raw: string | null): SidebarViewMode {
  // One-way migration from the removed project-list and project-folder
  // presentations. The nested tree is the safe default for unknown values.
  return raw === "rail" ? "rail" : "tree";
}

const readViewMode = (): string | null => {
  try { return localStorage.getItem(VIEW_MODE_KEY); } catch { return null; }
};
const writeViewMode = (v: string): void => {
  try { localStorage.setItem(VIEW_MODE_KEY, v); } catch { /* private mode */ }
};

let storedViewMode: SidebarViewMode = parseSidebarViewMode(readViewMode());
const viewModeListeners = new Set<() => void>();

export function getSidebarViewMode(): SidebarViewMode {
  return storedViewMode;
}

export function setSidebarViewMode(mode: SidebarViewMode): void {
  storedViewMode = parseSidebarViewMode(mode);
  writeViewMode(storedViewMode);
  for (const l of [...viewModeListeners]) l();
}

export function useSidebarViewMode(): SidebarViewMode {
  return useSyncExternalStore(
    (cb) => {
      viewModeListeners.add(cb);
      return () => { viewModeListeners.delete(cb); };
    },
    getSidebarViewMode,
  );
}

// Date-group headings in the session list ("today", "2 days ago", …). Pure
// presentation: hiding them does not change which chats match a filter.
export const DATE_GROUPS_KEY = "polyth.sidebar.showDateGroups";

export function parseShowDateGroups(raw: string | null): boolean {
  return raw !== "false";
}

const readDateGroups = (): string | null => {
  try { return localStorage.getItem(DATE_GROUPS_KEY); } catch { return null; }
};
const writeDateGroups = (value: string): void => {
  try { localStorage.setItem(DATE_GROUPS_KEY, value); } catch { /* private mode */ }
};

let storedShowDateGroups = parseShowDateGroups(readDateGroups());
const dateGroupListeners = new Set<() => void>();

export function getShowDateGroups(): boolean {
  return storedShowDateGroups;
}

export function setShowDateGroups(show: boolean): void {
  storedShowDateGroups = show;
  writeDateGroups(storedShowDateGroups ? "true" : "false");
  for (const listener of [...dateGroupListeners]) listener();
}

export function useShowDateGroups(): boolean {
  return useSyncExternalStore(
    (cb) => {
      dateGroupListeners.add(cb);
      return () => { dateGroupListeners.delete(cb); };
    },
    getShowDateGroups,
  );
}

// ---- sidebar project ordering (mobile/desktop toolbar) -----------------------
// The compact drawer replaced its decorative title with a search/sort/filter
// toolbar. "manual" order lets the user drag projects into an arbitrary order
// that persists per browser, on phone and desktop alike.

const readKey = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeKey = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
};

export const PROJECT_SORT_KEY = "polyth.sidebar.projectSort";
export const PROJECT_ORDER_KEY = "polyth.sidebar.projectOrder";
export type ProjectSortMode = "recent" | "name" | "manual";

export function parseProjectSortMode(raw: string | null): ProjectSortMode {
  return raw === "name" || raw === "manual" ? raw : "recent";
}

let storedProjectSort: ProjectSortMode = parseProjectSortMode(readKey(PROJECT_SORT_KEY));
const projectSortListeners = new Set<() => void>();

export function getProjectSortMode(): ProjectSortMode {
  return storedProjectSort;
}

export function setProjectSortMode(mode: ProjectSortMode): void {
  storedProjectSort = parseProjectSortMode(mode);
  writeKey(PROJECT_SORT_KEY, storedProjectSort);
  for (const l of [...projectSortListeners]) l();
}

export function useProjectSortMode(): ProjectSortMode {
  return useSyncExternalStore(
    (cb) => {
      projectSortListeners.add(cb);
      return () => { projectSortListeners.delete(cb); };
    },
    getProjectSortMode,
    () => "recent" as ProjectSortMode,
  );
}

function parseProjectOrder(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

let storedProjectOrder: string[] = parseProjectOrder(readKey(PROJECT_ORDER_KEY));
const projectOrderListeners = new Set<() => void>();

export function getProjectOrder(): string[] {
  return storedProjectOrder;
}

export function setProjectOrder(ids: readonly string[]): void {
  storedProjectOrder = [...ids];
  writeKey(PROJECT_ORDER_KEY, JSON.stringify(storedProjectOrder));
  for (const l of [...projectOrderListeners]) l();
}

export function useProjectOrder(): string[] {
  return useSyncExternalStore(
    (cb) => {
      projectOrderListeners.add(cb);
      return () => { projectOrderListeners.delete(cb); };
    },
    getProjectOrder,
    () => storedProjectOrder,
  );
}

/** Pure: order `projects` by the stored manual order. Anything the stored
 *  order does not mention (a freshly added project) is treated as
 *  "new" and sorted to the top by `createdAt` descending, so the default
 *  manual view is newest-first until the user drags something. Stable for
 *  equal ranks. */
export function applyManualProjectOrder<T extends { id: string; createdAt?: number }>(
  projects: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index] as const));
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => {
      const ra = rank.get(a.project.id);
      const rb = rank.get(b.project.id);
      if (ra !== undefined && rb !== undefined) return ra - rb || a.index - b.index;
      if (ra !== undefined) return 1;
      if (rb !== undefined) return -1;
      return (b.project.createdAt ?? 0) - (a.project.createdAt ?? 0) || a.index - b.index;
    })
    .map((entry) => entry.project);
}

/** Pure: move `draggedId` into `targetId`'s slot within `ordered`, returning
 *  the full id list to persist. A no-op when either id is missing or equal. */
export function reorderManualProjects(
  ordered: readonly string[],
  draggedId: string,
  targetId: string,
): string[] {
  const from = ordered.indexOf(draggedId);
  const to = ordered.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...ordered];
  const next = [...ordered];
  const [dragged] = next.splice(from, 1);
  next.splice(to, 0, dragged!);
  return next;
}

export interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionProjection[];
}

/** Pure: bucket sessions for keyed modes. flat/folder return one bucket
 *  (the sidebar renders folders itself). Group order follows first
 *  appearance in the (recency-sorted) input, so busiest groups lead. */
export function groupSessions(
  sessions: SessionProjection[],
  mode: string,
  descriptors: GroupingDescriptor[] = listGroupings(),
): SessionGroup[] {
  const desc = descriptors.find((g) => g.id === mode);
  const keyOf = desc?.keyOf;
  if (!keyOf) return [{ key: mode, label: desc?.label ?? mode, sessions }];
  const buckets = new Map<string, SessionProjection[]>();
  for (const s of sessions) {
    const key = keyOf(s) || tr("questioncards.other");
    const list = buckets.get(key) ?? [];
    list.push(s);
    buckets.set(key, list);
  }
  return [...buckets.entries()].map(([key, list]) => ({ key, label: key, sessions: list }));
}
