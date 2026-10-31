// Sidebar session grouping and order. The grouping is persisted under
// polyth.sidebar.groupingMode, the order under polyth.sidebar.sessionSort.
// Packages may contribute extra groupings, but only as pure key/label/rank
// functions — never arbitrary row rendering.
import { useMemo, useSyncExternalStore } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";
import {
  PROJECT_ORDER_KEY,
  PROJECT_SORT_KEY,
  readNavigatorState,
  SESSION_VISIBLE_COUNTS_KEY,
  subscribeNavigatorStateHydrated,
  writeNavigatorState,
} from "./navigatorState.ts";
import { sessionActivityAt, sessionDateGroupLabel, sessionDateInputValue } from "./sessionDates.ts";
import { sessionDraftLine } from "./sessionDraft.ts";
import { resolveSessionStatus } from "./sessionStatus.ts";

export { PROJECT_ORDER_KEY, PROJECT_SORT_KEY, SESSION_VISIBLE_COUNTS_KEY };

export const GROUPING_KEY = "polyth.sidebar.groupingMode";

/** What a heading label may depend on besides its key. */
export interface GroupLabelContext {
  relativeTime: boolean;
  locale: string;
  now: number;
}

export interface GroupingDescriptor {
  id: string;
  label: string;
  /** Pure group key for a session; omitted for the ungrouped list. */
  keyOf?: (s: SessionProjection) => string;
  /** Heading for a key (the key itself when omitted); null draws no heading. */
  labelOf?: (key: string, context: GroupLabelContext) => string | null;
  /** Group position, lower first. Without it groups follow the first
   *  appearance of their key in the sorted list. */
  rankOf?: (key: string) => number;
  /** Notified when the data behind keyOf changes outside the session list
   *  (a package's own state), so an active grouping re-sorts. */
  subscribe?: (listener: () => void) => () => void;
}

const isManagedIsolationBranch = (branch: string | null | undefined): boolean =>
  branch?.startsWith("polyth/isolate/") === true;

/** A chat that runs in its own Polyth-managed git worktree. */
export const isIsolatedSession = (session: Pick<SessionProjection, "isolation" | "isolationSummary" | "branch">): boolean =>
  session.isolationSummary === "git-worktree" || session.isolation?.kind === "git-worktree" || isManagedIsolationBranch(session.branch);

/** Session types, in the order their groups appear. Each chat has exactly one:
 *  what needs the person first, then live work, unsent drafts, and finally
 *  where the rest of the chats work. */
export const SESSION_TYPES = ["attention", "progress", "draft", "shared", "isolated", "workspace"] as const;
export type SessionType = typeof SESSION_TYPES[number];

export function sessionTypeOf(session: SessionProjection): SessionType {
  const status = resolveSessionStatus(session);
  if (status.kind === "needs-approval" || status.kind === "needs-reply") return "attention";
  if (status.kind === "working" || session.status === "reconciling") return "progress";
  // Only a chat that never ran is a draft. A draft typed into a chat with
  // history must not move that chat while the person writes.
  if (session.lastTurnAt == null && sessionDraftLine(session)) return "draft";
  if (session.sharing?.shared) return "shared";
  if (isIsolatedSession(session)) return "isolated";
  return "workspace";
}

const SESSION_TYPE_LABELS: Record<SessionType, () => string> = {
  attention: () => tr("sidebarprefs.typeAttention"),
  progress: () => tr("sidebarprefs.typeProgress"),
  draft: () => tr("sidebarprefs.typeDraft"),
  shared: () => tr("sidebarprefs.typeShared"),
  isolated: () => tr("sidebarprefs.typeIsolated"),
  workspace: () => tr("sidebarprefs.typeWorkspace"),
};

const sessionTypeRank = (key: string): number => {
  const rank = SESSION_TYPES.indexOf(key as SessionType);
  return rank < 0 ? SESSION_TYPES.length : rank;
};

export const BUILTIN_GROUPINGS: ReadonlyArray<GroupingDescriptor> = [
  { id: "none", get label() { return tr("sidebarprefs.groupNone"); } },
  {
    id: "date",
    get label() { return tr("sidebarprefs.groupDate"); },
    keyOf: (s) => sessionDateInputValue(sessionActivityAt(s)),
    // YYYY-MM-DD keys: the newest day first.
    rankOf: (key) => -Number(key.replaceAll("-", "")),
    // Today needs no heading; the list starts there.
    labelOf: (key, { relativeTime, locale, now }) => key === sessionDateInputValue(now)
      ? null
      : sessionDateGroupLabel(new Date(`${key}T12:00:00`).getTime(), relativeTime, locale, now),
  },
  {
    id: "type",
    get label() { return tr("sidebarprefs.groupType"); },
    keyOf: sessionTypeOf,
    rankOf: sessionTypeRank,
    labelOf: (key) => SESSION_TYPE_LABELS[key as SessionType]?.() ?? key,
  },
];

const pluginGroupings = new Map<string, GroupingDescriptor>();
const listeners = new Set<() => void>();
const aggregateListeners = new Set<() => void>();
const notify = (): void => {
  for (const l of [...listeners]) l();
  for (const l of [...aggregateListeners]) l();
};

/** Contribute a grouping (packages). keyOf is required for contributed modes. */
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
    notify(); // a disposed mode reads as ungrouped until it comes back
  };
}

export function listGroupings(): GroupingDescriptor[] {
  return [...BUILTIN_GROUPINGS, ...pluginGroupings.values()];
}

let groupingList: readonly GroupingDescriptor[] = listGroupings();
listeners.add(() => { groupingList = listGroupings(); });

/** Every grouping the menu offers, packages' included. */
export function useGroupings(): readonly GroupingDescriptor[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    () => groupingList,
    () => BUILTIN_GROUPINGS,
  );
}

/** Validate a stored mode against currently known groupings. */
export function parseGroupingMode(raw: string | null, known: GroupingDescriptor[]): string {
  return raw && known.some((g) => g.id === raw) ? raw : "none";
}

const read = (): string | null => {
  try { return localStorage.getItem(GROUPING_KEY); } catch { return null; }
};
const write = (v: string): void => {
  try { localStorage.setItem(GROUPING_KEY, v); } catch { /* private mode */ }
};

// The raw choice survives a package that has not registered its grouping yet
// (packages activate after this module loads), so it is validated on read.
let stored: string | null = read();

/** Groupings the list replaced: they showed no headings of their own. */
const LEGACY_GROUPINGS = new Set(["flat", "folder", "status", "worktree"]);

export function getGroupingMode(): string {
  // Before grouping had a menu, "Date groups" was its own switch.
  if (stored === null || LEGACY_GROUPINGS.has(stored)) return storedShowDateGroups ? "date" : "none";
  return parseGroupingMode(stored, listGroupings());
}

export function setGroupingMode(mode: string): void {
  stored = parseGroupingMode(mode, listGroupings());
  write(stored);
  // Older clients of the same account read the date switch.
  storedShowDateGroups = stored === "date";
  writeDateGroups(storedShowDateGroups ? "true" : "false");
  for (const listener of [...dateGroupListeners]) listener();
  notify();
}

export function getGrouping(): GroupingDescriptor {
  const mode = getGroupingMode();
  return listGroupings().find((g) => g.id === mode) ?? BUILTIN_GROUPINGS[0]!;
}

// Bumped when a package's grouping data changes, so the list re-sorts.
let groupingDataRevision = 0;

/** The active grouping and a revision of its package data. */
export function useSessionGrouping(): GroupingDescriptor {
  const mode = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      dateGroupListeners.add(cb);
      return () => { listeners.delete(cb); dateGroupListeners.delete(cb); };
    },
    getGroupingMode,
    () => "none",
  );
  const grouping = listGroupings().find((g) => g.id === mode) ?? BUILTIN_GROUPINGS[0]!;
  const subscribeData = useMemo(
    () => (cb: () => void) => grouping.subscribe?.(() => { groupingDataRevision += 1; cb(); }) ?? (() => {}),
    [grouping],
  );
  useSyncExternalStore(subscribeData, () => groupingDataRevision, () => 0);
  return grouping;
}

// ---- session order -----------------------------------------------------------
// "recent" is the chronological navigator order; the others reorder the
// loaded chats (pages keep loading newest first).

export const SESSION_SORT_KEY = "polyth.sidebar.sessionSort";
export const SESSION_SORT_MODES = ["recent", "created", "title", "type"] as const;
export type SessionSortMode = typeof SESSION_SORT_MODES[number];

export function parseSessionSortMode(raw: string | null): SessionSortMode {
  return SESSION_SORT_MODES.includes(raw as SessionSortMode) ? raw as SessionSortMode : "recent";
}

export const sessionSortLabel = (mode: SessionSortMode): string => ({
  recent: () => tr("sidebarprefs.sortRecent"),
  created: () => tr("sidebarprefs.sortCreated"),
  title: () => tr("sidebarprefs.sortTitle"),
  type: () => tr("sidebarprefs.groupType"),
})[mode]();

const readSessionSort = (): string | null => {
  try { return localStorage.getItem(SESSION_SORT_KEY); } catch { return null; }
};
const writeSessionSort = (value: string): void => {
  try { localStorage.setItem(SESSION_SORT_KEY, value); } catch { /* private mode */ }
};

let storedSessionSort: SessionSortMode = parseSessionSortMode(readSessionSort());
const sessionSortListeners = new Set<() => void>();

export function getSessionSortMode(): SessionSortMode {
  return storedSessionSort;
}

export function setSessionSortMode(mode: SessionSortMode): void {
  storedSessionSort = parseSessionSortMode(mode);
  writeSessionSort(storedSessionSort);
  for (const l of [...sessionSortListeners]) l();
  for (const l of [...aggregateListeners]) l();
}

export function useSessionSortMode(): SessionSortMode {
  return useSyncExternalStore(
    (cb) => {
      sessionSortListeners.add(cb);
      return () => { sessionSortListeners.delete(cb); };
    },
    getSessionSortMode,
    () => "recent" as SessionSortMode,
  );
}

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const sortTitle = (s: SessionProjection): string => s.title || sessionDraftLine(s) || "";
const byActivity = (a: SessionProjection, b: SessionProjection): number =>
  sessionActivityAt(b) - sessionActivityAt(a) || a.id.localeCompare(b.id);

/** Order inside a group (or the whole list when ungrouped). */
export function compareSessions(sort: SessionSortMode): (a: SessionProjection, b: SessionProjection) => number {
  if (sort === "created") return (a, b) => b.createdAt - a.createdAt || byActivity(a, b);
  if (sort === "title") return (a, b) => titleCollator.compare(sortTitle(a), sortTitle(b)) || byActivity(a, b);
  if (sort === "type") {
    return (a, b) => sessionTypeRank(sessionTypeOf(a)) - sessionTypeRank(sessionTypeOf(b)) || byActivity(a, b);
  }
  return byActivity;
}

/** Pure: `sessions` grouped then sorted, groups kept contiguous. */
export function arrangeSessions<T extends SessionProjection>(
  sessions: readonly T[],
  grouping: GroupingDescriptor,
  sort: SessionSortMode,
): T[] {
  const compare = compareSessions(sort);
  const sorted = [...sessions].sort(compare);
  const keyOf = grouping.keyOf;
  if (!keyOf) return sorted;
  const keys = new Map(sorted.map((s) => [s.id, keyOf(s) || ""] as const));
  const firstSeen = new Map<string, number>();
  for (const s of sorted) if (!firstSeen.has(keys.get(s.id)!)) firstSeen.set(keys.get(s.id)!, firstSeen.size);
  const rank = (key: string) => grouping.rankOf?.(key) ?? firstSeen.get(key)!;
  return sorted
    .map((session, index) => ({ session, index, rank: rank(keys.get(session.id)!) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.session);
}

export interface ArrangedGroup<T> {
  key: string;
  /** Heading text; null when the group draws none. */
  label: string | null;
  sessions: T[];
}

/** Pure: split an arranged list into its contiguous groups. */
export function sessionGroupsOf<T extends SessionProjection>(
  arranged: readonly T[],
  grouping: GroupingDescriptor,
  context: GroupLabelContext,
): ArrangedGroup<T>[] {
  const keyOf = grouping.keyOf;
  if (!keyOf) return arranged.length ? [{ key: grouping.id, label: null, sessions: [...arranged] }] : [];
  const groups: ArrangedGroup<T>[] = [];
  for (const session of arranged) {
    const key = keyOf(session) || "";
    const previous = groups.at(-1);
    if (previous?.key === key) previous.sessions.push(session);
    else {
      const label = grouping.labelOf ? grouping.labelOf(key, context) : key || tr("questioncards.other");
      groups.push({ key, label, sessions: [session] });
    }
  }
  return groups;
}

// ---- sidebar view mode -----------------------
// "tree": project → worktrees → sessions for every expanded project.
// "rail": a compact project switcher beside the active project's sessions.

export const VIEW_MODE_KEY = "polyth.sidebar.viewMode";
export type SidebarViewMode = "tree" | "rail";

/** A fresh install starts with the compact project switcher. */
export const SIDEBAR_VIEW_MODE_DEFAULT: SidebarViewMode = "rail";

export function parseSidebarViewMode(raw: string | null): SidebarViewMode {
  if (raw === null) return SIDEBAR_VIEW_MODE_DEFAULT;
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
  for (const l of [...aggregateListeners]) l();
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

// Session pagination is worktree-scoped presentation state. Keep counts per
// project, view, and worktree so each branch can expand independently; the
// account-level default is supplied by the navigator caller.
const SESSION_VISIBLE_COUNT_MAX = 1_000;
type SessionVisibleCounts = Record<string, number>;

/** Stable bucket for sessions that belong to the project's primary checkout. */
export const SESSION_MAIN_WORKTREE_KEY = "__main__";

function parseSessionVisibleCounts(raw: string | null): SessionVisibleCounts {
  try {
    const value = JSON.parse(raw ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const counts: SessionVisibleCounts = {};
    for (const [key, count] of Object.entries(value)) {
      if (!key || !Number.isInteger(count) || count < 1) continue;
      counts[key] = Math.min(SESSION_VISIBLE_COUNT_MAX, count);
    }
    return counts;
  } catch {
    return {};
  }
}

const readSessionVisibleCounts = (): string | null => readNavigatorState(SESSION_VISIBLE_COUNTS_KEY);
const writeSessionVisibleCounts = (value: string): void => writeNavigatorState(SESSION_VISIBLE_COUNTS_KEY, value);

let storedSessionVisibleCounts = parseSessionVisibleCounts(readSessionVisibleCounts());
// The mobile app restores its saved counts into localStorage after this module
// loaded (its shell origin starts empty on every launch).
subscribeNavigatorStateHydrated(() => {
  storedSessionVisibleCounts = parseSessionVisibleCounts(readSessionVisibleCounts());
  for (const l of [...aggregateListeners]) l();
});

function sessionVisibleCountKey(
  projectId: string,
  viewMode: SidebarViewMode,
  worktreeKey?: string,
): string {
  if (worktreeKey === undefined) return `${viewMode}:${projectId}`;
  return `${viewMode}:${projectId}:worktree:${encodeURIComponent(worktreeKey)}`;
}

export function getVisibleSessionCount(
  projectId: string,
  viewMode: SidebarViewMode,
  defaultCount: number,
  worktreeKey?: string,
): number {
  const saved = storedSessionVisibleCounts[sessionVisibleCountKey(projectId, viewMode, worktreeKey)]
    // Preserve the pre-worktree setting for the primary checkout only. Linked
    // worktrees start from the account default instead of inheriting one
    // branch's expansion from the whole project.
    ?? (worktreeKey === SESSION_MAIN_WORKTREE_KEY
      ? storedSessionVisibleCounts[sessionVisibleCountKey(projectId, viewMode)]
      : undefined);
  return saved ?? Math.max(1, Math.min(SESSION_VISIBLE_COUNT_MAX, Math.floor(defaultCount)));
}

export function setVisibleSessionCount(
  projectId: string,
  viewMode: SidebarViewMode,
  count: number,
  worktreeKey?: string,
): void {
  const key = sessionVisibleCountKey(projectId, viewMode, worktreeKey);
  const next = Math.max(1, Math.min(SESSION_VISIBLE_COUNT_MAX, Math.floor(count)));
  if (storedSessionVisibleCounts[key] === next) return;
  storedSessionVisibleCounts = { ...storedSessionVisibleCounts, [key]: next };
  writeSessionVisibleCounts(JSON.stringify(storedSessionVisibleCounts));
  for (const l of [...aggregateListeners]) l();
}

// Date-group headings in the session list ("today", "2 days ago", …). Pure
// presentation: hiding them does not change which chats match a filter. Now
// the "date" grouping; the switch is kept as its compatibility record.
export const DATE_GROUPS_KEY = "polyth.sidebar.showDateGroups";

/** A fresh install lists chats without date headings. */
export const SHOW_DATE_GROUPS_DEFAULT = false;

export function parseShowDateGroups(raw: string | null): boolean {
  if (raw === null) return SHOW_DATE_GROUPS_DEFAULT;
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
  return getGroupingMode() === "date";
}

/** Turn the date grouping on, or back to an ungrouped list. */
export function setShowDateGroups(show: boolean): void {
  if (show) setGroupingMode("date");
  else if (getGroupingMode() === "date") setGroupingMode("none");
}

// ---- sidebar project ordering (mobile/desktop toolbar) -----------------------
// The compact drawer replaced its decorative title with a search/sort/filter
// toolbar. "manual" (shown as "Custom order") is the order the user moved the
// projects into; moving a project under any sort switches to it. Both are
// device navigator state (navigatorState.ts): durable in a browser and,
// through the app-owned store, across mobile app launches.

export type ProjectSortMode = "recent" | "name" | "manual";

export function parseProjectSortMode(raw: string | null): ProjectSortMode {
  return raw === "name" || raw === "manual" ? raw : "recent";
}

let storedProjectSort: ProjectSortMode = parseProjectSortMode(readNavigatorState(PROJECT_SORT_KEY));
const projectSortListeners = new Set<() => void>();

export function getProjectSortMode(): ProjectSortMode {
  return storedProjectSort;
}

export function setProjectSortMode(mode: ProjectSortMode): void {
  storedProjectSort = parseProjectSortMode(mode);
  writeNavigatorState(PROJECT_SORT_KEY, storedProjectSort);
  for (const l of [...projectSortListeners]) l();
  for (const l of [...aggregateListeners]) l();
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

let storedProjectOrder: string[] = parseProjectOrder(readNavigatorState(PROJECT_ORDER_KEY));
const projectOrderListeners = new Set<() => void>();

// The mobile app puts the saved sort and order back after this module loaded.
subscribeNavigatorStateHydrated(() => {
  storedProjectSort = parseProjectSortMode(readNavigatorState(PROJECT_SORT_KEY));
  storedProjectOrder = parseProjectOrder(readNavigatorState(PROJECT_ORDER_KEY));
  for (const l of [...projectSortListeners]) l();
  for (const l of [...projectOrderListeners]) l();
});

export function getProjectOrder(): string[] {
  return storedProjectOrder;
}

export function setProjectOrder(ids: readonly string[]): void {
  storedProjectOrder = [...ids];
  writeNavigatorState(PROJECT_ORDER_KEY, JSON.stringify(storedProjectOrder));
  for (const l of [...projectOrderListeners]) l();
  for (const l of [...aggregateListeners]) l();
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

/** The one ordering authority for projects. The desktop sidebar and the
 *  settings project picker consume this, so the same stored preference can
 *  never put a project in a different place (or appear not to have been saved
 *  at all) on another surface. The phone navigator shares the manual and name
 *  orders but ranks "recent" by attention first, on purpose.
 *
 *  "recent" ranks by the newest session activity the caller reports per project;
 *  `latestActivity` defaults to 0, which leaves the name tie-break in charge. */
export function orderProjects<T extends { id: string; name?: string | undefined; path: string; createdAt?: number }>(
  projects: readonly T[],
  sort: ProjectSortMode,
  order: readonly string[],
  latestActivity: (projectId: string) => number = () => 0,
): T[] {
  if (sort === "manual") return applyManualProjectOrder(projects, order);
  const byName = (a: T, b: T) => (a.name || a.path).localeCompare(b.name || b.path);
  if (sort === "name") return [...projects].sort(byName);
  return [...projects].sort((a, b) => latestActivity(b.id) - latestActivity(a.id) || byName(a, b));
}

/** `orderProjects` bound to the stored preference. Memoize `latestActivity`
 *  (useCallback) to keep this memo stable. */
export function useOrderedProjects<T extends { id: string; name?: string | undefined; path: string; createdAt?: number }>(
  projects: readonly T[],
  latestActivity?: (projectId: string) => number,
): T[] {
  const sort = useProjectSortMode();
  const order = useProjectOrder();
  return useMemo(
    () => orderProjects(projects, sort, order, latestActivity),
    [latestActivity, order, projects, sort],
  );
}

/** Pure: the full id list to persist after a move. `ordered` is every project
 *  as the list is sorted now; `shown` the visible ones in their new order,
 *  laid back into the slots they occupy, so projects a filter hides keep
 *  theirs. */
export function permuteManualProjects(ordered: readonly string[], shown: readonly string[]): string[] {
  const visible = new Set(shown);
  const next = shown.filter((id) => ordered.includes(id));
  let cursor = 0;
  return ordered.map((id) => (visible.has(id) ? next[cursor++] ?? id : id));
}

// Project ids and per-project pagination stay on this device (see
// navigatorState.ts); only account-wide sidebar presentation is mirrored in
// client settings.
export interface SidebarPrefsSnapshot {
  grouping: string;
  viewMode: SidebarViewMode;
  /** Mirrors grouping === "date" for clients that predate the grouping menu. */
  showDateGroups: boolean;
  sessionSort: SessionSortMode;
}

export function getSidebarPrefsSnapshot(): SidebarPrefsSnapshot {
  return {
    // A package grouping that is not registered yet keeps its stored id.
    grouping: stored !== null && !LEGACY_GROUPINGS.has(stored) ? stored : getGroupingMode(),
    viewMode: storedViewMode,
    showDateGroups: getGroupingMode() === "date",
    sessionSort: storedSessionSort,
  };
}

const MAX_GROUPING_ID = 200;

export function replaceSidebarPrefs(value: unknown): void {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  stored = typeof raw.grouping === "string" && raw.grouping && raw.grouping.length <= MAX_GROUPING_ID
    ? raw.grouping
    : null;
  storedViewMode = parseSidebarViewMode(typeof raw.viewMode === "string" ? raw.viewMode : null);
  storedShowDateGroups = typeof raw.showDateGroups === "boolean" ? raw.showDateGroups : SHOW_DATE_GROUPS_DEFAULT;
  storedSessionSort = parseSessionSortMode(typeof raw.sessionSort === "string" ? raw.sessionSort : null);
  if (stored !== null) write(stored);
  else {
    try { localStorage.removeItem(GROUPING_KEY); } catch { /* private mode */ }
  }
  writeViewMode(storedViewMode);
  writeDateGroups(storedShowDateGroups ? "true" : "false");
  writeSessionSort(storedSessionSort);
  notify();
  for (const l of [...viewModeListeners]) l();
  for (const l of [...dateGroupListeners]) l();
  for (const l of [...sessionSortListeners]) l();
  for (const l of [...projectSortListeners]) l();
  for (const l of [...projectOrderListeners]) l();
}

export function subscribeSidebarPrefs(listener: () => void): () => void {
  aggregateListeners.add(listener);
  return () => { aggregateListeners.delete(listener); };
}
