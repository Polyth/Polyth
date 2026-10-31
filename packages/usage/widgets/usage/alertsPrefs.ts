import { useSyncExternalStore } from "react";
import { sourceId } from "./limitsPrefs.ts";

/** Which pace reading raises a pace alert. */
export type AlertPaceLevel = "elevated" | "likely";
/** Which chats report a summary after their turn. */
export type TurnSummaryScope = "active" | "all";
export type TurnSummaryPart = "tokens" | "cost" | "limits";
export type AlertDuration = "brief" | "normal" | "long";
export type CacheLeadMinutes = 1 | 2 | 5;

export const LOW_ALERT_LEVELS = [50, 25, 10, 5] as const;
export const TURN_SUMMARY_PARTS: readonly TurnSummaryPart[] = ["tokens", "cost", "limits"];

export interface UsageAlertPrefs {
  /** Master switch for every usage notification. */
  enabled: boolean;
  /** Epoch ms until which nothing is shown; 0 when not paused. */
  pausedUntil: number;
  /** Limit warnings stay until dismissed instead of timing out. */
  keepOnScreen: boolean;
  /** Normalized source ids whose limits never alert. */
  mutedSources: string[];
  pace: boolean;
  paceLevel: AlertPaceLevel;
  low: boolean;
  /** Percent-left levels, each alerting once per limit period. */
  lowLevels: number[];
  exhausted: boolean;
  restored: boolean;
  turn: boolean;
  turnScope: TurnSummaryScope;
  turnParts: TurnSummaryPart[];
  /** Turns under this many tokens stay quiet; 0 reports every turn. */
  turnMinTokens: number;
  turnDuration: AlertDuration;
  cache: boolean;
  cacheLeadMinutes: CacheLeadMinutes;
  sourceProblems: boolean;
}

export const USAGE_ALERT_PREFS_KEY = "polyth.usageAlertPrefs";

export const DEFAULT_USAGE_ALERT_PREFS: UsageAlertPrefs = {
  enabled: true,
  pausedUntil: 0,
  keepOnScreen: false,
  mutedSources: [],
  pace: true,
  paceLevel: "elevated",
  low: true,
  lowLevels: [25, 10],
  exhausted: true,
  restored: true,
  turn: false,
  turnScope: "active",
  turnParts: ["tokens", "cost", "limits"],
  turnMinTokens: 0,
  turnDuration: "brief",
  cache: false,
  cacheLeadMinutes: 1,
  sourceProblems: true,
};

/** Lifetime of a turn summary on screen. */
export const ALERT_DURATION_MS: Readonly<Record<AlertDuration, number>> = {
  brief: 4_000,
  normal: 8_000,
  long: 15_000,
};

const MAX_TURN_MIN_TOKENS = 10_000_000;

const sanitize = (value: unknown): UsageAlertPrefs => {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof UsageAlertPrefs, unknown>>
    : {};
  const flag = (key: keyof UsageAlertPrefs): boolean =>
    typeof raw[key] === "boolean" ? raw[key] as boolean : DEFAULT_USAGE_ALERT_PREFS[key] as boolean;
  const mutedSources = Array.isArray(raw.mutedSources)
    ? [...new Set(raw.mutedSources.filter((entry): entry is string => typeof entry === "string").map(sourceId).filter(Boolean))]
      .slice(0, 128)
    : [];
  // Stored order is the canonical (descending) one so equality checks are stable.
  const lowLevels = Array.isArray(raw.lowLevels)
    ? LOW_ALERT_LEVELS.filter((level) => (raw.lowLevels as unknown[]).includes(level))
    : [...DEFAULT_USAGE_ALERT_PREFS.lowLevels];
  const turnParts = Array.isArray(raw.turnParts)
    ? TURN_SUMMARY_PARTS.filter((part) => (raw.turnParts as unknown[]).includes(part))
    : [...DEFAULT_USAGE_ALERT_PREFS.turnParts];
  const pausedUntil = typeof raw.pausedUntil === "number" && Number.isFinite(raw.pausedUntil) && raw.pausedUntil > 0
    ? Math.round(raw.pausedUntil)
    : 0;
  const turnMinTokens = typeof raw.turnMinTokens === "number" && Number.isFinite(raw.turnMinTokens)
    ? Math.round(Math.max(0, Math.min(MAX_TURN_MIN_TOKENS, raw.turnMinTokens)))
    : 0;
  return {
    enabled: flag("enabled"),
    pausedUntil,
    keepOnScreen: flag("keepOnScreen"),
    mutedSources,
    pace: flag("pace"),
    paceLevel: raw.paceLevel === "likely" ? "likely" : "elevated",
    low: flag("low"),
    lowLevels,
    exhausted: flag("exhausted"),
    restored: flag("restored"),
    turn: flag("turn"),
    turnScope: raw.turnScope === "all" ? "all" : "active",
    turnParts,
    turnMinTokens,
    turnDuration: raw.turnDuration === "normal" || raw.turnDuration === "long" ? raw.turnDuration : "brief",
    cache: flag("cache"),
    cacheLeadMinutes: raw.cacheLeadMinutes === 2 || raw.cacheLeadMinutes === 5 ? raw.cacheLeadMinutes : 1,
    sourceProblems: flag("sourceProblems"),
  };
};

export const sanitizeUsageAlertPrefs = sanitize;

const listeners = new Set<() => void>();

const readLocal = (): UsageAlertPrefs => {
  if (typeof localStorage === "undefined") return DEFAULT_USAGE_ALERT_PREFS;
  try {
    const raw = localStorage.getItem(USAGE_ALERT_PREFS_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_USAGE_ALERT_PREFS;
  } catch {
    return DEFAULT_USAGE_ALERT_PREFS;
  }
};

let prefs = readLocal();

const emit = () => {
  for (const listener of listeners) listener();
};

const persist = () => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(USAGE_ALERT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Server-backed preference mirroring remains authoritative when storage is unavailable.
  }
};

export function getUsageAlertPrefs(): UsageAlertPrefs {
  return prefs;
}

export function replaceUsageAlertPrefs(value: unknown): void {
  const next = sanitize(value);
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  prefs = next;
  persist();
  emit();
}

export function updateUsageAlertPrefs(patch: Partial<UsageAlertPrefs>): void {
  replaceUsageAlertPrefs({ ...prefs, ...patch });
}

export function resetUsageAlertPrefs(): void {
  replaceUsageAlertPrefs(DEFAULT_USAGE_ALERT_PREFS);
}

/** Whether the alert settings already equal the defaults (pause excluded). */
export function usageAlertPrefsAreDefault(value: UsageAlertPrefs = prefs): boolean {
  return JSON.stringify({ ...value, pausedUntil: 0 }) === JSON.stringify(DEFAULT_USAGE_ALERT_PREFS);
}

export function isAlertSourceMuted(providerId: string, value: UsageAlertPrefs = prefs): boolean {
  return value.mutedSources.includes(sourceId(providerId));
}

export function setAlertSourceMuted(providerId: string, muted: boolean): void {
  const id = sourceId(providerId);
  const next = new Set(prefs.mutedSources);
  if (muted) next.add(id);
  else next.delete(id);
  updateUsageAlertPrefs({ mutedSources: [...next] });
}

/** Whether notifications are paused at `now`. */
export function alertsPaused(value: UsageAlertPrefs, now: number): boolean {
  return value.pausedUntil > now;
}

export function subscribeUsageAlertPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUsageAlertPrefs(): UsageAlertPrefs {
  return useSyncExternalStore(subscribeUsageAlertPrefs, getUsageAlertPrefs, getUsageAlertPrefs);
}
