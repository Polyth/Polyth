import { useSyncExternalStore } from "react";
import type { UsageChartMetric, UsageRangePreset } from "../../src/analytics/contracts.ts";

/** Analytics scopes that own a block layout. Limits is a separate page. */
export type UsageLayoutScope = "session" | "project" | "global";
/** The dashboard's scope tab: an analytics scope or the Limits page. */
export type UsageDashboardView = UsageLayoutScope | "limits";
export type UsageDashboardRange = Exclude<UsageRangePreset, "custom">;
export type UsageBlockId =
  | "overview"
  | "activity"
  | "tokens"
  | "cache"
  | "timing"
  | "turns"
  | "projects"
  | "harnesses"
  | "models"
  | "sessions";

export interface UsageBlockLayout {
  /** Every block the scope offers, in display order. Hidden blocks keep their slot. */
  order: UsageBlockId[];
  hidden: UsageBlockId[];
}

export interface UsageDashboardPrefs {
  /**
   * The last chosen tab. A stored "session" with no active session shows
   * Project without overwriting the choice, so it comes back with a session.
   */
  view: UsageDashboardView;
  layouts: Record<UsageLayoutScope, UsageBlockLayout>;
  range: UsageDashboardRange;
  metric: UsageChartMetric;
}

/** The blocks each scope can show, in their default order. */
export const USAGE_SCOPE_BLOCKS: Readonly<Record<UsageLayoutScope, readonly UsageBlockId[]>> = {
  session: ["overview", "tokens", "cache", "timing", "turns"],
  project: ["overview", "activity", "tokens", "cache", "harnesses", "models", "sessions"],
  global: ["overview", "activity", "tokens", "cache", "projects", "harnesses", "models", "sessions"],
};

export const USAGE_DASHBOARD_PREFS_KEY = "polyth.usageDashboardPrefs";

const defaultLayout = (scope: UsageLayoutScope): UsageBlockLayout => ({
  order: [...USAGE_SCOPE_BLOCKS[scope]],
  hidden: [],
});

export const DEFAULT_USAGE_DASHBOARD_PREFS: UsageDashboardPrefs = {
  view: "session",
  layouts: {
    session: defaultLayout("session"),
    project: defaultLayout("project"),
    global: defaultLayout("global"),
  },
  range: "30d",
  metric: "tokens",
};

/**
 * Keep a stored layout usable across releases: unknown blocks are dropped,
 * duplicates collapse, and a block added later is inserted after the block
 * that precedes it by default instead of being appended at the very end.
 */
export function sanitizeUsageLayout(scope: UsageLayoutScope, value: unknown): UsageBlockLayout {
  const known = USAGE_SCOPE_BLOCKS[scope];
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as { order?: unknown; hidden?: unknown }
    : {};
  const pick = (list: unknown): UsageBlockId[] => Array.isArray(list)
    ? [...new Set(list.filter((id): id is UsageBlockId => typeof id === "string" && known.includes(id as UsageBlockId)))]
    : [];
  const order = pick(raw.order);
  known.forEach((id, index) => {
    if (order.includes(id)) return;
    const previous = known.slice(0, index).findLast((candidate) => order.includes(candidate));
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, id);
  });
  return { order, hidden: pick(raw.hidden) };
}

const isUsageDashboardView = (value: unknown): value is UsageDashboardView =>
  value === "session" || value === "project" || value === "global" || value === "limits";

/** `fallbackView` stands in for a missing or unknown tab, e.g. a value mirrored by an older client. */
export function sanitizeUsageDashboardPrefs(value: unknown, fallbackView: UsageDashboardView = "session"): UsageDashboardPrefs {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof UsageDashboardPrefs, unknown>>
    : {};
  const layouts = raw.layouts && typeof raw.layouts === "object" && !Array.isArray(raw.layouts)
    ? raw.layouts as Partial<Record<UsageLayoutScope, unknown>>
    : {};
  return {
    view: isUsageDashboardView(raw.view) ? raw.view : fallbackView,
    layouts: {
      session: sanitizeUsageLayout("session", layouts.session),
      project: sanitizeUsageLayout("project", layouts.project),
      global: sanitizeUsageLayout("global", layouts.global),
    },
    range: raw.range === "7d" || raw.range === "90d" || raw.range === "all" ? raw.range : "30d",
    metric: raw.metric === "cost" || raw.metric === "turns" ? raw.metric : "tokens",
  };
}

/** Move one block to `index` within the full order (hidden blocks included). */
export function moveUsageBlock(order: readonly UsageBlockId[], id: UsageBlockId, index: number): UsageBlockId[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const next = order.filter((candidate) => candidate !== id);
  next.splice(Math.max(0, Math.min(next.length, index)), 0, id);
  return next;
}

export function visibleUsageBlocks(layout: UsageBlockLayout): UsageBlockId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

/** The tab to render: a remembered Session tab falls back to Project while no session is active. */
export function effectiveUsageView(view: UsageDashboardView, activeSessionId: string | null | undefined): UsageDashboardView {
  return view === "session" && !activeSessionId ? "project" : view;
}

export function isDefaultUsageLayout(scope: UsageLayoutScope, layout: UsageBlockLayout): boolean {
  return layout.hidden.length === 0 && layout.order.join() === USAGE_SCOPE_BLOCKS[scope].join();
}

const listeners = new Set<() => void>();

const readLocal = (): UsageDashboardPrefs => {
  if (typeof localStorage === "undefined") return DEFAULT_USAGE_DASHBOARD_PREFS;
  try {
    const raw = localStorage.getItem(USAGE_DASHBOARD_PREFS_KEY);
    return raw ? sanitizeUsageDashboardPrefs(JSON.parse(raw)) : DEFAULT_USAGE_DASHBOARD_PREFS;
  } catch {
    return DEFAULT_USAGE_DASHBOARD_PREFS;
  }
};

let prefs = readLocal();

const persist = (): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(USAGE_DASHBOARD_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Server-backed preference mirroring remains authoritative when storage is unavailable.
  }
};

export function getUsageDashboardPrefs(): UsageDashboardPrefs {
  return prefs;
}

export function replaceUsageDashboardPrefs(value: unknown): void {
  const next = sanitizeUsageDashboardPrefs(value, prefs.view);
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  prefs = next;
  persist();
  for (const listener of [...listeners]) listener();
}

export function updateUsageDashboardPrefs(patch: Partial<UsageDashboardPrefs>): void {
  replaceUsageDashboardPrefs({ ...prefs, ...patch });
}

export function updateUsageLayout(scope: UsageLayoutScope, layout: UsageBlockLayout): void {
  updateUsageDashboardPrefs({ layouts: { ...prefs.layouts, [scope]: layout } });
}

export function resetUsageLayout(scope: UsageLayoutScope): void {
  updateUsageLayout(scope, defaultLayout(scope));
}

export function subscribeUsageDashboardPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUsageDashboardPrefs(): UsageDashboardPrefs {
  return useSyncExternalStore(subscribeUsageDashboardPrefs, getUsageDashboardPrefs, getUsageDashboardPrefs);
}
