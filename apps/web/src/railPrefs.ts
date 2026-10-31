// Right-rail persistence — last-open surface and per-surface panel widths.
// The local record is the synchronous cache for the account UI settings sync;
// it is never session data.

export interface RailPrefs {
  /** Surface id open when the app closed; null = rail was closed. */
  lastOpen: string | null;
  /** Per-surface panel width in px. */
  widths: Record<string, number>;
}

export const RAIL_PREFS_KEY = "polyth.railPrefs";

export const RAIL_WIDTH_DEFAULT = 300;
export const RAIL_WIDTH_MIN = 240;
export const RAIL_WIDTH_MAX = 640;

export const clampRailWidth = (w: number): number =>
  Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(w)));

export function parseRailPrefs(raw: string | null): RailPrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<RailPrefs>;
    const widths: Record<string, number> = {};
    if (typeof data.widths === "object" && data.widths !== null) {
      for (const [id, w] of Object.entries(data.widths).slice(0, 64)) {
        if (typeof id === "string" && id && typeof w === "number" && Number.isFinite(w)) {
          widths[id] = clampRailWidth(w);
        }
      }
    }
    return {
      lastOpen: typeof data.lastOpen === "string" && data.lastOpen !== "" ? data.lastOpen : null,
      widths,
    };
  } catch {
    return { lastOpen: null, widths: {} };
  }
}

let prefs: RailPrefs = parseRailPrefs(
  (() => {
    try { return localStorage.getItem(RAIL_PREFS_KEY); } catch { return null; }
  })(),
);
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function persist(): void {
  try { localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  notify();
}

export function getRailPrefs(): RailPrefs {
  return prefs;
}

export function replaceRailPrefs(value: unknown): void {
  prefs = parseRailPrefs(typeof value === "string" ? value : JSON.stringify(value));
  persist();
}

export function subscribeRailPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setRailLastOpen(id: string | null): void {
  if (prefs.lastOpen === id) return;
  prefs = { ...prefs, lastOpen: id };
  persist();
}

export function setRailWidth(id: string, width: number): void {
  prefs = { ...prefs, widths: { ...prefs.widths, [id]: clampRailWidth(width) } };
  persist();
}

export function railWidthOf(id: string | null): number {
  return (id !== null ? prefs.widths[id] : undefined) ?? RAIL_WIDTH_DEFAULT;
}
