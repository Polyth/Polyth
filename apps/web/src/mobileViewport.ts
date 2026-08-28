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
//   --visual-bottom   visible viewport's lower edge in layout coordinates;
//                     use for a full app frame when Safari pans the page
//                     instead of resizing it for the keyboard
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

/** Safari can pan the visual viewport for a focused editor instead of adding a
 * layout inset. The viewport reduction still means the keyboard is visible. */
export function keyboardOpenFrom(
  layoutHeight: number,
  visualHeight: number,
  offsetTop: number,
  textEntryFocused: boolean,
): boolean {
  return keyboardInsetFrom(layoutHeight, visualHeight, offsetTop) > 0
    || (textEntryFocused && layoutHeight - visualHeight >= KEYBOARD_MIN_INSET);
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
    covering: keyboardOpenFrom(layoutHeight, visualHeight, offsetTop, false),
  };
}

const INITIAL: ViewportMetrics = { height: 0, keyboardInset: 0, offsetTop: 0, covering: false };
const TEXT_ENTRY = "input, textarea, [contenteditable=\"true\"]";

let metrics: ViewportMetrics = INITIAL;
let started = false;
let nativeKeyboardInset = 0;
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
  // On iOS Safari the keyboard can pan the visual viewport down while leaving
  // the layout viewport full-height. A flow-layout app whose height is only
  // `visualViewport.height` then ends hundreds of pixels ABOVE the keyboard.
  // Its bottom must instead follow the visible viewport's bottom edge.
  root.style.setProperty("--visual-bottom", `${next.height + next.offsetTop}px`);
  root.style.setProperty("--keyboard-inset", `${next.keyboardInset}px`);
  root.style.setProperty("--visual-offset", `${next.offsetTop}px`);
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
    const next = metricsFrom(
      layoutHeight,
      visual.height ?? layoutHeight,
      visual.offsetTop ?? 0,
    );
    const measuredCovering = keyboardOpenFrom(
      layoutHeight,
      visual.height ?? layoutHeight,
      visual.offsetTop ?? 0,
      document.activeElement?.matches?.(TEXT_ENTRY) ?? false,
    );
    // Capacitor's native-resize mode can make innerHeight equal the already
    // reduced WebView height, hiding the covered amount from visualViewport.
    // Its keyboard plugin supplies that missing inset; web remains geometry-only.
    next.keyboardInset = Math.max(next.keyboardInset, nativeKeyboardInset);
    next.covering = measuredCovering || nativeKeyboardInset >= KEYBOARD_MIN_INSET;
    publish(next);
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
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  const visual = window.visualViewport;
  visual?.addEventListener("resize", onChange);
  visual?.addEventListener("scroll", onChange);
}

/** Native shell seam: map Capacitor's keyboard height onto the same CSS
 * contract used by mobile browsers. Passing zero returns ownership to
 * visualViewport measurement. */
export function setNativeKeyboardInset(height: number): void {
  nativeKeyboardInset = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
  measure();
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
