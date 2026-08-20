// UX-A390 repair: the active workspace view survives reload. Browser-local
// presentation state (localStorage polyth.activeView) following the
// railPrefs.ts pattern — never session data, never appended to the event log.
import { NAV, pluginOn } from "./prefs.ts";
import type { AppView } from "./store.ts";

export const ACTIVE_VIEW_KEY = "polyth.activeView";

const KNOWN = new Set<string>(NAV.map(([view]) => view));

/** Validate a stored view id; anything unknown falls back to the session view. */
export function parseActiveView(raw: string | null): AppView {
  return raw !== null && KNOWN.has(raw) ? (raw as AppView) : "session";
}

/** Restore the saved view. A view whose plugin was disabled since the save
 *  must not restore into an unreachable surface — it falls back to session. */
export function loadActiveView(): AppView {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ACTIVE_VIEW_KEY); } catch { /* private mode / no DOM */ }
  const view = parseActiveView(raw);
  const plugin = NAV.find(([v]) => v === view)?.[1];
  return plugin !== undefined && pluginOn(plugin) ? view : "session";
}

export function saveActiveView(view: AppView): void {
  try { localStorage.setItem(ACTIVE_VIEW_KEY, view); } catch { /* private mode / no DOM */ }
}
