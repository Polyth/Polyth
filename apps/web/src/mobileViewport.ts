// UX-MOBILE-01: the single seam for visual-viewport geometry on phones.
//
// Layout viewport height (100vh / innerHeight) is a lie while the on-screen
// keyboard is open: the browser keeps reporting the full page box and the
// keyboard simply covers the bottom of it. Every sticky surface (composer,
// sheets, pickers) therefore positions against the VISUAL viewport instead:
// this module measures it once per frame-ish event and publishes the result
// as CSS custom properties, so CSS never has to guess.
//
// Published on <html>:
//   --visual-vh       visible height in CSS px (use instead of 100vh/100dvh
//                     when the keyboard must not push content offscreen)
//   --keyboard-inset  height hidden behind the keyboard, 0 when closed
//   --visual-offset   visual viewport top offset (page pinch/scroll)
// Published on <body>: data-keyboard="open" | "closed".
//
// No persistence, no user-agent sniffing, no device categories: geometry only.
import { useSyncExternalStore } from "react";

export interface ViewportMetrics {
  /** Visible height in CSS px (visualViewport.height, layout height as fallback). */
  height: number;
  /** Height hidden behind the on-screen keyboard, in CSS px. 0 when closed. */
  keyboardInset: number;
  /** Visual viewport top offset in CSS px. */
  offsetTop: number;
  /** True only while the keyboard is actually covering the layout viewport —
   *  i.e. the layout gap, not a visual viewport that merely sits lower in a
   *  full-height (unresized) page. */
  covering: boolean;
}

/**
 * Hidden-strip threshold. Collapsing browser chrome (Safari's toolbar) and
 * sub-pixel rounding also shrink the visual viewport by a few dozen px; only a
 * larger strip is treated as a keyboard so the composer does not twitch while
 * the user scrolls.
 */
export const KEYBOARD_MIN_INSET = 96;

/**
 * Below this visible height the band is "short": a small phone with a tall
 * keyboard, or landscape. The empty state stands down entirely there so the
 * interaction zone always fits (§43) — published as body[data-band].
 */
export const SHORT_VISUAL_BAND = 420;

/**
 * The app frame is moved by this much (negative = up). mobileViewport keeps
 * it in the --viewport-shift custom property so a transform on the frame can
 * never fight the layout for the same geometry.
 */
export function viewportShiftFrom(offsetTop: number): number {
  const shifted = Math.round(offsetTop);
  return shifted > 0 ? -shifted : 0;
}

/** Pure geometry: how much of the layout viewport the keyboard covers. */
export function keyboardInsetFrom(
  layoutHeight: number,
  visualHeight: number,
  offsetTop: number,
): number {
  const layoutGap = Math.round(layoutHeight - visualHeight - offsetTop);
  // The keyboard is covering the layout viewport exactly when it resized it.
  // A visual viewport that merely sits lower in a full-height (unresized)
  // page — iOS Safari — is not covering it, whatever the scroll offset says.
  return layoutGap >= KEYBOARD_MIN_INSET ? layoutGap : 0;
}

/** Pure projection of one measurement into the published metrics. */
export function metricsFrom(
  layoutHeight: number,
  visualHeight: number,
  offsetTop: number,
): ViewportMetrics {
  return {
    height: Math.round(visualHeight),
    keyboardInset: keyboardInsetFrom(layoutHeight, visualHeight, offsetTop),
    offsetTop: Math.round(offsetTop),
    covering: Math.round(layoutHeight - visualHeight - offsetTop) >= KEYBOARD_MIN_INSET,
  };
}

const INITIAL: ViewportMetrics = { height: 0, keyboardInset: 0, offsetTop: 0, covering: false };

let metrics: ViewportMetrics = INITIAL;
let started = false;
const listeners = new Set<() => void>();

export function getViewportMetrics(): ViewportMetrics {
  return metrics;
}

function publish(next: ViewportMetrics): void {
  if (
    next.height === metrics.height
    && next.keyboardInset === metrics.keyboardInset
    && next.offsetTop === metrics.offsetTop
    && next.covering === metrics.covering
  ) return;
  metrics = next;
  const root = document.documentElement;
  root.style.setProperty("--visual-vh", `${next.height}px`);
  root.style.setProperty("--keyboard-inset", `${next.keyboardInset}px`);
  root.style.setProperty("--visual-offset", `${next.offsetTop}px`);
  // The whole frame counter-shifts (not just the composer): with the layout
  // scrolled past the header, moving the dock alone would push it into the
  // header; and a transform on the dock is also what let a sheet over it
  // capture fixed positioning.
  root.style.setProperty("--viewport-shift", `${viewportShiftFrom(next.offsetTop)}px`);
  if (document.body) {
    document.body.dataset.keyboard = next.covering ? "open" : "closed";
    document.body.dataset.band = next.height > 0 && next.height < SHORT_VISUAL_BAND ? "short" : "tall";
  }
  for (const listener of [...listeners]) listener();
}

function measure(): void {
  if (typeof window === "undefined") return;
  const visual = window.visualViewport;
  if (!visual) return;
  const publishNow = () => {
    const layoutHeight = window.innerHeight || visual.height || 0;
    publish(metricsFrom(
      layoutHeight,
      visual.height ?? layoutHeight,
      visual.offsetTop ?? 0,
    ));
  };
  // Reading visualViewport synchronously after its own resize event races the
  // browser's scroll of the layout viewport; one frame later both values are
  // consistent, so the frame shift and the new band never disagree.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(publishNow);
  else publishNow();
}

/**
 * Install the measurement listeners. Idempotent; safe to call before the
 * first paint and in environments without visualViewport (it then falls back
 * to the layout viewport and reports a permanently closed keyboard).
 */
export function startMobileViewport(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  measure();
  const onChange = () => measure();
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  const visual = window.visualViewport;
  visual?.addEventListener("resize", onChange);
  visual?.addEventListener("scroll", onChange);
}

export function useViewportMetrics(): ViewportMetrics {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getViewportMetrics,
    () => INITIAL,
  );
}

/** True while the on-screen keyboard covers part of the layout viewport. */
export function useKeyboardOpen(): boolean {
  return useViewportMetrics().covering;
}

const TEXT_ENTRY = "input, textarea, [contenteditable=\"true\"]";

/**
 * Close the on-screen keyboard before opening an overlay (§22): the picker
 * must never be laid out against a viewport that is about to change under it.
 * Resolves after the browser has had two frames to settle the new geometry.
 */
export function dismissKeyboard(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const active = document.activeElement as HTMLElement | null;
  if (active && active.matches?.(TEXT_ENTRY)) active.blur();
  if (getViewportMetrics().keyboardInset === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    raf(() => raf(() => resolve()));
  });
}
