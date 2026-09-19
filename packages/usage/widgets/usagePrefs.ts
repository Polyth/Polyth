// Reactive browser cache for server-owned Usage preferences. The central
// /api/settings/client settings blob is the persistence authority; browser
// storage is only a synchronous bootstrap/migration cache.
import { useSyncExternalStore } from "react";
import {
  accountStorageGet,
  accountStorageKey,
  accountStorageSet,
} from "@polyth/web/account-storage";
import { tr } from "../../../apps/web/src/i18n/index.ts";

// ---- model-family grouping (pure) ------------------------------------------

const FAMILY_ALIAS: Record<string, string> = {
  claude: "claude", sonnet: "claude", opus: "claude", haiku: "claude",
  gpt: "gpt", chatgpt: "gpt",
  codex: "codex",
  gemini: "gemini", gemma: "gemini",
  grok: "grok",
  llama: "llama",
  mistral: "mistral", mixtral: "mistral", codestral: "mistral",
  deepseek: "deepseek",
  qwen: "qwen", qwq: "qwen",
  kimi: "kimi",
  glm: "glm",
  phi: "phi",
};

const UPPER_LABELS = new Set([tr("usageprefs.gpt"), tr("usageprefs.glm")]);

export function modelFamily(text: string): string | null {
  const tokens = text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  for (const token of tokens) {
    const exact = FAMILY_ALIAS[token];
    if (exact) return exact;
    if (/^o\d$/.test(token)) return token;
    const prefix = /^([a-z]+)\d/.exec(token)?.[1];
    if (prefix && FAMILY_ALIAS[prefix]) return FAMILY_ALIAS[prefix];
  }
  return null;
}

export function familyLabel(family: string): string {
  if (UPPER_LABELS.has(family)) return family.toUpperCase();
  if (/^o\d$/.test(family)) return family;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

export interface QuotaWindowLike { id: string; label: string }

export interface QuotaWindowGroup<W extends QuotaWindowLike> {
  family: string | null;
  label: string;
  windows: W[];
}

export function groupQuotaWindows<W extends QuotaWindowLike>(windows: readonly W[]): QuotaWindowGroup<W>[] {
  const byKey = new Map<string, QuotaWindowGroup<W>>();
  for (const w of windows) {
    const family = modelFamily(`${w.id} ${w.label}`);
    const key = family ?? "";
    let group = byKey.get(key);
    if (!group) {
      group = { family, label: family ? familyLabel(family) : tr("usageprefs.general"), windows: [] };
      byKey.set(key, group);
    }
    group.windows.push(w);
  }
  const all = [...byKey.values()];
  return [...all.filter((g) => g.family === null), ...all.filter((g) => g.family !== null)];
}

// ---- persisted display prefs ------------------------------------------------

export type UsageBillingKind = "api" | "subscription";
export type UsageChartStyle = "bar" | "line";
export type UsageDashboardDensity = "compact" | "comfortable";
export type UsageMetricId =
  | "cost"
  | "tokens"
  | "sessions"
  | "ttft"
  | "tps"
  | "cache"
  | "errors"
  | "success";
export type UsagePerformanceStatistic = "p50" | "average" | "p95";
export type UsageBreakdownDimension = "provider" | "model" | "harness" | "project";
export type UsageProviderSort = "quota" | "spend" | "usage" | "name" | "manual";

export interface UsageProviderCostProfile {
  billing: UsageBillingKind;
  /** Fixed subscription price in USD/month. */
  monthlyCost: number | null;
  /** Optional API budget in USD/month. */
  monthlyBudget: number | null;
}

export interface UsageCustomRange {
  /** YYYY-MM-DD, interpreted in the browser's local timezone. */
  start: string;
  /** YYYY-MM-DD, inclusive, interpreted in the browser's local timezone. */
  end: string;
}

export interface UsageDashboardPrefs {
  view: "overview" | "providers";
  layout: UsageDashboardDensity;
  rangeDays: 7 | 30 | 90;
  rangeMode: "preset" | "custom";
  customRange: UsageCustomRange | null;
  chartStyle: UsageChartStyle;
  chartMetric: "tokens" | "cost" | "sessions";
  chartGrouping: UsageBreakdownDimension;
  distributionGrouping: UsageBreakdownDimension;
  showChartLegend: boolean;
  providerSort: UsageProviderSort;
  cardMetrics: UsageMetricId[];
  performanceStatistic: UsagePerformanceStatistic;
  showApiEquivalent: boolean;
  showValueMultiplier: boolean;
  showQuotaDetails: boolean;
  overviewOrder: string[];
  providerOrder: string[];
}

export interface UsagePrefs {
  hiddenProviders: string[];
  /** Analytical blocks hidden from Overview. Current ids: usage-trend, performance, distribution. */
  hiddenBlocks: string[];
  /** Legacy presentation preference retained for migration; cards no longer expose permanent pin controls. */
  pinnedProviders: string[];
  collapsedGroups: string[];
  providerCosts: Record<string, UsageProviderCostProfile>;
  dashboard: UsageDashboardPrefs;
}

export const USAGE_PREFS_KEY = "polyth.usagePrefs";
const MAX_ENTRIES = 128;
const ALL_CARD_METRICS: UsageMetricId[] = ["cost", "tokens", "sessions", "ttft", "tps", "cache"];
const DIMENSIONS: UsageBreakdownDimension[] = ["provider", "model", "harness", "project"];
const PROVIDER_SORTS: UsageProviderSort[] = ["quota", "spend", "usage", "name", "manual"];
const METRICS: UsageMetricId[] = ["cost", "tokens", "sessions", "ttft", "tps", "cache", "errors", "success"];

const DEFAULT_DASHBOARD_PREFS: UsageDashboardPrefs = {
  view: "providers",
  layout: "compact",
  rangeDays: 7,
  rangeMode: "preset",
  customRange: null,
  chartStyle: "bar",
  chartMetric: "tokens",
  chartGrouping: "provider",
  distributionGrouping: "model",
  showChartLegend: true,
  providerSort: "quota",
  cardMetrics: ALL_CARD_METRICS,
  performanceStatistic: "p50",
  showApiEquivalent: true,
  showValueMultiplier: true,
  showQuotaDetails: true,
  overviewOrder: [],
  providerOrder: [],
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === "string" && s !== "").slice(0, MAX_ENTRIES)
    : [];

const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;

const finiteMoney = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : null;

const validDateOnly = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

const providerCostProfiles = (value: unknown): Record<string, UsageProviderCostProfile> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([providerId]) => providerId.trim() !== "")
      .slice(0, MAX_ENTRIES)
      .map(([providerId, rawProfile]) => {
        const profile = rawProfile && typeof rawProfile === "object"
          ? rawProfile as Partial<UsageProviderCostProfile>
          : {};
        return [providerId, {
          billing: profile.billing === "subscription" ? "subscription" : "api",
          monthlyCost: finiteMoney(profile.monthlyCost),
          monthlyBudget: finiteMoney(profile.monthlyBudget),
        } satisfies UsageProviderCostProfile] as const;
      }),
  );
};

const customRange = (value: unknown): UsageCustomRange | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<UsageCustomRange>;
  const start = validDateOnly(raw.start);
  const end = validDateOnly(raw.end);
  return start && end && start <= end ? { start, end } : null;
};

export function parseUsagePrefs(raw: string | null): UsagePrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<UsagePrefs>;
    const dashboard = data.dashboard as Partial<UsageDashboardPrefs> & { layout?: string } | undefined;
    const parsedCustomRange = customRange(dashboard?.customRange);
    const cardMetrics = stringList(dashboard?.cardMetrics)
      .filter((metric): metric is UsageMetricId => METRICS.includes(metric as UsageMetricId));
    return {
      hiddenProviders: stringList(data.hiddenProviders),
      hiddenBlocks: stringList(data.hiddenBlocks),
      pinnedProviders: stringList(data.pinnedProviders),
      collapsedGroups: stringList(data.collapsedGroups),
      providerCosts: providerCostProfiles(data.providerCosts),
      dashboard: {
        view: dashboard?.view === "overview" ? "overview" : "providers",
        layout: dashboard?.layout === "comfortable" || dashboard?.layout === "expanded"
          ? "comfortable"
          : "compact",
        rangeDays: dashboard?.rangeDays === 30 || dashboard?.rangeDays === 90 ? dashboard.rangeDays : 7,
        rangeMode: dashboard?.rangeMode === "custom" && parsedCustomRange ? "custom" : "preset",
        customRange: parsedCustomRange,
        chartStyle: dashboard?.chartStyle === "line" ? "line" : "bar",
        chartMetric: dashboard?.chartMetric === "cost" || dashboard?.chartMetric === "sessions"
          ? dashboard.chartMetric
          : "tokens",
        chartGrouping: enumValue(dashboard?.chartGrouping, DIMENSIONS, "provider"),
        distributionGrouping: enumValue(dashboard?.distributionGrouping, DIMENSIONS, "model"),
        showChartLegend: dashboard?.showChartLegend !== false,
        providerSort: enumValue(dashboard?.providerSort, PROVIDER_SORTS, "quota"),
        cardMetrics: cardMetrics.length > 0 ? cardMetrics : [...ALL_CARD_METRICS],
        performanceStatistic: dashboard?.performanceStatistic === "average" || dashboard?.performanceStatistic === "p95"
          ? dashboard.performanceStatistic
          : "p50",
        showApiEquivalent: dashboard?.showApiEquivalent !== false,
        showValueMultiplier: dashboard?.showValueMultiplier !== false,
        showQuotaDetails: dashboard?.showQuotaDetails !== false,
        overviewOrder: stringList(dashboard?.overviewOrder),
        providerOrder: stringList(dashboard?.providerOrder),
      },
    };
  } catch {
    return {
      hiddenProviders: [],
      hiddenBlocks: [],
      pinnedProviders: [],
      collapsedGroups: [],
      providerCosts: {},
      dashboard: { ...DEFAULT_DASHBOARD_PREFS, cardMetrics: [...ALL_CARD_METRICS] },
    };
  }
}

let prefs: UsagePrefs = parseUsagePrefs(accountStorageGet(USAGE_PREFS_KEY));
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

// Keep open tabs for the active account aligned. settingsSync observes this
// same subscription and mirrors the change once through the server-owned blob.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== accountStorageKey(USAGE_PREFS_KEY)) return;
    prefs = parseUsagePrefs(event.newValue);
    notify();
  });
}

const commit = (next: UsagePrefs): void => {
  prefs = next;
  accountStorageSet(USAGE_PREFS_KEY, JSON.stringify(prefs));
  notify();
};

export function getUsagePrefs(): UsagePrefs {
  return prefs;
}

/** Apply the authoritative server snapshot while refreshing the local cache. */
export function replaceUsagePrefs(next: UsagePrefs): void {
  commit(parseUsagePrefs(JSON.stringify(next)));
}

/** Shared subscription seam for React and central server-settings sync. */
export function subscribeUsagePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const toggled = (list: string[], entry: string, on: boolean): string[] =>
  on ? (list.includes(entry) ? list : [...list, entry].slice(-MAX_ENTRIES)) : list.filter((e) => e !== entry);

export function setProviderHidden(providerId: string, hidden: boolean): void {
  commit({ ...prefs, hiddenProviders: toggled(prefs.hiddenProviders, providerId, hidden) });
}

export function setBlockHidden(blockId: string, hidden: boolean): void {
  commit({ ...prefs, hiddenBlocks: toggled(prefs.hiddenBlocks, blockId, hidden) });
}

export function setProviderPinned(providerId: string, pinned: boolean): void {
  commit({ ...prefs, pinnedProviders: toggled(prefs.pinnedProviders, providerId, pinned) });
}

export function setGroupCollapsed(key: string, collapsed: boolean): void {
  commit({ ...prefs, collapsedGroups: toggled(prefs.collapsedGroups, key, collapsed) });
}

export function setProviderCostProfile(providerId: string, patch: Partial<UsageProviderCostProfile>): void {
  const current = prefs.providerCosts[providerId] ?? { billing: "api", monthlyCost: null, monthlyBudget: null };
  const next: UsageProviderCostProfile = {
    billing: patch.billing === "subscription"
      ? "subscription"
      : patch.billing === "api"
        ? "api"
        : current.billing,
    monthlyCost: patch.monthlyCost === undefined ? current.monthlyCost : finiteMoney(patch.monthlyCost),
    monthlyBudget: patch.monthlyBudget === undefined ? current.monthlyBudget : finiteMoney(patch.monthlyBudget),
  };
  commit({ ...prefs, providerCosts: { ...prefs.providerCosts, [providerId]: next } });
}

export function setUsageDashboardPrefs(patch: Partial<UsageDashboardPrefs>): void {
  commit({ ...prefs, dashboard: { ...prefs.dashboard, ...patch } });
}

export function orderUsageBlocks<T>(items: readonly T[], order: readonly string[], id: (item: T) => string): T[] {
  const rank = new Map(order.map((itemId, index) => [itemId, index]));
  return [...items].sort((left, right) =>
    (rank.get(id(left)) ?? order.length) - (rank.get(id(right)) ?? order.length));
}

export function orderPinnedUsageBlocks<T>(
  items: readonly T[],
  order: readonly string[],
  pinned: readonly string[],
  id: (item: T) => string,
): T[] {
  const ordered = orderUsageBlocks(items, order, id);
  const pinnedIds = new Set(pinned);
  return [
    ...ordered.filter((item) => pinnedIds.has(id(item))),
    ...ordered.filter((item) => !pinnedIds.has(id(item))),
  ];
}

export function moveUsageBlock(ids: readonly string[], id: string, to: string | number): string[] {
  const current = ids.indexOf(id);
  if (current < 0) return [...ids];
  const target = typeof to === "number"
    ? Math.max(0, Math.min(ids.length - 1, current + to))
    : ids.indexOf(to);
  if (target < 0 || target === current) return [...ids];
  const next = [...ids];
  next.splice(current, 1);
  next.splice(target, 0, id);
  return next;
}

export function useUsagePrefs(): UsagePrefs {
  return useSyncExternalStore(
    subscribeUsagePrefs,
    getUsagePrefs,
    getUsagePrefs,
  );
}
