// Stable keep-alive mount nodes for workbench surfaces. Every kept-alive
// surface renders (via a React portal) into ONE DOM node that is created once
// per surface id and never recreated. Region slots ADOPT that node with
// appendChild wherever the layout places the surface, so moving Chat from the
// primary region to the start region — or docking a floating package window —
// reparents DOM only: the React subtree, its state, subscriptions, scroll
// positions, and a streaming turn are untouched (react-reverse-portal's
// technique, kept in-house). Focus that the move would drop is restored by the
// adopting slot.
//
// DOM-only helpers (no React) so the mounted tests can assert on them directly.

const nodes = new Map<string, HTMLElement>();
const lastFocus = new Map<string, HTMLElement>();
const scrollMemory = new WeakMap<HTMLElement, Array<[Element, number, number]>>();

/** Selectors of scroll containers whose offsets are re-applied after a move
 *  (browsers keep most, this makes the timeline and editors deterministic). */
const SCROLL_KEEPERS = ".timeline, .rail-body, .module-view-content, .editor-body, .cm-scroller, [data-scroll-keep]";

export function surfaceMountNode(surfaceId: string): HTMLElement {
  let node = nodes.get(surfaceId);
  if (!node) {
    node = document.createElement("div");
    node.className = "wb-surface-mount";
    node.dataset.surfaceMount = surfaceId;
    nodes.set(surfaceId, node);
  }
  return node;
}

export function hasSurfaceMountNode(surfaceId: string): boolean {
  return nodes.has(surfaceId);
}

/** Drop the node once its surface is no longer kept alive (unmounted). */
export function releaseSurfaceMountNode(surfaceId: string): void {
  const node = nodes.get(surfaceId);
  if (!node) return;
  node.remove();
  nodes.delete(surfaceId);
  lastFocus.delete(surfaceId);
}

/** Remember focus and scroll offsets right before a node leaves its host. */
export function rememberSurfaceState(surfaceId: string): void {
  const node = nodes.get(surfaceId);
  if (!node || typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && node.contains(active)) lastFocus.set(surfaceId, active);
  else lastFocus.delete(surfaceId);
  const offsets: Array<[Element, number, number]> = [];
  // Page content scrolls on the stable mount itself; querySelectorAll excludes it.
  for (const el of [node, ...node.querySelectorAll(SCROLL_KEEPERS)]) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) offsets.push([el, el.scrollTop, el.scrollLeft]);
  }
  scrollMemory.set(node, offsets);
}

/** Re-apply what `rememberSurfaceState` captured after the node was adopted. */
export function restoreSurfaceState(surfaceId: string): void {
  const node = nodes.get(surfaceId);
  if (!node) return;
  for (const [el, top, left] of scrollMemory.get(node) ?? []) {
    if (el.isConnected) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
  scrollMemory.delete(node);
  const focus = lastFocus.get(surfaceId);
  lastFocus.delete(surfaceId);
  if (focus && focus.isConnected && node.contains(focus) && !focus.closest("[inert]")) {
    focus.focus({ preventScroll: true });
  }
}

/** Move a surface's node under `host` (no-op when already there). */
export function adoptSurfaceNode(surfaceId: string, host: HTMLElement): void {
  const node = surfaceMountNode(surfaceId);
  if (node.parentElement === host) return;
  rememberSurfaceState(surfaceId);
  host.appendChild(node);
  restoreSurfaceState(surfaceId);
}

/** Test seam. */
export function resetSurfaceMountsForTest(): void {
  for (const node of nodes.values()) node.remove();
  nodes.clear();
  lastFocus.clear();
}
