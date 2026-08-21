// Sidebar session grouping (WP13). Persisted under polyth.sidebar.groupingMode.
// Plugins may contribute extra groupings, but only as a pure key/label pair —
// never arbitrary row rendering.
import { useSyncExternalStore } from "react";
import type { SessionProjection } from "@polyth/contracts";

export const GROUPING_KEY = "polyth.sidebar.groupingMode";

export interface GroupingDescriptor {
  id: string;
  label: string;
  /** Pure grouping key for a session; omitted for structural modes (flat/folder). */
  keyOf?: (s: SessionProjection) => string;
}

const STATUS_LABELS: Record<string, string> = {
  working: "Working", waiting: "Waiting", idle: "Idle",
  finished: "Finished", failed: "Failed", archived: "Archived",
};

export const BUILTIN_GROUPINGS: ReadonlyArray<GroupingDescriptor> = [
  { id: "flat", label: "Flat" },
  { id: "folder", label: "Folder" },
  { id: "status", label: "Status", keyOf: (s) => STATUS_LABELS[s.status] ?? s.status },
  {
    id: "worktree",
    label: "Worktree",
    keyOf: (s) => s.branch ?? (s.worktreePath ? s.worktreePath.split("/").pop() ?? s.worktreePath : "Main workspace"),
  },
];

const pluginGroupings = new Map<string, GroupingDescriptor>();
const listeners = new Set<() => void>();
const notify = (): void => { for (const l of [...listeners]) l(); };

/** Contribute a grouping (plugins). keyOf is required for contributed modes. */
export function registerGrouping(desc: GroupingDescriptor): () => void {
  if (!desc.id || typeof desc.keyOf !== "function") {
    throw new Error("contributed groupings need an id and a pure keyOf()");
  }
  if (BUILTIN_GROUPINGS.some((g) => g.id === desc.id) || pluginGroupings.has(desc.id)) {
    throw new Error(`grouping already registered: ${desc.id}`);
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

export function useGroupingMode(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getGroupingMode,
  );
}

// ---- sidebar view mode (UX-FILES-TIMELINE-03 finding 9) -----------------------
// "list": the current presentation — project cards plus the ACTIVE project's
// sessions. "folders": every project is a collapsible folder with its
// sessions nested. Persisted separately from the session grouping mode.

export const VIEW_MODE_KEY = "polyth.sidebar.viewMode";
export type SidebarViewMode = "list" | "folders";

export function parseSidebarViewMode(raw: string | null): SidebarViewMode {
  return raw === "folders" ? "folders" : "list";
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

export interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionProjection[];
}

export function sortPinnedSessions(sessions: readonly SessionProjection[]): SessionProjection[] {
  return sessions
    .filter((session) => session.pinned !== undefined)
    .sort((a, b) =>
      (a.pinned!.position - b.pinned!.position)
      || (b.updatedAt - a.updatedAt)
      || a.id.localeCompare(b.id),
    );
}

export function reorderPinnedSessions(
  sessions: readonly SessionProjection[],
  draggedId: string,
  targetId: string,
): SessionProjection[] {
  const ordered = sortPinnedSessions(sessions);
  const from = ordered.findIndex((session) => session.id === draggedId);
  const to = ordered.findIndex((session) => session.id === targetId);
  if (from < 0 || to < 0 || from === to) return ordered;
  const next = [...ordered];
  const [dragged] = next.splice(from, 1);
  if (!dragged) return ordered;
  next.splice(to, 0, dragged);
  return next.map((session, position) => ({ ...session, pinned: { position } }));
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
    const key = keyOf(s) || "Other";
    const list = buckets.get(key) ?? [];
    list.push(s);
    buckets.set(key, list);
  }
  return [...buckets.entries()].map(([key, list]) => ({ key, label: key, sessions: list }));
}
