// A side safe-area strip wide enough to hold the launcher strip. iPhone Duo
// (iOS 27.1 SDK) keeps its status items, and folded its front camera, in an
// 84pt column at one side of either display and reports it as that side's
// safe inset. The tablet and phone shells hide the launcher strip, so without
// this the column stays empty; ContextRail puts the strip there instead.
// Landscape notched iPhones report at most ~62pt, so they never qualify.
// Pure geometry: no device or user-agent detection, nothing persisted.
import { useSyncExternalStore } from "react";

/** The narrowest side inset that hosts the launcher strip. */
export const SIDE_STRIP_MIN_INSET = 72;

export type SideStrip = "left" | "right";

/** Which side's safe inset hosts the strip, if any. The wider one wins. */
export function sideStripForInsets(left: number, right: number): SideStrip | null {
  if (Math.max(left, right) < SIDE_STRIP_MIN_INSET) return null;
  return right >= left ? "right" : "left";
}

// `--safe-left/right` are unregistered custom properties, so their computed
// value is the unresolved `env()` expression. A hidden fixed probe padded by
// them yields pixels, and a ResizeObserver on its content box notices an
// inset change that arrives without a resize (Android's native bridge).
let probe: HTMLElement | null = null;
const listeners = new Set<() => void>();
let current: SideStrip | null = null;
let teardown: (() => void) | null = null;

function measure(): SideStrip | null {
  if (!probe) return null;
  const style = getComputedStyle(probe);
  return sideStripForInsets(Number.parseFloat(style.paddingLeft) || 0, Number.parseFloat(style.paddingRight) || 0);
}

function refresh(): void {
  const next = measure();
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function start(): void {
  if (typeof document === "undefined" || !document.body) return;
  probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;inset:0;box-sizing:border-box;padding:0 var(--safe-right) 0 var(--safe-left);"
    + "visibility:hidden;pointer-events:none;contain:strict;z-index:-1";
  document.body.append(probe);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : null;
  observer?.observe(probe);
  window.addEventListener("resize", refresh);
  window.addEventListener("orientationchange", refresh);
  current = measure();
  teardown = () => {
    observer?.disconnect();
    window.removeEventListener("resize", refresh);
    window.removeEventListener("orientationchange", refresh);
    probe?.remove();
    probe = null;
    current = null;
  };
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardown?.();
      teardown = null;
    }
  };
}

/** The side whose safe inset hosts the launcher strip, or null. */
export function useSideSafeStrip(): SideStrip | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
