// Desktop sidebar layout preferences (UX-SHELL-CONSOLIDATION-02 finding 2):
// user-dragged width and the collapsed state, persisted in localStorage like
// the other UI pref modules (railPrefs/uiPrefs). Only the WIDE-mode inline
// sidebar reads these — the compact drawer keeps its own responsive geometry.
import { useSyncExternalStore } from "react";

export const SIDEBAR_LAYOUT_KEY = "polyth.sidebar.layout";

export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 440;
export const SIDEBAR_DEFAULT_WIDTH = 332;
/** Width of the collapsed rail that keeps the restore button reachable. */
export const SIDEBAR_COLLAPSED_WIDTH = 46;
/** Width of the project icon rail, which survives the sessions-only collapse
 *  in rail view. Mirrors `.sidebar-project-rail` in styles.css. */
export const SIDEBAR_RAIL_WIDTH = 58;

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
}

export const SIDEBAR_LAYOUT_DEFAULTS: SidebarLayout = {
  width: SIDEBAR_DEFAULT_WIDTH,
  collapsed: false,
};

/** Pure clamp shared by drag, keyboard resize, and parsing. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function parseSidebarLayout(raw: string | null): SidebarLayout {
  try {
    const data = JSON.parse(raw ?? "") as Partial<SidebarLayout>;
    return {
      width: clampSidebarWidth(Number(data.width)),
      collapsed: data.collapsed === true,
    };
  } catch {
    return { ...SIDEBAR_LAYOUT_DEFAULTS };
  }
}

const read = (): string | null => {
  try { return localStorage.getItem(SIDEBAR_LAYOUT_KEY); } catch { return null; }
};
const write = (v: string): void => {
  try { localStorage.setItem(SIDEBAR_LAYOUT_KEY, v); } catch { /* private mode */ }
};

let layout: SidebarLayout = parseSidebarLayout(read());
const listeners = new Set<() => void>();

export function getSidebarLayout(): SidebarLayout {
  return layout;
}

export function setSidebarLayout(patch: Partial<SidebarLayout>): void {
  layout = {
    width: clampSidebarWidth(patch.width ?? layout.width),
    collapsed: patch.collapsed ?? layout.collapsed,
  };
  write(JSON.stringify(layout));
  for (const l of [...listeners]) l();
}

export function useSidebarLayout(): SidebarLayout {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getSidebarLayout,
  );
}
