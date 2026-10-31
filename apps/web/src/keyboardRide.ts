// Riding the software keyboard on the compositor.
//
// The phone composer is docked at the bottom of the measured app frame, so a
// keyboard that slides up has to carry it. Easing the frame itself (the html,
// body and #root heights) re-laid the whole app on the main thread every
// frame, and in this app any style change on <html> or <body> restyles every
// element (they hold the theme's ~260 custom properties): a ~270 ms stall
// (Chromium, 1× CPU) exactly when the keyboard set off, and another when it
// landed. The keyboard never stalls, so the composer fell behind it, then
// jumped to catch up — the stutter people saw.
//
// Instead the docks and, while the reader follows the tail, the transcript
// move by `transform` alone: animations the compositor (Core Animation on
// iOS) runs without the main thread, on the keyboard's own curve. The layout
// changes only where nothing is moving (mobileViewport.ts):
// - a keyboard that covers more (it opens, or grows) is ridden first, and the
//   layout is committed once it has landed;
// - a keyboard that covers less (it closes, or shrinks) is committed at once,
//   and the riders glide down from where they were (FLIP).
// Every commit measures where the riders really are and glides any residual
// away, so a prediction that was off never shows as a jump.
import { keyboardMotion } from "./motionPresence.ts";

/** Id of the transform animations this module runs (keyboardMotion.ts leaves them alone). */
export const KEYBOARD_RIDE_TRANSFORM_ID = "keyboard-ride-transform";

/** Bottom docks that carry a composer: the conversation dock and the new-chat hero dock. */
const DOCKS = ".conversation-composer-dock, .stage-new .hero-dock";
/** The transcript column of the conversation a dock belongs to, and its scroller. */
const CONTENT = ".timeline-wrap";
const SCROLLER = ".timeline";
/** Keyframes sampled from the keyboard's curve: linear segments are what every
 *  compositor (Core Animation included) can run without the main thread. */
const SAMPLES = 32;
const TAIL_EPSILON = 2;
const MIN_OFFSET = 0.5;
/** A residual left by a commit glides away on a short, settling curve. */
const RESIDUAL_MS = 180;

type Role = "dock" | "content";

interface RiderState {
  el: HTMLElement;
  role: Role;
  /** The edge the ride keeps in place: a dock's composer card bottom (the
   *  dock's own height changes with the keyboard state — rows hide, the
   *  home-indicator clearance hands over — while the card is what the eye
   *  follows), the transcript column's top. Visual: layout + ride offset. */
  edge: number;
  /** The content rider's scroll offset when captured. */
  scrollTop: number;
}

/** The element whose lower edge a dock rides by. */
function dockAnchor(dock: HTMLElement): HTMLElement {
  return dock.querySelector<HTMLElement>(".composer-card") ?? dock;
}

export interface RideSnapshot {
  riders: RiderState[];
  /** The transcript followed its tail when captured. */
  following: boolean;
  /** Scroller geometry when captured, for the content rider's target. */
  scrollHeight: number;
  clientHeight: number;
}

export interface RideTarget {
  /** Where the docks must end up relative to the layout now in place: the
   *  part of the keyboard move the layout does not reflect yet (negative = up). */
  dockOffset: number;
  /** A fresh move on the keyboard's curve, or a short residual glide. */
  mode: "keyboard" | "residual";
  /** How far the keyboard has already travelled, read the moment the ride
   *  is placed: work done in between would otherwise leave it behind. */
  elapsedMs?: () => number;
  /** The layout change this ride follows restyled the whole app. Its cost is
   *  paid inside this task (the ride reads the new layout synchronously), so
   *  the glide starts on the next frame, after the stall, and is never
   *  advanced into it: an animation timed from before the stall would land at
   *  its end in one step. */
  afterCommit?: boolean;
}

const animations = new Map<HTMLElement, Animation>();
let residualObserver: { observer: ResizeObserver; done: () => void } | null = null;

/** Riders become compositor layers ahead of the ride: an element promoted
 *  only when its animation starts has to be painted and rasterised first, so
 *  the compositor may show the ride a frame or more late. Primed when a
 *  dock's editor is touched or focused, released once no keyboard ride can
 *  follow (not while the editor holds focus). */
export const KEYBOARD_RIDER_ATTRIBUTE = "data-keyboard-rider";
const RELEASE_AFTER_MS = 1500;
const primed = new Set<HTMLElement>();
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function prime(el: HTMLElement): void {
  if (!el.hasAttribute(KEYBOARD_RIDER_ATTRIBUTE)) el.setAttribute(KEYBOARD_RIDER_ATTRIBUTE, "");
  primed.add(el);
  scheduleRelease();
}

function scheduleRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseRiders, RELEASE_AFTER_MS);
}

function releaseRiders(): void {
  releaseTimer = null;
  const active = typeof document === "undefined" ? null : document.activeElement;
  const held = [...primed].some((el) => el.isConnected && active && el.contains(active));
  if (keyboardRideActive() || held) {
    scheduleRelease();
    return;
  }
  for (const el of primed) el.removeAttribute(KEYBOARD_RIDER_ATTRIBUTE);
  primed.clear();
}

/** A touch or focus on a dock's composer: its keyboard is about to open. */
export function primeKeyboardRide(target: EventTarget | null): void {
  const dock = (target as Element | null)?.closest?.<HTMLElement>(DOCKS);
  if (!dock || !visible(dock)) return;
  prime(dock);
  const content = contentFor(dock);
  if (content) prime(content);
}

function visible(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

function docks(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(DOCKS)).filter(visible);
}

function contentFor(dock: HTMLElement): HTMLElement | null {
  if (!dock.classList.contains("conversation-composer-dock")) return null;
  const column = dock.parentElement;
  const content = column ? Array.from(column.children).find((child) => child.matches(CONTENT)) as HTMLElement | undefined : undefined;
  return content && visible(content) ? content : null;
}

function scrollerOf(content: HTMLElement): HTMLElement | null {
  return content.querySelector<HTMLElement>(SCROLLER);
}

/** The docks that would ride: the text entry the keyboard serves sits in one. */
export function focusRidesKeyboard(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active?.closest) return false;
  const dock = active.closest<HTMLElement>(DOCKS);
  return !!dock && visible(dock) && typeof dock.animate === "function";
}

/** True while any rider still has a ride (or residual glide) running. */
export function keyboardRideActive(): boolean {
  for (const animation of animations.values()) if (animation.playState === "running") return true;
  return false;
}

/** Where every rider is right now, before the layout under it changes. */
export function captureRide(): RideSnapshot | null {
  const riders: RiderState[] = [];
  let following = false;
  let scrollHeight = 0;
  let clientHeight = 0;
  for (const dock of docks()) {
    riders.push({ el: dock, role: "dock", edge: dockAnchor(dock).getBoundingClientRect().bottom, scrollTop: 0 });
    const content = contentFor(dock);
    const scroller = content ? scrollerOf(content) : null;
    if (content && scroller) {
      scrollHeight = scroller.scrollHeight;
      clientHeight = scroller.clientHeight;
      following = scrollHeight - clientHeight - scroller.scrollTop <= TAIL_EPSILON;
      riders.push({ el: content, role: "content", edge: content.getBoundingClientRect().top, scrollTop: scroller.scrollTop });
    }
  }
  return riders.length ? { riders, following, scrollHeight, clientHeight } : null;
}

/** How far the transcript's tail will move when the layout under it shrinks
 *  by `-dockOffset` — the amount Timeline's follow will scroll — so it can
 *  ride glued to the composer. A reader away from the tail keeps their place. */
function contentOffset(snapshot: RideSnapshot, content: RiderState, dockOffset: number): number {
  if (!snapshot.following || dockOffset >= 0) return 0;
  const shrink = -dockOffset;
  const travel = snapshot.scrollHeight - (snapshot.clientHeight - shrink) - content.scrollTop;
  return -Math.max(0, Math.min(shrink, travel));
}

type Curve = (t: number) => number;

function cubicBezier(x1: number, y1: number, x2: number, y2: number): Curve {
  const sample = (a: number, b: number, t: number) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 24; i += 1) {
      const value = sample(x1, x2, t);
      if (Math.abs(value - x) < 1e-5) break;
      if (value < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sample(y1, y2, t);
  };
}

/** The keyboard's easing as a function: the token's cubic-bezier, or the
 *  evenly spaced `linear()` stops keyboardMotion.ts samples from a spring. */
export function keyboardCurve(easing: string): Curve {
  const bezier = /^cubic-bezier\(([^)]+)\)$/.exec(easing.trim());
  if (bezier) {
    const values = bezier[1]!.split(",").map((part) => Number(part.trim()));
    if (values.length === 4 && values.every(Number.isFinite)) return cubicBezier(values[0]!, values[1]!, values[2]!, values[3]!);
  }
  const linear = /^linear\(([^)]+)\)$/.exec(easing.trim());
  if (linear) {
    const stops = linear[1]!.split(",").map((part) => Number(part.trim()));
    if (stops.length >= 2 && stops.every(Number.isFinite)) {
      return (x) => {
        if (x <= 0) return stops[0]!;
        if (x >= 1) return stops[stops.length - 1]!;
        const position = x * (stops.length - 1);
        const index = Math.floor(position);
        const fraction = position - index;
        return stops[index]! + (stops[index + 1]! - stops[index]!) * fraction;
      };
    }
  }
  if (easing.trim() === "ease-out") return cubicBezier(0, 0, 0.58, 1);
  return cubicBezier(0.38, 0.7, 0.125, 1);
}

function keyframes(from: number, to: number, curve: Curve): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const progress = curve(i / SAMPLES);
    const y = from + (to - from) * progress;
    frames.push({ offset: i / SAMPLES, transform: `translate3d(0, ${Math.round(y * 100) / 100}px, 0)` });
  }
  return frames;
}

/** The rider's current ride offset (0 when it is not riding). */
function currentOffset(el: HTMLElement): number {
  const animation = animations.get(el);
  if (!animation || animation.playState === "finished" || animation.playState === "idle") return 0;
  const matrix = getComputedStyle(el).transform;
  if (!matrix || matrix === "none") return 0;
  const values = /matrix(3d)?\(([^)]+)\)/.exec(matrix)?.[2]?.split(",").map(Number) ?? [];
  const y = matrix.startsWith("matrix3d") ? values[13] : values[5];
  return Number.isFinite(y) ? y! : 0;
}

function stop(el: HTMLElement): void {
  const animation = animations.get(el);
  animations.delete(el);
  animation?.cancel();
}

/** Drop every ride at once (reduced motion, teardown, tests). */
export function cancelKeyboardRide(): void {
  for (const el of [...animations.keys()]) stop(el);
  residualObserver?.done();
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  for (const el of primed) el.removeAttribute(KEYBOARD_RIDER_ATTRIBUTE);
  primed.clear();
}

function play(el: HTMLElement, from: number, to: number, target: RideTarget): void {
  stop(el);
  if (Math.abs(from) < MIN_OFFSET && Math.abs(to) < MIN_OFFSET) return;
  const motion = keyboardMotion();
  const residual = target.mode === "residual";
  const duration = residual ? Math.min(RESIDUAL_MS, Math.max(motion.duration, 1)) : motion.duration;
  if (duration <= 0 || typeof el.animate !== "function") return;
  prime(el);
  const curve = residual ? keyboardCurve("ease-out") : keyboardCurve(motion.easing);
  // The ride holds its end until the next commit replaces it (fill), and is
  // cancelled the moment the layout reflects where it ended.
  const animation = el.animate(keyframes(from, to, curve), {
    duration,
    fill: "forwards",
    easing: "linear",
    id: KEYBOARD_RIDE_TRANSFORM_ID,
  });
  const elapsed = residual ? 0 : Math.max(0, Math.min(target.elapsedMs?.() ?? 0, duration));
  if (!target.afterCommit && elapsed > 0) alignWithKeyboard(animation, elapsed);
  animations.set(el, animation);
  // A ride that ends with no offset left has nothing to hold.
  if (Math.abs(to) < MIN_OFFSET) {
    animation.addEventListener("finish", () => {
      if (animations.get(el) !== animation) return;
      animations.delete(el);
      animation.cancel();
    });
  }
}

/**
 * Start (or re-aim) the ride after the layout under the riders has changed:
 * each rider glides from where `snapshot` saw it to `target.dockOffset`
 * (docks) or to where the transcript's tail will be (content). The layout
 * change must already be applied; this reads it.
 */
export function rideKeyboard(snapshot: RideSnapshot | null, target: RideTarget): void {
  if (!snapshot) return;
  residualObserver?.done();
  const contents: Array<{ rider: RiderState; to: number }> = [];
  for (const rider of snapshot.riders) {
    if (!rider.el.isConnected) {
      animations.delete(rider.el);
      continue;
    }
    // Read the new layout without the old ride: its offset is in `top`.
    stop(rider.el);
    if (rider.role === "dock") {
      const layoutEdge = dockAnchor(rider.el).getBoundingClientRect().bottom;
      play(rider.el, rider.edge - layoutEdge, target.dockOffset, target);
    } else {
      const to = contentOffset(snapshot, rider, target.dockOffset);
      contents.push({ rider, to });
      startContent(rider, to, target);
    }
  }
  // Timeline's own follow re-scrolls the transcript after layout, in its
  // ResizeObserver; read the settled scroll offset after it and re-aim.
  if (contents.length && typeof ResizeObserver === "function") watchContent(contents, target);
}

function contentFrom(rider: RiderState): number {
  const scroller = scrollerOf(rider.el);
  const layoutTop = rider.el.getBoundingClientRect().top - currentOffset(rider.el);
  const scrolled = scroller ? scroller.scrollTop - rider.scrollTop : 0;
  return rider.edge - layoutTop + scrolled;
}

function startContent(rider: RiderState, to: number, target: RideTarget): void {
  play(rider.el, contentFrom(rider), to, target);
}

function watchContent(contents: Array<{ rider: RiderState; to: number }>, target: RideTarget): void {
  let finished = false;
  const observer = new ResizeObserver(() => {
    if (finished) return;
    for (const { rider, to } of contents) {
      if (!rider.el.isConnected) continue;
      const animation = animations.get(rider.el);
      const from = contentFrom(rider);
      // Re-aim only when Timeline's follow moved the transcript under it.
      const keyframesNow = (animation?.effect as KeyframeEffect | null)?.getKeyframes?.();
      const plannedFrom = keyframesNow?.length ? Number(/translate3d\(0px?,\s*(-?[\d.]+)px/.exec(String(keyframesNow[0]!.transform))?.[1] ?? 0) : 0;
      if (Math.abs(from - plannedFrom) < MIN_OFFSET) continue;
      // The re-aimed ride keeps the clock the first one was set on.
      const startTime = animation?.startTime;
      play(rider.el, from, to, target);
      const replaced = animations.get(rider.el);
      if (replaced && typeof startTime === "number") replaced.startTime = startTime;
    }
    done();
  });
  const done = () => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    if (residualObserver?.observer === observer) residualObserver = null;
  };
  residualObserver = { observer, done };
  for (const { rider } of contents) {
    const scroller = scrollerOf(rider.el);
    if (scroller) observer.observe(scroller);
  }
  // Nothing resized: nothing re-scrolled either.
  nextFrame(() => nextFrame(done));
}

/** Put the ride where the keyboard is, on every frame from now on. A
 *  `currentTime` set inside a task is measured against the last frame's
 *  timeline time, so a new animation would show the keyboard's position of a
 *  frame or two ago; a start time on the clock the timeline runs on
 *  (`performance.now()`) does not. */
function alignWithKeyboard(animation: Animation, elapsedMs: number): void {
  try {
    animation.startTime = performance.now() - elapsedMs;
  } catch {
    animation.currentTime = elapsedMs;
  }
}

function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
  else setTimeout(callback, 16);
}

/** Re-time running keyboard rides to a newly reported keyboard curve, and
 *  catch them up with how far the keyboard has travelled (read per ride). */
export function retimeKeyboardRide(elapsedMs: () => number): void {
  for (const [el, animation] of [...animations]) {
    const effect = animation.effect as KeyframeEffect | null;
    const frames = effect?.getKeyframes?.();
    if (!effect || !frames || frames.length < 2) continue;
    const parse = (frame: ComputedKeyframe) => Number(/translate3d\(0px?,\s*(-?[\d.]+)px/.exec(String(frame.transform))?.[1] ?? NaN);
    const from = parse(frames[0]!);
    const to = parse(frames[frames.length - 1]!);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const motion = keyboardMotion();
    if (motion.duration <= 0) continue;
    // Only full keyboard rides follow the keyboard's curve; residual glides keep theirs.
    if ((effect.getTiming().duration as number) <= RESIDUAL_MS && motion.duration > RESIDUAL_MS) continue;
    effect.setKeyframes(keyframes(from, to, keyboardCurve(motion.easing)));
    effect.updateTiming({ duration: motion.duration });
    const current = typeof animation.currentTime === "number" ? animation.currentTime : 0;
    const elapsed = elapsedMs();
    if (elapsed > current) alignWithKeyboard(animation, Math.min(elapsed, motion.duration));
    animations.set(el, animation);
  }
}
