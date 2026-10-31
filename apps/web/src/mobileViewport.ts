// The single seam for visual-viewport geometry on phones.
//
// The interaction frame has two states. While the keyboard is closed it must
// cover the LAYOUT viewport (the `100vh` box); while the keyboard is open it
// must shrink to the VISUAL viewport. `window.innerHeight` is not the layout
// height on iOS WebKit: it reports the visual band, so browser chrome and the
// installed-PWA home-indicator band silently end the frame above the screen
// and leave a strip below `.app`. The layout viewport is measured from
// `document.documentElement.clientHeight`; every sticky surface (composer,
// sheets, pickers) positions against the visual viewport. This module measures
// both once per frame-ish event and publishes the result as CSS custom
// properties, so CSS never has to guess.
//
// Published on <html>:
//   --visual-vh       visible height in CSS px (use instead of 100vh/100dvh
//                     when the keyboard must not push content offscreen)
//   --visual-bottom   the mobile chain's frame height: the frame's lower edge
//                     in layout coordinates (pan offset + visible height), so
//                     the app covers the band Safari pans to while the
//                     keyboard is open
//   --visual-frame-top    top of the interaction frame in layout coordinates
//   --visual-frame-height height of the interaction frame
//   --keyboard-inset  height hidden behind the keyboard, 0 when closed
//   --visual-offset   compatibility alias of --visual-frame-top (sheets and
//                     dialogs): the pan offset while the keyboard is open, 0
//                     while it is closed
//   --layer-frame-bottom  the lower edge the app chain and every full-height
//                     layer end on: --visual-frame-bottom, plus WebKit's
//                     form-accessory band while the keyboard is open in a
//                     compact Safari frame
// and data-keyboard-frame="open" | "closed" (the frame those describe).
// Published on <body>: data-keyboard="open" | "closed", and
//   data-keyboard-source="native" while a native shell's keyboard plugin
//   supplies the inset (its WebView already ends at the keyboard), otherwise
//   "viewport"; data-band="short" | "tall".
//
// Cost model (measured, docs/dev/mobile-viewport.md "Restyle cost"): any
// style change of <html> or <body> — an inline write, a custom property, an
// attribute a rule with html/body as its subject reacts to — restyles every
// element of the app, because those two hold the theme's custom properties.
// So the cheap keyboard STATE (body attributes only descendants react to) and
// the expensive FRAME (the variables above) are published separately: while
// a native keyboard is being ridden (keyboardRide.ts) the state follows the
// keyboard at once and the frame waits until the keyboard has landed.
//
// No persistence, no user-agent sniffing, no device categories: geometry only.
import { useSyncExternalStore } from "react";
import { revealFieldInScrollers } from "./mobileFieldReveal.ts";
import { keyboardMotion, motionIsReduced } from "./motionPresence.ts";
import { keyboardMoveElapsedMs, recordNativeKeyboardMotion, syncKeyboardRiders, type NativeKeyboardMotion } from "./keyboardMotion.ts";
import { captureRide, focusRidesKeyboard, primeKeyboardRide, retimeKeyboardRide, rideKeyboard, type RideSnapshot } from "./keyboardRide.ts";

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
  nativeInset = 0,
): ViewportMetrics {
  const normalizedNativeInset = Number.isFinite(nativeInset) ? Math.max(0, Math.round(nativeInset)) : 0;
  return {
    height: Math.round(visualHeight),
    keyboardInset: Math.max(keyboardInsetFrom(layoutHeight, visualHeight, offsetTop), normalizedNativeInset),
    offsetTop: Math.round(offsetTop),
    covering: keyboardOpenFrom(layoutHeight, visualHeight, offsetTop, false)
      || normalizedNativeInset >= KEYBOARD_MIN_INSET,
  };
}

const INITIAL: ViewportMetrics = { height: 0, keyboardInset: 0, offsetTop: 0, covering: false };
const TEXT_ENTRY = "input, textarea, [contenteditable=\"true\"]";

let metrics: ViewportMetrics = INITIAL;
let started = false;
// The keyboard height the native shell last reported (where the keyboard is
// going) and the one the published frame reflects. They differ only while a
// keyboard that covers more is being ridden: the frame commits on landing.
let nativeKeyboardInset = 0;
let frameNativeInset = 0;
// iOS (KeyboardResize.Native) resizes its WebView only once the keyboard has
// finished sliding, plus 0.2 s: until then the frame is still full height and
// the docked composer sits behind the rising keyboard. A shell that says so
// lets the frame take the keyboard's final geometry from the plugin event.
let followNativeKeyboard = false;
// The keyboard-closed layout the native inset is subtracted from (largest seen
// at this width, so a measurement taken mid-resize can never shrink it).
let closedLayout: { height: number; width: number } | null = null;
// A closing native keyboard hands the frame back at once, but the plugin
// grows its WebView a moment later: until then the closed frame is projected
// from the keyboard-closed layout, as the open one is.
let closedProjectionUntil = 0;
const CLOSED_PROJECTION_MS = 1000;
// The last opening keyboard was ridden by a dock, so its closing is too.
let ridingDock = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** Every value the frame variables were last written from: a value left out of
 *  the comparison is never rewritten while the others hold still. */
let publishedFrame: { top: number; height: number; bottom: number; vh: number; inset: number } | null = null;
let publishedSource: "native" | "viewport" | null = null;
let publishedBand: "short" | "tall" | null = null;
const listeners = new Set<() => void>();
// "Periodic jump": Safari dispatches the keyboard resize
// (shrinks visualViewport.height) and the pan that reveals a focused
// composer above it (moves visualViewport.offsetTop) as separate events. A
// shrink published from the resize alone, before its paired offset arrives,
// undershoots --visual-frame-bottom and briefly exposes the canvas below the
// composer. See the settle gate in publish() below.
let frameSettlePending = false;
let settlingFrame = false;
let fieldRevealPending = false;

/** Run `callback` on the next frame; engines without rAF (fake DOMs) take a timer. */
function requestFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
  else setTimeout(callback, 16);
}

export function getViewportMetrics(): ViewportMetrics {
  return metrics;
}

/** Subscribe to viewport geometry changes without requiring a React render. */
export function subscribeViewport(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** WebKit keeps its floating form assistant inside the keyboard frame it
 *  reports, so a compact Safari frame is extended by its height while the
 *  keyboard is open (tokens.css `--keyboard-accessory-band`). Never in a
 *  native shell, whose plugin hides the accessory and ends its WebView at the
 *  keyboard. Read once: it is a constant token, and reading <html> styles is
 *  only cheap while nothing is pending on it. */
let accessoryBandPx: number | null = null;
const COMPACT_FRAME_QUERY = "(max-width: 1024px), (max-height: 480px) and (pointer: coarse)";

function accessoryBand(covering: boolean, native: boolean): number {
  if (!covering || native || typeof document === "undefined") return 0;
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function" || !CSS.supports("-webkit-touch-callout", "none")) return 0;
  if (typeof window.matchMedia === "function" && !window.matchMedia(COMPACT_FRAME_QUERY).matches) return 0;
  if (document.body?.classList.contains("desktop-app")) return 0;
  if (accessoryBandPx === null) {
    const token = typeof getComputedStyle === "function"
      ? Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--keyboard-accessory-band"))
      : Number.NaN;
    accessoryBandPx = Number.isFinite(token) ? Math.max(0, token) : 48;
  }
  return accessoryBandPx;
}

/**
 * `state` is where the keyboard is (or is going): the body attributes and the
 * metrics React reads. `frame` is what the published frame variables
 * describe. They are the same measurement except while a native keyboard is
 * ridden, when the frame still describes the layout the ride started from.
 */
function publish(
  state: ViewportMetrics,
  frame: ViewportMetrics,
  layoutHeight: number,
  textEntryFocused: boolean,
  projected = false,
): void {
  // A small closed-state visual reduction is browser chrome, not a covered
  // layout viewport. Keep the interaction frame at the layout bottom so a
  // 50–95px chrome delta cannot become a persistent strip below `.app`.
  // When the keyboard covers the layout, the frame starts at the visual
  // viewport's pan offset and is `visualViewport.height` tall. The mobile
  // chain consumes `--visual-frame-bottom` (pan + height), so the app covers
  // the panned band Safari shows while revealing the composer; consuming the
  // height alone left the panned remainder painting the canvas. The offset is
  // `visualViewport.offsetTop`, never the document-level
  // `visualViewport.pageTop`/`window.scrollY`: a document pan would grow the
  // box past the layout viewport and create a scroll range again.
  const frameTop = frame.covering ? Math.max(0, frame.offsetTop) : 0;
  const frameHeight = frame.covering
    ? Math.max(0, frame.height)
    : Math.max(0, Math.round(layoutHeight));
  const frameBottom = frameTop + frameHeight;
  // The Capacitor shell (KeyboardResize.Native) shrinks its WebView to end at
  // the keyboard and hides WebKit's form accessory, so the WebKit accessory
  // band added to a Safari frame must not apply there: it pushed the composer
  // under the keyboard by exactly that band.
  const frameNative = frame.covering && frameNativeInset >= KEYBOARD_MIN_INSET;
  const layerBottom = frameBottom + accessoryBand(frame.covering, frameNative);
  const source = state.covering && nativeKeyboardInset >= KEYBOARD_MIN_INSET ? "native" : "viewport";
  const band = state.height > 0 && state.height < SHORT_VISUAL_BAND ? "short" : "tall";
  const metricsEqual =
    state.height === metrics.height
    && state.keyboardInset === metrics.keyboardInset
    && state.offsetTop === metrics.offsetTop
    && state.covering === metrics.covering;
  const frameEqual = publishedFrame?.top === frameTop
    && publishedFrame.height === frameHeight
    && publishedFrame.bottom === layerBottom
    && publishedFrame.vh === frame.height
    && publishedFrame.inset === frame.keyboardInset
    && frameCovering === frame.covering;
  if (metricsEqual && frameEqual && publishedSource === source && publishedBand === band) return;
  // A frame that GROWS is always safe to publish immediately: more coverage
  // never exposes the canvas. A frame that SHRINKS while a text entry is
  // focused is the one case Safari's pan-to-reveal can still be mid-flight
  // for (§ above) — the resize event alone reports the new, smaller
  // `visualViewport.height` with `offsetTop` still at its pre-pan value, so
  // `frameBottom` undershoots where the pan is about to land. Hold that
  // shrink for up to two frames (the same "let geometry settle" idiom
  // dismissKeyboard() already uses below) so the paired offset update, if one
  // is coming, is folded into the same publish instead of painting one frame
  // too high first. `settlingFrame` forces the retry through even if nothing
  // new ever arrives, so an engine that only resizes (no focused input, no
  // pan — mobileViewportResume.test.ts) still applies its shrink immediately.
  const shrinking = publishedFrame !== null && frameBottom < publishedFrame.top + publishedFrame.height;
  // A projected native frame is the keyboard's final geometry, not half of a
  // Safari resize/pan pair: nothing else is coming, so it is never held.
  if (!settlingFrame && !projected && frame.covering && textEntryFocused && shrinking) {
    scheduleFrameSettle();
    return;
  }
  metrics = state;
  publishedSource = source;
  publishedBand = band;
  if (!frameEqual) {
    // One batch, and only when the frame really moved: every write here
    // restyles the whole app (see the cost model at the top).
    publishedFrame = { top: frameTop, height: frameHeight, bottom: layerBottom, vh: frame.height, inset: frame.keyboardInset };
    frameCovering = frame.covering;
    const root = document.documentElement;
    root.style.setProperty("--visual-vh", `${frame.height}px`);
    root.style.setProperty("--visual-frame-top", `${frameTop}px`);
    root.style.setProperty("--visual-frame-height", `${frameHeight}px`);
    root.style.setProperty("--visual-frame-bottom", `${frameBottom}px`);
    root.style.setProperty("--visual-bottom", `${frameBottom}px`);
    root.style.setProperty("--layer-frame-bottom", `${layerBottom}px`);
    root.style.setProperty("--keyboard-inset", `${frame.keyboardInset}px`);
    // The band's top, as --visual-frame-top: a pan offset only places the
    // band while the keyboard covers the layout. iOS can report a closing
    // keyboard's full height before its pan has returned, and that leftover
    // offset held every sheet and dialog a keyboard height down the screen.
    root.style.setProperty("--visual-offset", `${frameTop}px`);
    root.dataset.keyboardFrame = frame.covering ? "open" : "closed";
  }
  // The state is cheap: only descendants of <body> react to these.
  if (document.body) {
    syncData(document.body, "keyboard", state.covering ? "open" : "closed");
    syncData(document.body, "keyboardSource", source);
    syncData(document.body, "band", band);
  }
  // Layers fill this frame now, so a focused field may have fallen out of its
  // scroll container; Safari's own pan reveal already ran before this shrink.
  if (!frameEqual && frame.covering && textEntryFocused) scheduleFieldReveal();
  if (metricsEqual) return;
  for (const listener of [...listeners]) listener();
}

let frameCovering: boolean | null = null;

/** An unchanged attribute write still queues style invalidation work. */
function syncData(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

/** Bring the focused field back into view once layout has applied the frame.
 *  Coalesced: a pan animation delivers a burst of events and needs one pass. */
function scheduleFieldReveal(): void {
  if (fieldRevealPending) return;
  fieldRevealPending = true;
  requestFrame(() => {
    fieldRevealPending = false;
    const active = document.activeElement;
    if (active?.matches?.(TEXT_ENTRY)) revealFieldInScrollers(active);
  });
}

/** The closed-state interaction frame must cover the layout viewport, not the
 *  visual band iOS WebKit reports as `window.innerHeight`. `clientHeight` is
 *  the layout viewport (the `100vh` box): it stays stable while browser
 *  toolbars move and the document stays exactly as tall as its containing
 *  block, so no scroll range can appear while the keyboard is closed. */
function layoutViewportHeight(innerHeight: number): number {
  const root = typeof document === "undefined" ? null : document.documentElement;
  const layout = root && Number.isFinite(root.clientHeight) ? root.clientHeight : 0;
  return Math.max(layout, Number.isFinite(innerHeight) ? innerHeight : 0);
}

let largeViewportProbe: HTMLElement | null = null;

/** `100vh` is the large viewport, the only box that covers the physical screen
 *  when WebKit lets `innerHeight`/`clientHeight` stop above the Home-indicator
 *  canvas. It is never used as the frame itself on engines where it can exceed
 *  the WebView (Android Chrome); measuring it in a detached, off-flow probe
 *  only keeps the keyboard gap honest when an engine shrinks every reported
 *  viewport. Returns 0 when a probe cannot be created (SSR, fake DOM). */
function largeViewportHeight(): number {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return 0;
  const body = document.body;
  if (!body || typeof body.appendChild !== "function") return 0;
  if (!largeViewportProbe || !largeViewportProbe.isConnected) {
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;top:0;left:-9999px;width:0;height:100vh;visibility:hidden;pointer-events:none";
    body.appendChild(probe);
    largeViewportProbe = probe;
  }
  return largeViewportProbe.offsetHeight;
}

function measure(): void {
  if (typeof window === "undefined") return;
  const visual = window.visualViewport;
  const publishNow = () => {
    // Embedded WebViews may not expose visualViewport. Native keyboard events
    // still use this seam, so retain layout geometry as the browser fallback
    // instead of dropping the native inset on the floor.
    const layoutHeight = layoutViewportHeight(window.innerHeight || visual?.height || 0);
    // Keyboard detection compares against the largest box this engine can
    // paint. The frame itself keeps using the measured layout height so 100vh
    // can never outgrow a WebView that does not include browser chrome.
    const layoutReference = Math.max(layoutHeight, largeViewportHeight());
    const visualHeight = visual?.height ?? layoutHeight;
    const offsetTop = visual?.offsetTop ?? 0;
    const textEntryFocused = document.activeElement?.matches?.(TEXT_ENTRY) ?? false;
    const measuredCovering = keyboardOpenFrom(
      layoutReference,
      visualHeight,
      offsetTop,
      textEntryFocused,
    );
    const width = viewportWidth();
    const metricsFor = (inset: number) => {
      const next = metricsFrom(layoutReference, visualHeight, offsetTop, inset);
      // Capacitor's native-resize mode can make innerHeight equal the already
      // reduced WebView height, hiding the covered amount from visualViewport.
      // Its keyboard plugin supplies that missing inset; web remains geometry-only.
      next.covering = measuredCovering || inset >= KEYBOARD_MIN_INSET;
      const projected = projectedNativeHeight(layoutHeight, visualHeight, width, inset);
      if (projected !== null) next.height = projected;
      return { next, projected };
    };
    const state = metricsFor(nativeKeyboardInset);
    if (nativeKeyboardInset === 0 && !state.next.covering && state.projected === null) {
      closedLayout = closedLayout && closedLayout.width === width
        ? { width, height: Math.max(closedLayout.height, layoutHeight) }
        : { width, height: layoutHeight };
    }
    const frame = frameNativeInset === nativeKeyboardInset ? state : metricsFor(frameNativeInset);
    // A closing keyboard's frame is the closed layout the WebView is about to
    // grow back to; the frame of an open keyboard is its own visible height.
    const frameLayoutHeight = !frame.next.covering && frame.projected !== null ? frame.projected : layoutHeight;
    publish(state.next, frame.next, frameLayoutHeight, textEntryFocused, frame.projected !== null);
  };
  // Keyboard resize and visual-viewport scroll fire as separate events on
  // Safari. Publishing each immediately keeps the dock at the visible edge —
  // except a shrink while a text entry is focused, which publish() itself
  // holds for a couple of frames in case the paired pan offset is still
  // in flight (see the settle gate there).
  publishNow();
}

function viewportWidth(): number {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  return Number.isFinite(width) ? Math.round(width) : 0;
}

/** The visible height a pending native resize is about to leave: the
 *  keyboard-closed layout minus the plugin's keyboard height, while the
 *  WebView still has its closed size; or, for a keyboard that just closed,
 *  the closed layout itself while the WebView still has the keyboard's size.
 *  Once the shell has resized it, the measurement itself is the truth again.
 *  Null when nothing is projected. */
function projectedNativeHeight(layoutHeight: number, visualHeight: number, width: number, inset: number): number | null {
  if (!followNativeKeyboard || !closedLayout || closedLayout.width !== width) return null;
  if (inset >= KEYBOARD_MIN_INSET) {
    if (Math.abs(layoutHeight - closedLayout.height) > 2) return null;
    const projected = Math.round(closedLayout.height - inset);
    return projected > 0 && projected < Math.round(visualHeight) ? projected : null;
  }
  if (inset !== 0 || closedProjectionUntil === 0) return null;
  if (now() > closedProjectionUntil || layoutHeight >= closedLayout.height - 2) {
    closedProjectionUntil = 0;
    return null;
  }
  return Math.round(closedLayout.height);
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Retry a held-back shrink once Safari's paired pan offset (or its absence)
 *  has had two frames to show up, per publish()'s settle gate above. */
function scheduleFrameSettle(): void {
  if (frameSettlePending) return;
  frameSettlePending = true;
  requestFrame(() => requestFrame(() => {
    frameSettlePending = false;
    settlingFrame = true;
    measure();
    settlingFrame = false;
  }));
}

/**
 * Short-viewport conditions the shell styles by, as `body[data-viewport-short]`
 * tokens (styles.css "Short viewports"). They are media queries — the same
 * conditions, the same moment — but a height media query in a stylesheet
 * flips whenever a keyboard resizes the viewport, and every flip makes the
 * engine rebuild its rule sets (fonts, keyframes, registered properties) and
 * lay out every box again: 358 ms of layout per keyboard move on the test
 * machine, 6 ms without. Evaluated here, a flip restyles only what it styles.
 */
export const SHORT_VIEWPORT_QUERIES: Readonly<Record<string, string>> = {
  "560": "(max-height: 560px)",
  "560-compact": "(max-height: 560px) and (max-width: 480px), (max-height: 480px) and (pointer: coarse)",
};

function watchShortViewport(): void {
  if (typeof window.matchMedia !== "function") return;
  const lists = Object.entries(SHORT_VIEWPORT_QUERIES).map(([token, query]) => [token, window.matchMedia(query)] as const);
  const publishShort = () => {
    if (!document.body) return;
    syncData(document.body, "viewportShort", lists.filter(([, list]) => list.matches).map(([token]) => token).join(" "));
  };
  for (const [, list] of lists) list.addEventListener?.("change", publishShort);
  publishShort();
}

/**
 * Install the measurement listeners. Idempotent; safe to call before the
 * first paint and in environments without visualViewport (it falls back to
 * layout geometry and accepts a native keyboard inset when one is available).
 */
export function startMobileViewport(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  watchShortViewport();
  measure();
  const onChange = () => {
    if (!settleOnResize()) measure();
  };
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  // A restored/frozen PWA can resume with different viewport geometry without
  // delivering a resize event. Refresh the same measurement seam instead of
  // retaining a keyboard-sized frame or a stale Safari pan offset.
  window.addEventListener("pageshow", onChange);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onChange();
  });
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  const visual = window.visualViewport;
  visual?.addEventListener("resize", onChange);
  visual?.addEventListener("scroll", onChange);
  document.addEventListener("pointerdown", noteKeyboardTap, true);
  document.addEventListener("mousedown", holdKeyboardOnTap, true);
  // A touch on (or focus into) a docked composer is the keyboard's warning:
  // its riders become compositor layers before the keyboard sets off.
  const coarse = typeof window.matchMedia === "function" ? window.matchMedia("(any-pointer: coarse)") : null;
  const prime = (event: Event) => { if (coarse?.matches) primeKeyboardRide(event.target); };
  document.addEventListener("pointerdown", prime, true);
  document.addEventListener("focusin", prime, true);
}

// Writing surfaces opt in with `data-keep-keyboard` (the composer). A touch or
// pen tap on such a surface, or on an anchored popover it opened, leaves its
// focused editor focused so the software keyboard stays open: the tap's
// compatibility mousedown (what moves focus and dismisses the keyboard) is
// cancelled while the click still dispatches, and overlay focus moves (first
// item, initial focus, return to the trigger, dismissKeyboard) yield to the
// held editor. Text fields still take focus; mouse and keyboard focus are
// unchanged. Sheets and dialogs are not covered and keep their own focus.
export const KEEP_KEYBOARD_ATTRIBUTE = "data-keep-keyboard";
const KEEP_KEYBOARD_SURFACE = `[${KEEP_KEYBOARD_ATTRIBUTE}]`;
const KEEP_KEYBOARD_TAP_TARGET = `${KEEP_KEYBOARD_SURFACE}, .ui-popover, .ui-popover-backdrop`;
const FOCUS_TAKING_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
let keyboardTap = false;

function noteKeyboardTap(event: PointerEvent): void {
  const target = event.target as Element | null;
  keyboardTap = (event.pointerType === "touch" || event.pointerType === "pen")
    && !!target?.closest?.(KEEP_KEYBOARD_TAP_TARGET);
}

function holdKeyboardOnTap(event: MouseEvent): void {
  if (!heldKeyboardEntry()) return;
  const target = event.target as Element | null;
  if (!target?.closest || target.closest(FOCUS_TAKING_ENTRY)) return;
  event.preventDefault();
}

/** The editor whose software keyboard the current touch interaction keeps
 *  open, or null when focus is free to move. */
export function heldKeyboardEntry(): HTMLElement | null {
  if (!keyboardTap || typeof document === "undefined") return null;
  const active = document.activeElement as HTMLElement | null;
  if (!active?.matches?.(FOCUS_TAKING_ENTRY) || !active.closest(KEEP_KEYBOARD_SURFACE)) return null;
  return active;
}

/** Overlay focus moves (first item, initial focus, return to the trigger)
 *  that would otherwise steal focus from a held editor. */
export function focusUnlessKeyboardHeld(target: HTMLElement | null | undefined): void {
  if (!heldKeyboardEntry()) target?.focus();
}

export interface NativeKeyboardOptions {
  /** The shell resizes its WebView only after the keyboard has moved (the iOS
   *  plugin waits for the slide plus 0.2 s). The page then follows the
   *  keyboard itself: a composer dock (and the transcript at its tail) rides
   *  the keyboard on the compositor (keyboardRide.ts) and the frame takes the
   *  keyboard's geometry once it has landed, so the composer travels with the
   *  keyboard instead of vanishing behind it until the resize lands. */
  followKeyboard?: boolean;
}

/** The plugin's WebView resize lands this long after a keyboard sets off
 *  (nominal 0.25 s + 0.2 s); the frame commits then, or at the latest here. */
const NATIVE_RESIZE_WAIT_MS = 700;
const SETTLE_TAIL_MS = 80;

function cancelSettle(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
}

function scheduleSettle(): void {
  cancelSettle();
  settleTimer = setTimeout(settleRide, Math.max(keyboardMotion().duration + SETTLE_TAIL_MS, NATIVE_RESIZE_WAIT_MS));
}

/** The ridden keyboard has landed: commit its frame (the one restyle of the
 *  whole move, now that nothing is moving) and glide away any residual
 *  between where the riders ended and where the layout put them. */
function settleRide(): void {
  cancelSettle();
  if (frameNativeInset === nativeKeyboardInset) return;
  const snapshot = captureRide();
  frameNativeInset = nativeKeyboardInset;
  // The landing is the keyboard's final geometry, never half of a Safari
  // resize/pan pair: publish() must not hold it back. Held for two frames
  // (a focused editor and a shrinking frame, after the WebView resize), the
  // residual below read the old layout and glided the composer down toward
  // it, and the frame then landed under the glide: a ~290px jump.
  settlingFrame = true;
  try {
    measure();
  } finally {
    settlingFrame = false;
  }
  rideKeyboard(snapshot, { dockOffset: 0, mode: "residual" });
}

/** The WebView took the ridden keyboard's size: that is the landing. */
function settleOnResize(): boolean {
  if (!settleTimer || frameNativeInset >= nativeKeyboardInset || !closedLayout || typeof window === "undefined") return false;
  const layoutHeight = layoutViewportHeight(window.innerHeight || window.visualViewport?.height || 0);
  if (layoutHeight > closedLayout.height - nativeKeyboardInset + 2) return false;
  settleRide();
  return true;
}

/** Native shell seam: map Capacitor's keyboard height onto the same CSS
 * contract used by mobile browsers. Passing zero returns ownership to
 * visualViewport measurement. */
export function setNativeKeyboardInset(height: number, options: NativeKeyboardOptions = {}): void {
  const next = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
  const moved = next !== nativeKeyboardInset;
  nativeKeyboardInset = next;
  followNativeKeyboard = options.followKeyboard === true;
  if (!moved) {
    measure();
    return;
  }
  // Only a keyboard serving a docked composer is ridden; any other field
  // (Settings, the navigator search, a module layer) takes the band at once.
  const opening = next > frameNativeInset;
  const ride = followNativeKeyboard && !motionIsReduced()
    && (opening ? focusRidesKeyboard() : ridingDock);
  ridingDock = ride && next > 0;
  let snapshot: RideSnapshot | null = null;
  if (ride) snapshot = captureRide();
  if (opening && snapshot) {
    // Covering more: ride now, commit the frame once the keyboard has landed.
    scheduleSettle();
  } else {
    // Covering less (or not ridden): the frame takes it now.
    cancelSettle();
    frameNativeInset = next;
    closedProjectionUntil = followNativeKeyboard && next === 0 ? now() + CLOSED_PROJECTION_MS : 0;
  }
  measure();
  if (snapshot) {
    rideKeyboard(snapshot, {
      dockOffset: -(nativeKeyboardInset - frameNativeInset),
      mode: "keyboard",
      // An opening ride starts from the frame the keyboard is already on;
      // a closing glide starts after this commit's restyle, from where the
      // composer was — trailing the keyboard reads smoother than a jump.
      elapsedMs: opening ? () => keyboardMoveElapsedMs() : undefined,
      afterCommit: !opening,
    });
  }
  // The composer morph and the editor cap catch up with a moving keyboard —
  // again on the next frame for riders React starts only after this event
  // (the editor cap follows the band the Composer re-renders with).
  if (followNativeKeyboard) {
    syncKeyboardRiders();
    requestFrame(() => syncKeyboardRiders());
  }
}

/** Native shell seam: the keyboard's real slide for the move being reported
 *  (keyboardMotion.ts). It may arrive just before or just after the inset;
 *  either way the riders and the composer end up on the keyboard's own curve. */
export function setNativeKeyboardMotion(motion: NativeKeyboardMotion): void {
  recordNativeKeyboardMotion(motion);
  retimeKeyboardRide(() => keyboardMoveElapsedMs());
  // A longer real slide keeps the frame waiting until it has landed.
  if (settleTimer) scheduleSettle();
  syncKeyboardRiders();
}

export function useViewportMetrics(): ViewportMetrics {
  return useSyncExternalStore(
    subscribeViewport,
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
 * A keep-keyboard surface (the composer) holding the keyboard for the current
 * tap is left alone: its pickers open against the keyboard-open viewport.
 */
export function dismissKeyboard(): Promise<void> {
  if (typeof document === "undefined" || heldKeyboardEntry()) return Promise.resolve();
  const active = document.activeElement as HTMLElement | null;
  if (active && active.matches?.(TEXT_ENTRY)) active.blur();
  const current = getViewportMetrics();
  if (current.keyboardInset === 0 && !current.covering) return Promise.resolve();
  return new Promise((resolve) => {
    requestFrame(() => requestFrame(() => resolve()));
  });
}
