import { useSyncExternalStore } from "react";

export type LimitDisplayMode = "remaining" | "used";
export type LimitResetFormat = "relative" | "exact" | "both";
export type LimitPaceSensitivity = "stable" | "balanced" | "responsive";

/** What drives the colour of a used-limit bar. */
export type LimitBarFactor = "percent" | "pace" | "static";
/** Named palette slots a static bar colour can use; each maps to a theme token. */
export const LIMIT_BAR_COLORS = ["accent", "green", "amber", "red", "blue", "purple", "neutral"] as const;
export type LimitBarColor = (typeof LIMIT_BAR_COLORS)[number];

export interface UsageLimitsPrefs {
  displayMode: LimitDisplayMode;
  resetFormat: LimitResetFormat;
  showPace: boolean;
  showProjections: boolean;
  paceSensitivity: LimitPaceSensitivity;
  lowRemainingPercent: number;
  paceWarnings: boolean;
  /** `percent` colours by remaining (or used) share, `pace` by burn rate, `static` uses barColor. */
  barFactor: LimitBarFactor;
  /** Static palette slot; only read while barFactor is `static`. */
  barColor: LimitBarColor;
  /** Remaining share below which a `percent` bar turns red instead of amber. */
  criticalRemainingPercent: number;
  hiddenSources: string[];
  /** Normalized provider ids in the order the user dragged the Limits panels. */
  sourceOrder: string[];
}

export const USAGE_LIMITS_PREFS_KEY = "polyth.usageLimitsPrefs";

export const DEFAULT_USAGE_LIMITS_PREFS: UsageLimitsPrefs = {
  displayMode: "remaining",
  resetFormat: "relative",
  showPace: true,
  showProjections: true,
  paceSensitivity: "balanced",
  lowRemainingPercent: 10,
  paceWarnings: true,
  barFactor: "pace",
  barColor: "accent",
  criticalRemainingPercent: 2,
  hiddenSources: [],
  sourceOrder: [],
};

/** Whether a bar-colour palette slot exists (legacy or hand-written values). */
export const isLimitBarColor = (value: unknown): value is LimitBarColor =>
  typeof value === "string" && (LIMIT_BAR_COLORS as readonly string[]).includes(value);

const listeners = new Set<() => void>();

export const sourceId = (value: string): string => value.trim().toLowerCase();

const sanitize = (value: unknown): UsageLimitsPrefs => {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<UsageLimitsPrefs>
    : {};
  const hiddenSources = Array.isArray(raw.hiddenSources)
    ? [...new Set(raw.hiddenSources.filter((entry): entry is string => typeof entry === "string")
      .map(sourceId)
      .filter(Boolean))]
      .slice(0, 128)
    : [];
  const threshold = typeof raw.lowRemainingPercent === "number" && Number.isFinite(raw.lowRemainingPercent)
    ? Math.round(Math.max(1, Math.min(50, raw.lowRemainingPercent)))
    : DEFAULT_USAGE_LIMITS_PREFS.lowRemainingPercent;
  const critical = typeof raw.criticalRemainingPercent === "number" && Number.isFinite(raw.criticalRemainingPercent)
    ? Math.round(Math.max(0, Math.min(50, raw.criticalRemainingPercent)))
    : DEFAULT_USAGE_LIMITS_PREFS.criticalRemainingPercent;
  const sourceOrder = Array.isArray(raw.sourceOrder)
    ? [...new Set(raw.sourceOrder.filter((entry): entry is string => typeof entry === "string")
      .map(sourceId)
      .filter(Boolean))]
      .slice(0, 256)
    : [];
  return {
    displayMode: raw.displayMode === "used" ? "used" : "remaining",
    resetFormat: raw.resetFormat === "exact" || raw.resetFormat === "both" ? raw.resetFormat : "relative",
    showPace: raw.showPace !== false,
    showProjections: raw.showProjections !== false,
    paceSensitivity: raw.paceSensitivity === "stable" || raw.paceSensitivity === "responsive"
      ? raw.paceSensitivity
      : "balanced",
    lowRemainingPercent: threshold,
    paceWarnings: raw.paceWarnings !== false,
    barFactor: raw.barFactor === "percent" || raw.barFactor === "static" ? raw.barFactor : "pace",
    barColor: isLimitBarColor(raw.barColor) ? raw.barColor : DEFAULT_USAGE_LIMITS_PREFS.barColor,
    criticalRemainingPercent: Math.min(critical, threshold),
    hiddenSources,
    sourceOrder,
  };
};

const readLocal = (): UsageLimitsPrefs => {
  if (typeof localStorage === "undefined") return DEFAULT_USAGE_LIMITS_PREFS;
  try {
    const raw = localStorage.getItem(USAGE_LIMITS_PREFS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_USAGE_LIMITS_PREFS;
  } catch {
    return DEFAULT_USAGE_LIMITS_PREFS;
  }
};

let prefs = readLocal();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(USAGE_LIMITS_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Server-backed preference mirroring remains authoritative when storage is unavailable.
  }
};

export function getUsageLimitsPrefs(): UsageLimitsPrefs {
  return prefs;
}

export function replaceUsageLimitsPrefs(value: unknown): void {
  const next = sanitize(value);
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  prefs = next;
  persist();
  emit();
}

export function updateUsageLimitsPrefs(patch: Partial<UsageLimitsPrefs>): void {
  replaceUsageLimitsPrefs({ ...prefs, ...patch });
}

export function setLimitSourceVisible(providerId: string, visible: boolean): void {
  const id = sourceId(providerId);
  const next = new Set(prefs.hiddenSources);
  if (visible) next.delete(id);
  else next.add(id);
  updateUsageLimitsPrefs({ hiddenSources: [...next] });
}

export function isLimitSourceVisible(providerId: string, value: UsageLimitsPrefs = prefs): boolean {
  return !value.hiddenSources.includes(sourceId(providerId));
}

/** Save the panel order exactly as it was set down; ids are normalized like visibility. */
export function setLimitSourceOrder(order: readonly string[]): void {
  updateUsageLimitsPrefs({ sourceOrder: order.map(sourceId).filter(Boolean) });
}

export function subscribeUsageLimitsPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUsageLimitsPrefs(): UsageLimitsPrefs {
  return useSyncExternalStore(subscribeUsageLimitsPrefs, getUsageLimitsPrefs, getUsageLimitsPrefs);
}
