// UX-A390 repair: the active workspace view survives reload. Browser-local
// presentation state (localStorage polyth.activeView) following the
// railPrefs.ts pattern — never session data, never appended to the event log.
import type { AppView } from "./store.ts";

export const ACTIVE_VIEW_KEY = "polyth.activeView";

const APP_VIEWS = [
  "session", "goals", "multirun", "fusion", "walkthrough", "schedule", "github",
] as const satisfies readonly AppView[];
const KNOWN = new Set<string>(APP_VIEWS);

/** Validate a stored view id; anything unknown falls back to the session view. */
export function parseActiveView(raw: string | null): AppView {
  return raw !== null && KNOWN.has(raw) ? (raw as AppView) : "session";
}

/** Restore the saved view. Workspace presets affect placement only, so a
 *  valid view remains restorable regardless of the current preset. */
export function loadActiveView(): AppView {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ACTIVE_VIEW_KEY); } catch { /* private mode / no DOM */ }
  return parseActiveView(raw);
}

export function saveActiveView(view: AppView): void {
  try { localStorage.setItem(ACTIVE_VIEW_KEY, view); } catch { /* private mode / no DOM */ }
}
