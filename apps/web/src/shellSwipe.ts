// Phone shell swipes: which surface a swipe may open, and the transient
// "peek" that mounts it while a finger pulls it in.
//
//   Chat ──(finger toward the inline end)──▶ Navigator   (closes the other way)
//   Chat ──(finger toward the inline start)─▶ Workspace  (closes the other way)
//   package window ──(toward the inline end)──▶ Back     (one layer)
//
// A peek is presentation-only: the surface mounts in a non-modal, inert state
// that follows the finger (swipeSurface.ts) and either becomes the real open
// state on release or unmounts unseen. Nothing about a peek is persisted or
// model-visible.
import { useSyncExternalStore } from "react";
import type { SwipeZone } from "./mobileGestures.ts";
import { swipeGesturesAvailable } from "./swipeHost.ts";
import type { SwipeNavigationMode } from "./uiPrefs.ts";

export type SwipePeekTarget = "navigator" | "workspace";

let peek: SwipePeekTarget | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSwipePeek(): SwipePeekTarget | null {
  return peek;
}

export function setSwipePeek(next: SwipePeekTarget | null): void {
  if (next === peek) return;
  peek = next;
  for (const listener of [...listeners]) listener();
}

/** Whether `target` is mounted only because a finger is pulling it in. */
export function useSwipePeek(target: SwipePeekTarget): boolean {
  return useSyncExternalStore(subscribe, () => peek === target, () => false);
}

/** The start zone a swipe uses under the user's setting (`null` = swipes are off). */
export function swipeZoneFor(mode: SwipeNavigationMode): SwipeZone | null {
  return mode === "off" ? null : mode;
}

/**
 * The start zone a swipe actually uses in this host: the user's setting, except
 * that in a phone browser the browser owns the edge gesture, so Polyth stands
 * down (`null`). Every shell/Back/drawer/Settings swipe reads this, so the
 * whole navigation layer switches off together in a browser and stays on in
 * the installed app.
 */
export function swipeZoneInHost(mode: SwipeNavigationMode): SwipeZone | null {
  if (!swipeGesturesAvailable()) return null;
  return swipeZoneFor(mode);
}

/** The slice of shell state that decides whether Chat is the top layer. */
export interface ChatBaseState {
  phone: boolean;
  sidebarOpen: boolean;
  workspaceOpen: boolean;
  packagePresented: boolean;
  overlay: boolean;
  /** A modal surface, sheet, menu or dialog is open somewhere. */
  transientOpen: boolean;
}

/**
 * Chat swipes open the Navigator or the Workspace only while Chat itself is
 * the top layer: anything above it owns its own gestures (and its own Back).
 */
export function chatSwipeAllowed(state: ChatBaseState): boolean {
  return state.phone
    && !state.sidebarOpen
    && !state.workspaceOpen
    && !state.packagePresented
    && !state.overlay
    && !state.transientOpen;
}

/** Whether anything transient (modal, sheet, menu, dialog) is open in `doc`. */
export function transientSurfaceOpen(doc: Document): boolean {
  const root = doc.documentElement;
  if (root.dataset.modalSurface === "open" || root.dataset.sheet === "open") return true;
  // Keep-alive surfaces stay in the DOM hidden or inert; only a shown one counts.
  for (const el of doc.querySelectorAll<HTMLElement>('[role="menu"], [role="dialog"], [aria-modal="true"]')) {
    if (el.closest("[inert], [hidden]")) continue;
    if (el.getClientRects().length > 0) return true;
  }
  return false;
}
