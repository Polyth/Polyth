// Direct-manipulation swipes for the phone shell. One controller owns the
// touch lifecycle of every shell gesture (Navigator, Workspace, the Back of a
// package window): it decides when a touch is a swipe, tracks the finger,
// measures the release, springs a cancelled drag home and keeps the page from
// also treating the drag as a tap, a scroll or a long-press.
//
// What moves is not its business. A claim calls `begin()`, and the returned
// session paints each frame and performs the commit (normally by publishing
// where the finger left the layer and flipping the state whose CSS animation
// carries on from there) or undoes the drag once it is home. The decisions are
// pure and live in mobileGestures.ts.
//
// Input cost: the always-on `touchstart` listener is passive, so it never holds
// up scrolling. Only a touch that may become a swipe adds the non-passive
// `touchmove`/`touchend` listeners it needs to cancel the browser's handling,
// and they go away with that touch.
import {
  EDGE_SWIPE_COMMIT_PROGRESS,
  EDGE_SWIPE_FLICK_MIN_TRAVEL,
  caughtUpTravel,
  directedTravel,
  edgeSwipeCommits,
  edgeSwipeProgress,
  isSwipeEdgeStart,
  releaseVelocity,
  scrollerTakesSwipe,
  settleDurationMs,
  stackEase,
  swipeIntent,
  type InlineDirection,
  type SwipeZone,
  type TravelSample,
} from "./mobileGestures.ts";
import { motionDurationMs, type MotionDurationToken } from "./motionPresence.ts";
import { selectionFeedback } from "./haptics.ts";

/** A subtree that owns every horizontal gesture, edge swipes included. */
export const SWIPE_OPT_OUT = "[data-no-edge-swipe]";
/**
 * A subtree that owns horizontal swipes that start inside it (a row with swipe
 * actions, a carousel, a toast that is swiped away). An empty value owns both
 * directions; `toward-end` or `toward-start` owns only that one, leaving the
 * other to the shell. A swipe from the screen edge still navigates. An owner
 * keeps the swipe from every surface around it, never from its own swipe.
 */
export const SWIPE_OWNER = "[data-owns-swipe]";

/** Whether the nearest swipe owner around `target`, inside `surface`, keeps a swipe in `direction`. */
function ownerKeeps(target: Element, surface: Element, direction: InlineDirection): boolean {
  const owner = target.closest(SWIPE_OWNER);
  if (!owner || owner === surface || owner.contains(surface)) return false;
  const owns = owner.getAttribute("data-owns-swipe");
  return !owns || owns === direction;
}
/** Content a horizontal drag edits rather than navigates. */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"]';

export interface SwipeStart {
  rtl: boolean;
  /** Distance the progress is measured against (the viewport's width, or the surface's `extent`). */
  width: number;
  /** The element the touch started on. */
  target: Element;
  /** The touch began in the edge zone. */
  edge: boolean;
}

export interface SwipeRelease {
  /** Travel at release, px along the swipe direction. */
  travel: number;
  width: number;
  /** Speed toward the destination at release, px/ms. */
  velocity: number;
  /** How long the hand-off should take to finish the travel (0 with motion off). */
  settleMs: number;
}

export interface SwipeSession {
  /** Render one frame `travel` px along the swipe (0 = where the drag began). */
  paint(travel: number, progress: number): void;
  /** The release completes the gesture. */
  commit(release: SwipeRelease): void;
  /** The drag sprang home (its last paint was at 0) or was abandoned: undo `begin`. */
  cancel(): void;
}

export interface SwipeSurfaceOptions {
  /** Touches must start inside this element. */
  surface(): HTMLElement | null;
  /** The way the finger travels to claim. */
  direction: InlineDirection;
  /** Where a swipe may start right now. */
  zone(): SwipeZone;
  /** Whether a swipe may start right now (checked at touchstart and again at the claim). */
  enabled(): boolean;
  /** Claim the touch: return the session that moves things, or null to decline. */
  begin(start: SwipeStart): SwipeSession | null;
  /** Duration token the settle and spring-home are paced by. */
  motion?: MotionDurationToken;
  /**
   * How far the layer travels to complete the gesture (default: the viewport
   * width). A drawer narrower than the screen commits and settles against its
   * own width.
   */
  extent?(): number;
}

/** Enough samples to span the 100ms velocity window at 120Hz touch rates. */
const SAMPLE_LIMIT = 16;

/** At most one shell swipe moves at a time, whichever controller claimed it. */
const claims = new WeakMap<Document, object>();

/** Whether `target` sits in content that owns horizontal movement in `direction`. */
export function contentOwnsSwipe(
  target: Element,
  surface: Element,
  direction: InlineDirection,
  win: Window,
): boolean {
  for (let node: Element | null = target; node && node !== surface; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    // A drag handle, a canvas tool or a terminal surface handles its own touches.
    if (style.touchAction === "none") return true;
    const overflow = style.overflowX;
    if ((overflow === "auto" || overflow === "scroll") && scrollerTakesSwipe(node, direction)) return true;
  }
  return false;
}

export interface HandoffValues {
  /**
   * Where the finishing animation starts (custom properties). Read by its first
   * keyframe only, so they are taken back when it ends, or after `fallbackMs`
   * when nothing animates it (motion off, element hidden).
   */
  from?: Record<string, string>;
  /**
   * What selects and paces the finishing animation (its duration, a hand-off
   * attribute). A CSS animation re-reads its timing for its whole life, even
   * finished: taking a shorter duration back would wake it at an earlier point.
   * These stay until a different animation starts on the element, or this one
   * is cancelled, or a newer hand-off replaces them.
   */
  pacing?: Record<string, string>;
  attrs?: Record<string, string>;
  /** The animation names this hand-off feeds. */
  animations: readonly string[];
  fallbackMs: number;
  /** The element those animations run on, when the values sit on an ancestor that passes them down. */
  watch?: HTMLElement;
}

const handoffs = new WeakMap<HTMLElement, () => void>();

/**
 * Publish a release position for the CSS animation that finishes a swipe's
 * travel, and take each value back at the moment it can no longer be seen.
 * Returns a release-everything function; a newer hand-off on the same element
 * calls it first.
 */
export function holdHandoff(el: HTMLElement, input: HandoffValues): () => void {
  handoffs.get(el)?.();
  const win = el.ownerDocument.defaultView ?? window;
  const from = input.from ?? {};
  const pacing = input.pacing ?? {};
  const attrs = input.attrs ?? {};
  for (const [name, value] of Object.entries(from)) el.style.setProperty(name, value);
  for (const [name, value] of Object.entries(pacing)) el.style.setProperty(name, value);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  let fromHeld = Object.keys(from).length > 0;
  let pacingHeld = Object.keys(pacing).length + Object.keys(attrs).length > 0;
  let timer = 0;
  const releaseFrom = (): void => {
    if (!fromHeld) return;
    fromHeld = false;
    for (const name of Object.keys(from)) el.style.removeProperty(name);
    win.clearTimeout(timer);
    settle();
  };
  const releasePacing = (): void => {
    if (!pacingHeld) return;
    pacingHeld = false;
    for (const name of Object.keys(pacing)) el.style.removeProperty(name);
    for (const name of Object.keys(attrs)) el.removeAttribute(name);
    settle();
  };
  const watch = input.watch ?? el;
  const own = (event: AnimationEvent): boolean => input.animations.includes(event.animationName);
  const onStart = (event: AnimationEvent): void => {
    if (event.target === watch && !own(event)) {
      releaseFrom();
      releasePacing();
    }
  };
  const onEnd = (event: AnimationEvent): void => {
    if (event.target === watch && own(event)) releaseFrom();
  };
  const onCancel = (event: AnimationEvent): void => {
    if (event.target !== watch || !own(event)) return;
    releaseFrom();
    releasePacing();
  };
  const settle = (): void => {
    if (fromHeld || pacingHeld) return;
    watch.removeEventListener("animationstart", onStart);
    watch.removeEventListener("animationend", onEnd);
    watch.removeEventListener("animationcancel", onCancel);
    if (handoffs.get(el) === release) handoffs.delete(el);
  };
  const release = (): void => {
    releaseFrom();
    releasePacing();
  };
  watch.addEventListener("animationstart", onStart);
  watch.addEventListener("animationend", onEnd);
  watch.addEventListener("animationcancel", onCancel);
  if (fromHeld) timer = win.setTimeout(releaseFrom, input.fallbackMs);
  handoffs.set(el, release);
  settle();
  return release;
}

/**
 * With motion off a released layer that is leaving has no exit to hand over
 * to: it must not spring back into view for the frame or two before it
 * unmounts. Park it where it was going; the transform is taken back shortly
 * after, invisibly (the layer is gone, or hidden as a keep-alive frame).
 */
export function parkLeavingLayer(el: HTMLElement, transform: string, ms = 160): void {
  const win = el.ownerDocument.defaultView ?? window;
  el.style.transform = transform;
  win.setTimeout(() => {
    if (el.style.transform === transform) el.style.removeProperty("transform");
  }, ms);
}

/** Whether the user is selecting text the swipe would otherwise drag across. */
function selectingText(win: Window): boolean {
  const selection = win.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

/** Attach to a document; returns the cleanup. */
export function attachSwipeSurface(options: SwipeSurfaceOptions, doc: Document = document): () => void {
  type Mode = "idle" | "tracking" | "ignored" | "dragging" | "settling";
  const owner = {};
  let mode: Mode = "idle";
  let touchId: number | null = null;
  let start = { x: 0, y: 0 };
  let startInfo: SwipeStart | null = null;
  /** Where the layer is painted, px along the swipe (what a release hands over). */
  let travel = 0;
  /** The finger's travel when the swipe claimed the touch (the gap the layer closes). */
  let claimTravel = 0;
  /** Where the layer was when this finger caught it (non-zero only for a catch mid spring-home). */
  let base = 0;
  /** This drag began by catching a layer on its way home. */
  let caught = false;
  let armed = false;
  let samples: TravelSample[] = [];
  let session: SwipeSession | null = null;
  let frame = 0;

  const root = doc.documentElement;
  const win = doc.defaultView ?? window;

  // A claimed drag is not a tap, but pointer events keep running underneath it:
  // the control the finger started on still receives a `pointerup` wherever the
  // finger lifts, and a `pointerup`-driven control (a tree row) would read that
  // as a press. Swallow the one that ends the drag before it reaches the page.
  const swallowPointerUp = (event: Event): void => {
    event.stopImmediatePropagation();
  };
  const swallowing = { capture: true, once: true } as const;
  /** `pointerup` precedes `touchend`, so by then the drag's own has been swallowed. */
  const stopSwallowing = (): void => doc.removeEventListener("pointerup", swallowPointerUp, swallowing);
  // A claimed drag is direct manipulation: nothing under the finger selects.
  // Refused here rather than with `user-select: none` on <html>, an inherited
  // property that restyled every element of the app as the gesture began.
  const refuseSelection = (event: Event): void => event.preventDefault();

  // The page already saw a `pointerdown` for this touch (a tree row arming a
  // long-press, a press highlight). Claiming the drag means the browser never
  // cancels that pointer for us, so cancel it the way the browser would: the
  // controls that clear their press state on `pointercancel` do so, and a slow,
  // deliberate drag cannot pop a context menu half way across the screen.
  let lastDown: { id: number; target: EventTarget } | null = null;
  const rememberPointerDown = (event: PointerEvent): void => {
    lastDown = event.pointerType === "touch" ? { id: event.pointerId, target: event.target! } : null;
  };
  const cancelPagePress = (): void => {
    const down = lastDown;
    lastDown = null;
    if (!down || typeof win.PointerEvent !== "function") return;
    down.target.dispatchEvent(new win.PointerEvent("pointercancel", {
      pointerId: down.id,
      pointerType: "touch",
      isPrimary: true,
      bubbles: true,
      composed: true,
    }));
  };

  const touchById = (list: TouchList, id: number | null): Touch | null => {
    for (let i = 0; i < list.length; i++) if (list[i]!.identifier === id) return list[i]!;
    return null;
  };

  // Non-passive, and only for the touch being followed: a claimed drag must be
  // able to cancel the browser's scroll and the click that would follow it.
  const active = { capture: true, passive: false } as const;
  let following = false;
  const follow = (): void => {
    if (following) return;
    following = true;
    doc.addEventListener("touchmove", onTouchMove, active);
    doc.addEventListener("touchend", onTouchEnd, active);
    doc.addEventListener("touchcancel", onTouchCancel, active);
  };
  const unfollow = (): void => {
    if (!following) return;
    following = false;
    doc.removeEventListener("touchmove", onTouchMove, active);
    doc.removeEventListener("touchend", onTouchEnd, active);
    doc.removeEventListener("touchcancel", onTouchCancel, active);
  };

  /** Back to idle; the session (if any) has already been told how it ended. */
  const reset = (): void => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    if (claims.get(doc) === owner) {
      claims.delete(doc);
      delete root.dataset.stackSwiping;
      doc.removeEventListener("selectstart", refuseSelection, true);
    }
    unfollow();
    session = null;
    startInfo = null;
    touchId = null;
    travel = 0;
    claimTravel = 0;
    base = 0;
    caught = false;
    armed = false;
    samples = [];
    mode = "idle";
  };

  const width = (): number => startInfo?.width ?? (root.clientWidth || win.innerWidth);

  const springHome = (velocity: number): void => {
    const live = session;
    const from = travel;
    const duration = settleDurationMs({
      remaining: from,
      width: width(),
      velocity: -velocity,
      base: motionDurationMs(options.motion ?? "--motion-stack"),
    });
    if (!live || from <= 0 || duration <= 0) {
      live?.paint(0, 0);
      live?.cancel();
      reset();
      return;
    }
    mode = "settling";
    unfollow();
    const t0 = win.performance.now();
    const tick = (now: number): void => {
      const k = Math.min(1, (now - t0) / duration);
      // The CSS hand-offs' own curve, so a spring home and a settle move alike.
      const at = from * (1 - stackEase(k));
      travel = at;
      live.paint(at, edgeSwipeProgress(at, width()));
      if (k < 1) {
        frame = win.requestAnimationFrame(tick);
        return;
      }
      frame = 0;
      live.cancel();
      reset();
    };
    frame = win.requestAnimationFrame(tick);
  };

  const complete = (velocity: number): void => {
    const live = session;
    if (!live) return reset();
    const w = width();
    const release: SwipeRelease = {
      travel,
      width: w,
      velocity,
      settleMs: settleDurationMs({
        remaining: w - travel,
        width: w,
        velocity,
        base: motionDurationMs(options.motion ?? "--motion-stack"),
      }),
    };
    reset();
    live.commit(release);
  };

  /** A finger lands on a layer that is springing home: it stops where it is and follows this finger. */
  const catchSettling = (event: TouchEvent): boolean => {
    const live = session;
    const info = startInfo;
    const target = event.target;
    const surface = options.surface();
    if (!live || !info || event.touches.length !== 1 || !(target instanceof win.Element)) return false;
    if (!surface?.contains(target) || target.closest(SWIPE_OPT_OUT) || !options.enabled()) return false;
    const touch = event.touches[0]!;
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    start = { x: touch.clientX, y: touch.clientY };
    touchId = touch.identifier;
    base = travel;
    claimTravel = 0;
    caught = true;
    samples = [{ t: event.timeStamp, travel: base }];
    mode = "dragging";
    // A catch is a grab, not a tap on whatever sits under the finger.
    cancelPagePress();
    doc.addEventListener("pointerup", swallowPointerUp, swallowing);
    follow();
    return true;
  };

  /** Let go of a touch whose end never arrived (the page went to the background mid-drag). */
  const abandonTouch = (): void => {
    stopSwallowing();
    if (mode === "dragging") springHome(0);
    else if (mode === "tracking" || mode === "ignored") reset();
  };

  const onTouchStart = (event: TouchEvent): void => {
    if ((mode === "tracking" || mode === "ignored" || mode === "dragging") && !touchById(event.touches, touchId)) {
      abandonTouch();
    }
    if (mode === "settling") {
      catchSettling(event);
      return;
    }
    if (mode !== "idle") {
      // A second finger never starts a swipe; it turns a drag into a cancel.
      if (event.touches.length > 1 && mode === "dragging") {
        stopSwallowing();
        springHome(0);
      } else if (event.touches.length > 1 && mode === "tracking") {
        mode = "ignored";
        unfollow();
      }
      return;
    }
    if (event.touches.length !== 1 || claims.has(doc) || !options.enabled()) return;
    const touch = event.touches[0]!;
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const surface = options.surface();
    if (!surface || !surface.contains(target) || target.closest(SWIPE_OPT_OUT)) return;
    const rtl = root.dir === "rtl" || win.getComputedStyle(root).direction === "rtl";
    const w = root.clientWidth || win.innerWidth;
    const edge = isSwipeEdgeStart(touch.clientX, w, rtl, options.direction);
    if (!edge) {
      // Away from the edge a swipe has to leave room for everything else a
      // horizontal touch can mean: editing text, a row's own swipe actions,
      // extending a selection.
      if (options.zone() !== "surface") return;
      if (ownerKeeps(target, surface, options.direction) || target.closest(EDITABLE) || selectingText(win)) return;
    }
    const extent = options.extent?.();
    startInfo = { rtl, width: extent && extent > 0 ? Math.min(extent, w) : w, target, edge };
    start = { x: touch.clientX, y: touch.clientY };
    touchId = touch.identifier;
    travel = 0;
    claimTravel = 0;
    base = 0;
    armed = false;
    samples = [{ t: event.timeStamp, travel: 0 }];
    mode = "tracking";
    follow();
  };

  const claim = (): boolean => {
    const info = startInfo;
    const surface = options.surface();
    if (!info || !surface || claims.has(doc) || !options.enabled()) return false;
    // Content that scrolls or drags horizontally keeps the touch until it has
    // nowhere left to go. Measured once, at the moment of decision.
    if (!info.edge && contentOwnsSwipe(info.target, surface, options.direction, win)) return false;
    const next = options.begin(info);
    if (!next) return false;
    session = next;
    claims.set(doc, owner);
    mode = "dragging";
    cancelPagePress();
    doc.addEventListener("pointerup", swallowPointerUp, swallowing);
    doc.addEventListener("selectstart", refuseSelection, true);
    doc.defaultView?.getSelection?.()?.removeAllRanges();
    root.dataset.stackSwiping = "true";
    return true;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (mode !== "tracking" && mode !== "dragging") return;
    const touch = touchById(event.touches, touchId);
    if (!touch || !startInfo) return;
    const finger = directedTravel(start.x, touch.clientX, startInfo.rtl, options.direction);
    if (mode === "tracking") {
      const intent = swipeIntent(start, { x: touch.clientX, y: touch.clientY }, {
        rtl: startInfo.rtl,
        direction: options.direction,
        edge: startInfo.edge,
      });
      if (intent === "pending") return;
      if (intent === "scroll" || !claim()) {
        // Not ours: stop listening to this touch at all.
        mode = "ignored";
        unfollow();
        return;
      }
      claimTravel = Math.max(0, finger);
    }
    // The browser must not also scroll or rubber-band under a claimed drag.
    if (event.cancelable) event.preventDefault();
    const w = width();
    // The layer leaves rest smoothly and is under the finger within the next
    // few pixels; a caught layer moves on from where it was caught.
    travel = Math.min(w, Math.max(0, base + caughtUpTravel(finger, claimTravel)));
    // Release speed is the finger's own, not the catch-up's.
    samples.push({ t: event.timeStamp, travel: base + finger });
    if (samples.length > SAMPLE_LIMIT) samples.shift();
    const progress = edgeSwipeProgress(travel, w);
    session?.paint(travel, progress);
    // One detent as the drag crosses the point where letting go completes it.
    const past = progress >= EDGE_SWIPE_COMMIT_PROGRESS;
    if (past !== armed) {
      armed = past;
      selectionFeedback();
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (mode === "tracking" || mode === "ignored") {
      if (event.touches.length === 0) reset();
      return;
    }
    if (mode !== "dragging") return;
    if (!touchById(event.changedTouches, touchId)) return;
    stopSwallowing();
    // A drag is not a tap: keep the synthesized click from reaching what is underneath.
    if (event.cancelable) event.preventDefault();
    const velocity = releaseVelocity(samples);
    // A layer only caught (not moved on) carries on home: the finger stopped
    // it, it did not ask for the other outcome.
    if (caught && Math.abs(travel - base) < EDGE_SWIPE_FLICK_MIN_TRAVEL) springHome(0);
    else if (edgeSwipeCommits({ travel, width: width(), velocity })) complete(velocity);
    else springHome(velocity);
  };

  const onTouchCancel = (): void => {
    stopSwallowing();
    if (mode === "dragging") springHome(0);
    else if (mode === "tracking" || mode === "ignored") reset();
  };

  // An `ignored` touch ends with no listener left to see it; the next touch
  // starts from idle regardless.
  const onIdleCheck = (event: TouchEvent): void => {
    if (mode === "ignored" && event.touches.length === 0) reset();
  };

  // A page sent to the background mid-drag may never deliver the touch's end.
  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") abandonTouch();
  };

  const passive = { capture: true, passive: true } as const;
  doc.addEventListener("pointerdown", rememberPointerDown, passive);
  doc.addEventListener("touchstart", onTouchStart, passive);
  doc.addEventListener("touchend", onIdleCheck, passive);
  doc.addEventListener("touchcancel", onIdleCheck, passive);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pagehide", abandonTouch);
  return () => {
    doc.removeEventListener("pointerdown", rememberPointerDown, passive);
    doc.removeEventListener("touchstart", onTouchStart, passive);
    doc.removeEventListener("touchend", onIdleCheck, passive);
    doc.removeEventListener("touchcancel", onIdleCheck, passive);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pagehide", abandonTouch);
    stopSwallowing();
    const live = session;
    reset();
    // Detaching mid-drag puts everything back where it was. A commit already
    // handed over is the session's own business (its hand-off outlives us).
    live?.cancel();
  };
}
