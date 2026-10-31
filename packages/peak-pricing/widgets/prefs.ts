// Browser preferences for the peak-pricing chip. Local storage is the
// synchronous cache; the package registers this store with
// `host.preferences` so the account's settings sync carries it like every
// other package preference.
import { useSyncExternalStore } from "react";

export type PeakPricingDisplay = "full" | "compact" | "dot";

export const PEAK_PRICING_DISPLAYS: readonly PeakPricingDisplay[] = ["full", "compact", "dot"];

export interface PeakPricingPrefs {
  /** `false` renders nothing in the composer. */
  enabled: boolean;
  /** `full`: state and countdown. `compact`: state only. `dot`: the glyph only. */
  display: PeakPricingDisplay;
  /** Hover/focus summary. The click card is always available. */
  tooltip: boolean;
}

export const PEAK_PRICING_PREFS_KEY = "polyth.peakPricingPrefs";

/** Today's chip: full display with its hover summary. */
export const DEFAULT_PEAK_PRICING_PREFS: Readonly<PeakPricingPrefs> = Object.freeze({
  enabled: true,
  display: "full",
  tooltip: true,
});

/** Spellings that mean a known display (the request's own wording, case and
 *  separator variants). Anything else falls back to the default. */
const DISPLAY_ALIASES: Readonly<Record<string, PeakPricingDisplay>> = {
  full: "full",
  compact: "compact",
  dot: "dot",
  dotonly: "dot",
};

function sanitizeDisplay(value: unknown): PeakPricingDisplay {
  if (typeof value !== "string") return DEFAULT_PEAK_PRICING_PREFS.display;
  return DISPLAY_ALIASES[value.toLowerCase().replace(/[^a-z]/g, "")] ?? DEFAULT_PEAK_PRICING_PREFS.display;
}

export function sanitizePeakPricingPrefs(value: unknown): PeakPricingPrefs {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<Record<keyof PeakPricingPrefs, unknown>>
    : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_PEAK_PRICING_PREFS.enabled,
    display: sanitizeDisplay(record.display),
    tooltip: typeof record.tooltip === "boolean" ? record.tooltip : DEFAULT_PEAK_PRICING_PREFS.tooltip,
  };
}

const listeners = new Set<() => void>();
let cache: PeakPricingPrefs | undefined;

const samePrefs = (left: PeakPricingPrefs, right: PeakPricingPrefs): boolean =>
  left.enabled === right.enabled && left.display === right.display && left.tooltip === right.tooltip;

function readStorage(): PeakPricingPrefs {
  try {
    if (typeof localStorage !== "undefined") return sanitizePeakPricingPrefs(localStorage.getItem(PEAK_PRICING_PREFS_KEY));
  } catch {
    // Storage can be denied (private mode, sandboxed frames): defaults apply.
  }
  return { ...DEFAULT_PEAK_PRICING_PREFS };
}

export function getPeakPricingPrefs(): PeakPricingPrefs {
  cache ??= readStorage();
  return cache;
}

/** Replace the whole record (the account-sync adapter writes this way). */
export function replacePeakPricingPrefs(value: unknown): void {
  const next = sanitizePeakPricingPrefs(value);
  if (samePrefs(next, getPeakPricingPrefs())) return;
  cache = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PEAK_PRICING_PREFS_KEY, JSON.stringify(next));
  } catch {
    // The in-memory value still applies for this page.
  }
  for (const listener of [...listeners]) listener();
}

export function updatePeakPricingPrefs(patch: Partial<PeakPricingPrefs>): void {
  replacePeakPricingPrefs({ ...getPeakPricingPrefs(), ...patch });
}

/** Another tab changed the stored record: drop the cache and repaint. */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PEAK_PRICING_PREFS_KEY) return;
  const next = readStorage();
  if (cache && samePrefs(next, cache)) return;
  cache = next;
  for (const listener of [...listeners]) listener();
}

export function subscribePeakPricingPrefs(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Without storage (static render) the store holds the defaults or whatever
 *  was written in memory, so both snapshots read the same record. */
export function usePeakPricingPrefs(): PeakPricingPrefs {
  return useSyncExternalStore(subscribePeakPricingPrefs, getPeakPricingPrefs, getPeakPricingPrefs);
}

/** Test seam: forget the cached record so the next read hits storage. */
export function resetPeakPricingPrefsCache(): void {
  cache = undefined;
}
