// Direct-manipulation swipes for the phone shell. One controller owns the
// touch lifecycle of every shell gesture (Navigator, Workspace, the Back of a
// package window): it decides when a touch is a swipe, tracks the finger,
// measures the release, springs a cancelled drag home and keeps the page from
// also treating the drag as a tap, a scroll or a long-press.
//
// What moves is not its business. A claim calls `begin()`, and the returned
// session paints each frame and performs the commit or undoes the drag once it
// is home. The decisions are pure and live in mobileGestures.ts.
//
// Three things keep the motion in one piece:
//   - the claim: the layer leaves rest at the finger's speed and closes its gap
//     to the finger over a moment, however long the claim itself took (the
//     surface a swipe pulls in is mounted right then);
//   - the release: the rest of the travel is a spring that carries on at the
//     finger's speed. A session that implements `settle()` runs it as a
//     compositor animation started in the same task as the release, and only
//     then is told to commit, so the state change it makes (a React commit,
//     focus, inert) happens under a layer that is already moving;
//   - a session without `settle()` commits at once and hands its position to a
//     CSS animation of its own (`settleMs`, `easing`).
//
// Input cost: the always-on `touchstart` listener is passive, so it never holds
// up scrolling. Only a touch that may become a swipe adds the non-passive
// `touchmove`/`touchend` listeners it needs to cancel the browser's handling,
// and they go away with that touch.
import {
  CLAIM_SETTLE_WINDOW_MS,
  CLAIM_STALL_MS,
  EDGE_SWIPE_COMMIT_PROGRESS,
  EDGE_SWIPE_FLICK_MIN_TRAVEL,
  claimGapAt,
  claimGapDurationMs,
  directedTravel,
  edgeSwipeCommits,
  edgeSwipeProgress,
  isSwipeEdgeStart,
  releaseVelocity,
  scrollerTakesSwipe,
  settleDurationMs,
  settleEasing,
  settleSamples,
  springSettle,
  swipeIntent,
  type InlineDirection,
  type SettleCurve,
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
  /** The timing function a CSS hand-off over `settleMs` leaves the finger at the finger's speed with. */
  easing: string;
}

/** The rest of a released layer's travel, for a session that runs it off the main thread. */
export interface SwipeSettle {
  /** `commit`: on to the destination. `home`: back to where the drag began. */
  outcome: "commit" | "home";
  durationMs: number;
  /** Travel `ms` into the settle. */
  travelAt(ms: number): number;
  /**
   * Keyframes for one element: `frame` maps a travel to that element's style.
   * They are evenly spaced samples of the spring, so play them with a linear
   * easing over `durationMs` (see `animateSettle`).
   */
  keyframes(frame: (travel: number, progress: number) => Keyframe): Keyframe[];
}

export interface SwipeSession {
  /** Render one frame `travel` px along the swipe (0 = where the drag began). */
  paint(travel: number, progress: number): void;
  /**
   * Optional. Run the rest of the travel as animations the compositor owns
   * and return them; the controller ends them once the gesture is over.
   * While they run the session's CSS must leave the layer to them (no
   * `!important` transform, no entrance that replays underneath), and where
   * the layer rests afterwards must be where they end. `commit()` and
   * `cancel()` are then called after the animation has started: on a commit,
   * as soon as it reports so (about a frame); coming home, when it has
   * arrived. Return null (no Web
   * Animations, nothing to move) to be painted frame by frame instead.
   */
  settle?(settle: SwipeSettle): Animation | readonly Animation[] | null;
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

/**
 * Play a settle on `el`: the spring's samples as linear keyframes, held at
 * their end until the controller takes them back. Null where the Web
 * Animations API is missing.
 */
export function animateSettle(
  el: HTMLElement,
  settle: SwipeSettle,
  frame: (travel: number, progress: number) => Keyframe,
  pseudoElement?: string,
): Animation | null {
  if (typeof el.animate !== "function") return null;
  return el.animate(settle.keyframes(frame), {
    duration: settle.durationMs,
    easing: "linear",
    fill: "forwards",
    ...(pseudoElement ? { pseudoElement } : {}),
  });
}

/** How many stalled frames right after a claim are absorbed into the gap (the mount, then its effects). */
const CLAIM_STALLS_ABSORBED = 2;
/** How long after a release the commit is delivered when its animations never report a start (a hidden page). */
const COMMIT_FALLBACK_MS = 120;
/** Slack after a settle's own duration before it is taken as finished without its event. */
const SETTLE_FINISH_SLACK_MS = 160;

/** Whether the user is selecting text the swipe would otherwise drag across. */
function selectingText(win: Window): boolean {
  const selection = win.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

/** Attach to a document; returns the cleanup. */
export function attachSwipeSurface(options: SwipeSurfaceOptions, doc: Document = document): () => void {
  type Mode = "idle" | "tracking" | "ignored" | "dragging" | "settling" | "committing";
  const owner = {};
  let mode: Mode = "idle";
  let touchId: number | null = null;
  let start = { x: 0, y: 0 };
  let startInfo: SwipeStart | null = null;
  /** Where the layer is painted, px along the swipe (what a release hands over). */
  let travel = 0;
  /** Where the finger is, px along the swipe (what decides the release). */
  let reach = 0;
  /** The layer's gap to the finger when it last began to close, and when that was. */
  let gap = 0;
  let gapStamp = 0;
  /** When the swipe claimed the touch, and how many stalled frames right after it the gap may still absorb. */
  let claimStamp = 0;
  let stallsLeft = 0;
  /** The last move: where the finger was, when, and when the page heard of it. */
  let lastMove: { stamp: number; finger: number; heardAt: number } | null = null;
  /** Where the layer was when this finger caught it (non-zero only for a catch mid spring-home). */
  let base = 0;
  /** This drag began by catching a layer on its way home. */
  let caught = false;
  let armed = false;
  let samples: TravelSample[] = [];
  let session: SwipeSession | null = null;
  let frame = 0;
  let gapFrame = 0;
  /** A spring home the compositor is running: where it is at any moment, and how to stop it. */
  let homing: { curve: SettleCurve; animations: Animation[]; startedAt: number; stop(): void } | null = null;
  /** A commit whose animation has started and whose state change is one frame away. */
  let pendingCommit: (() => void) | null = null;

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

  /** Take a compositor spring-home back (the layer is then wherever its styles put it). */
  const endHoming = (): void => {
    const run = homing;
    homing = null;
    if (!run) return;
    run.stop();
    for (const animation of run.animations) animation.cancel();
  };

  /** Back to idle; the session (if any) has already been told how it ended. */
  const reset = (): void => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    if (gapFrame) win.cancelAnimationFrame(gapFrame);
    gapFrame = 0;
    endHoming();
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
    reach = 0;
    gap = 0;
    gapStamp = 0;
    claimStamp = 0;
    stallsLeft = 0;
    lastMove = null;
    base = 0;
    caught = false;
    armed = false;
    samples = [];
    mode = "idle";
  };

  const width = (): number => startInfo?.width ?? (root.clientWidth || win.innerWidth);
  const settleBase = (): number => motionDurationMs(options.motion ?? "--motion-stack");

  /** What is left, at `stamp`, of the gap between the layer and the finger. */
  const gapAt = (stamp: number): number => claimGapAt(gap, stamp - gapStamp);
  const openGap = (size: number, stamp: number): void => {
    gap = Math.max(0, size);
    gapStamp = stamp;
  };

  /** Put the layer where the finger has it at `stamp`, less whatever gap is still closing. */
  const paintDrag = (stamp: number): void => {
    const move = lastMove;
    if (!move) return;
    const w = width();
    travel = Math.min(w, Math.max(0, base + move.finger - gapAt(stamp)));
    session?.paint(travel, edgeSwipeProgress(travel, w));
  };

  // The gap closes with time, not with the finger: a finger that stops while
  // the layer is still catching up must not leave it short.
  const closeGap = (): void => {
    gapFrame = 0;
    const move = lastMove;
    if (mode !== "dragging" || !move) return;
    const stamp = move.stamp + (win.performance.now() - move.heardAt);
    paintDrag(stamp);
    if (gapAt(stamp) > 0.25) gapFrame = win.requestAnimationFrame(closeGap);
  };

  /** Hand the spring to the session's compositor animations; empty when it paints frame by frame. */
  const startSettle = (live: SwipeSession, curve: SettleCurve, outcome: SwipeSettle["outcome"]): Animation[] => {
    if (!live.settle || curve.durationMs <= 0) return [];
    const w = width();
    const samples = settleSamples(curve);
    const last = samples.length - 1;
    let started: Animation | readonly Animation[] | null;
    try {
      started = live.settle({
        outcome,
        durationMs: curve.durationMs,
        travelAt: curve.travelAt,
        keyframes: (frameAt) => samples.map((at, index) => ({ ...frameAt(at, edgeSwipeProgress(at, w)), offset: index / last })),
      });
    } catch {
      // A host that rejects the animation still gets its layer home: painted instead.
      started = null;
    }
    if (!started) return [];
    return "length" in started ? [...started] : [started];
  };

  /** Call `done` when a settle's animations have run (their event, or a timer where none comes). */
  const whenSettled = (animations: readonly Animation[], durationMs: number, done: () => void): (() => void) => {
    const lead = animations[0]!;
    let over = false;
    const stop = (): void => {
      over = true;
      win.clearTimeout(timer);
      lead.removeEventListener("finish", fire);
    };
    const fire = (): void => {
      if (over) return;
      stop();
      done();
    };
    const timer = win.setTimeout(fire, durationMs + SETTLE_FINISH_SLACK_MS);
    lead.addEventListener("finish", fire);
    return stop;
  };

  const springHome = (velocity: number): void => {
    const live = session;
    const from = travel;
    const w = width();
    const curve = springSettle({ from, to: 0, velocity, base: settleBase(), range: [0, w] });
    if (!live || from <= 0 || curve.durationMs <= 0) {
      live?.paint(0, 0);
      live?.cancel();
      reset();
      return;
    }
    mode = "settling";
    unfollow();
    if (gapFrame) win.cancelAnimationFrame(gapFrame);
    gapFrame = 0;
    const arrive = (): void => {
      travel = 0;
      live.paint(0, 0);
      // The session puts the layer back at rest before the animation lets go of it.
      live.cancel();
      reset();
    };
    const startedAt = win.performance.now();
    const animations = startSettle(live, curve, "home");
    if (animations.length > 0) {
      homing = { curve, animations, startedAt, stop: whenSettled(animations, curve.durationMs, arrive) };
      return;
    }
    const tick = (now: number): void => {
      const elapsed = now - startedAt;
      const at = curve.travelAt(elapsed);
      travel = at;
      live.paint(at, edgeSwipeProgress(at, w));
      if (elapsed < curve.durationMs) {
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
    const token = settleBase();
    const remaining = w - travel;
    const curve = springSettle({ from: travel, to: w, velocity, base: token, range: [0, w] });
    const animations = startSettle(live, curve, "commit");
    if (animations.length === 0) {
      // The session finishes the travel itself: a CSS hand-off from here.
      const settleMs = settleDurationMs({ remaining, width: w, velocity, base: token });
      const release: SwipeRelease = {
        travel, width: w, velocity, settleMs, easing: settleEasing({ remaining, velocity, durationMs: settleMs }),
      };
      reset();
      live.commit(release);
      return;
    }
    // The layer is already on its way, off the main thread. The commit (a state
    // change that may cost several frames) follows under it, once the
    // animations report they have started. Not sooner: a commit that restyles
    // the layer makes the browser re-send its animations to the compositor,
    // and one whose start time the page has not heard yet is re-sent from its
    // beginning, so the layer would arrive and then travel a second time.
    const release: SwipeRelease = {
      travel, width: w, velocity, settleMs: curve.durationMs,
      easing: settleEasing({ remaining, velocity, durationMs: curve.durationMs }),
    };
    mode = "committing";
    unfollow();
    if (gapFrame) win.cancelAnimationFrame(gapFrame);
    gapFrame = 0;
    let delivered = false;
    let arrived = false;
    let commitTimer = 0;
    // The animations hold the layer at its destination until the committed
    // state rests there too; only then are they taken back.
    const letGo = (): void => {
      if (delivered && arrived) for (const animation of animations) animation.cancel();
    };
    const deliver = (): void => {
      if (delivered) return;
      delivered = true;
      win.clearTimeout(commitTimer);
      pendingCommit = null;
      reset();
      live.commit(release);
      letGo();
    };
    whenSettled(animations, curve.durationMs, () => {
      arrived = true;
      letGo();
    });
    pendingCommit = deliver;
    const started = (): void => {
      if (delivered) return;
      // In a task of its own, after the frame that confirmed the start.
      win.clearTimeout(commitTimer);
      commitTimer = win.setTimeout(deliver, 0);
    };
    commitTimer = win.setTimeout(deliver, COMMIT_FALLBACK_MS);
    void Promise.all(animations.map((animation) => animation.ready)).then(started, started);
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
    const run = homing;
    if (run) {
      // The compositor has it: read where it is, pin it there, take the animation back.
      const elapsed = run.animations[0]!.currentTime;
      travel = run.curve.travelAt(typeof elapsed === "number" ? elapsed : win.performance.now() - run.startedAt);
      live.paint(travel, edgeSwipeProgress(travel, info.width));
      endHoming();
    }
    start = { x: touch.clientX, y: touch.clientY };
    touchId = touch.identifier;
    base = travel;
    reach = travel;
    openGap(0, event.timeStamp);
    lastMove = null;
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
    reach = 0;
    openGap(0, event.timeStamp);
    lastMove = null;
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
    const stamp = event.timeStamp;
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
      // The layer is at rest and the finger is already this far along: the
      // lead is closed over the next moment instead of in one frame.
      openGap(finger, stamp);
      claimStamp = stamp;
      stallsLeft = CLAIM_STALLS_ABSORBED;
    } else if (
      stallsLeft > 0
      && lastMove
      && stamp - claimStamp <= CLAIM_SETTLE_WINDOW_MS
      && stamp - lastMove.stamp > CLAIM_STALL_MS
      && finger > lastMove.finger
    ) {
      // The page stalled (mounting the surface, its first effects) while the
      // finger went on. The layer was not seen to move in that time, so it
      // carries on from where it was last painted and closes this lead too.
      // Only the claim's own aftermath is treated so: a page that is simply
      // slow keeps the layer under the finger, frame by late frame.
      stallsLeft -= 1;
      openGap(base + finger - travel, stamp);
    }
    // The browser must not also scroll or rubber-band under a claimed drag.
    if (event.cancelable) event.preventDefault();
    const w = width();
    lastMove = { stamp, finger, heardAt: win.performance.now() };
    reach = Math.min(w, Math.max(0, base + finger));
    paintDrag(stamp);
    if (!gapFrame && gapAt(stamp) > 0.25) gapFrame = win.requestAnimationFrame(closeGap);
    // Release speed is the finger's own, not the catch-up's.
    samples.push({ t: stamp, travel: base + finger });
    if (samples.length > SAMPLE_LIMIT) samples.shift();
    // One detent as the finger crosses the point where letting go completes it.
    const past = edgeSwipeProgress(reach, w) >= EDGE_SWIPE_COMMIT_PROGRESS;
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
    // it, it did not ask for the other outcome. What the finger asked for is
    // judged by where the finger is; the layer may still be closing its gap.
    if (caught && Math.abs(reach - base) < EDGE_SWIPE_FLICK_MIN_TRAVEL) springHome(0);
    else if (edgeSwipeCommits({ travel: reach, width: width(), velocity })) complete(velocity);
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
    // A release already under way is completed, not undone: its layer is moving.
    pendingCommit?.();
    const live = session;
    reset();
    // Detaching mid-drag puts everything back where it was. A commit already
    // handed over is the session's own business (its hand-off outlives us).
    live?.cancel();
  };
}
