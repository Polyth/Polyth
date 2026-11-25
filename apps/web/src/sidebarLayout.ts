// Desktop sidebar layout preferences:
// user-dragged width and the collapsed state. The local record is the
// synchronous cache for the account UI settings sync. Only the WIDE-mode
// inline sidebar reads these — the compact drawer keeps its own responsive
// geometry.
import { useSyncExternalStore } from "react";
import type { SidebarViewMode } from "./sidebarPrefs.ts";

export const SIDEBAR_LAYOUT_KEY = "polyth.sidebar.layout";

export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 440;
export const SIDEBAR_DEFAULT_WIDTH = 332;
/** Width of the collapsed rail that keeps the restore button reachable. */
export const SIDEBAR_COLLAPSED_WIDTH = 46;
/** Width of the project icon rail, which survives the sessions-only collapse
 *  in rail view: a 36px tile, a 6px gutter each side and the 1px divider.
 *  Mirrors `--rail-project-track` in styles.css. */
export const SIDEBAR_RAIL_WIDTH = 49;

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
  /** Presentation to restore when a collapsed rail is expanded. */
  restoreViewMode: SidebarViewMode | null;
}

export const SIDEBAR_LAYOUT_DEFAULTS: SidebarLayout = {
  width: SIDEBAR_DEFAULT_WIDTH,
  collapsed: false,
  restoreViewMode: null,
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
      restoreViewMode: data.collapsed === true
        && (data.restoreViewMode === "tree" || data.restoreViewMode === "rail")
        ? data.restoreViewMode
        : null,
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
  const collapsed = patch.collapsed ?? layout.collapsed;
  layout = {
    width: clampSidebarWidth(patch.width ?? layout.width),
    collapsed,
    restoreViewMode: collapsed
      ? patch.restoreViewMode !== undefined ? patch.restoreViewMode : layout.restoreViewMode
      : null,
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

export function subscribeSidebarLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ---- automatic project rail ----------------------------------------------------
// The wide sidebar may rest on its project rail by itself:
// - "profile": a focused workbench profile declares
//   `presentation.sidebarRailBelow`, and the viewport is below that width;
// - "split": two chats side by side would not fit beside the full sidebar
//   (sessionSplit.ts `splitWantsSidebarRail`), until the split closes.
// This is presentation state only — it lives in memory, is never written to
// SIDEBAR_LAYOUT_KEY / account settings, and the person's own `collapsed`
// preference is untouched. Expanding the rail by hand releases the automatic
// collapse until a source next becomes true.

export type AutomaticSidebarRailSource = "profile" | "split";

/** Pure: does the active profile's hint collapse the wide sidebar now? */
export function automaticSidebarRail(input: {
  wide: boolean;
  /** The active profile's `sidebarRailBelow` (already validated), or null. */
  sidebarRailBelow: number | null;
  viewportBelow: boolean;
}): boolean {
  return input.wide && input.sidebarRailBelow !== null && input.viewportBelow;
}

export interface AutomaticSidebarRail {
  active: boolean;
  /** The person expanded the rail by hand while the condition held. */
  released: boolean;
  /** Which sources ask for the rail now. */
  sources: readonly AutomaticSidebarRailSource[];
}

let automatic: AutomaticSidebarRail = { active: false, released: false, sources: [] };
const automaticListeners = new Set<() => void>();

function publishAutomatic(next: AutomaticSidebarRail): void {
  if (next.active === automatic.active && next.released === automatic.released
    && next.sources.length === automatic.sources.length
    && next.sources.every((source) => automatic.sources.includes(source))) return;
  automatic = next;
  for (const l of [...automaticListeners]) l();
}

export function getAutomaticSidebarRail(): AutomaticSidebarRail {
  return automatic;
}

/** A source publishes its condition; a newly asking source clears an old
 *  release, so the rail comes back when, say, a split opens. */
export function setAutomaticSidebarRailSource(source: AutomaticSidebarRailSource, active: boolean): void {
  const had = automatic.sources.includes(source);
  if (had === active) return;
  const sources = active
    ? [...automatic.sources, source]
    : automatic.sources.filter((candidate) => candidate !== source);
  const nextActive = sources.length > 0;
  publishAutomatic({
    active: nextActive,
    released: nextActive && !active ? automatic.released : false,
    sources,
  });
}

/** App publishes the profile condition. */
export function setAutomaticSidebarRail(active: boolean): void {
  setAutomaticSidebarRailSource("profile", active);
}

/** Expand by hand while automatic: in memory only. */
export function releaseAutomaticSidebarRail(): void {
  if (automatic.active) publishAutomatic({ ...automatic, released: true });
}

/** The wide sidebar is rail-collapsed by the automatic hint right now. */
export function isAutomaticSidebarRailApplied(state: AutomaticSidebarRail = automatic): boolean {
  return state.active && !state.released;
}

export function useAutomaticSidebarRail(): AutomaticSidebarRail {
  return useSyncExternalStore(
    (cb) => {
      automaticListeners.add(cb);
      return () => { automaticListeners.delete(cb); };
    },
    getAutomaticSidebarRail,
  );
}
