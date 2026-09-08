// Honest sidebar presentation state for the app.nav bounded context
// (EXTENSION-SEAMS mounting matrix). store.sidebarOpen alone is the *mobile
// drawer* flag: at desktop width it stays false while the sidebar is visibly
// expanded, so exposing it as "expanded" lied to contributions. The real rule
// has two regimes — desktop widths always present the expanded sidebar; at the
// narrow breakpoint the CSS hides it unless the drawer is open.
import { useSyncExternalStore } from "react";

/** Keep in sync with the compact `@media (max-width: 960px)` rule in styles.css
 *  (COMPACT_MAX_WIDTH in responsiveShell.ts) that hides the sidebar in favour of
 *  the drawer (guarded by a regression test). */
export const SIDEBAR_NARROW_QUERY = "(max-width: 960px)";

/** Pure presentation rule: expanded on desktop always; on narrow viewports
 *  only while the drawer is open. */
export function sidebarExpanded(narrowViewport: boolean, drawerOpen: boolean): boolean {
  return !narrowViewport || drawerOpen;
}

let watch: MediaQueryList | null = null;
function narrowQuery(): MediaQueryList | null {
  if (watch === null && typeof matchMedia === "function") watch = matchMedia(SIDEBAR_NARROW_QUERY);
  return watch;
}

function subscribeNarrow(cb: () => void): () => void {
  const mq = narrowQuery();
  if (!mq) return () => {};
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function isNarrow(): boolean {
  return narrowQuery()?.matches ?? false;
}

/** The actual compact/expanded presentation of the sidebar — the honest
 *  `expanded` value the app.nav slot context carries. */
export function useSidebarExpanded(drawerOpen: boolean): boolean {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
  return sidebarExpanded(narrow, drawerOpen);
}
