// Small, DOM-free gesture decisions shared by mobile surfaces. Components own
// pointer/touch lifecycle; these helpers only decide intent so vertical scroll
// is never mistaken for a destructive horizontal action.
export interface GesturePoint {
  x: number;
  y: number;
}

export const SESSION_SWIPE_REVEAL = 64;
export const BACK_SWIPE_EDGE = 32;
export const PULL_REFRESH_DISTANCE = 68;

export function horizontalDistance(
  start: GesturePoint,
  end: GesturePoint,
  slop = 8,
): number | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.abs(dx) >= slop && Math.abs(dx) > Math.abs(dy) * 1.15 ? dx : null;
}

export function pullRefreshDistance(
  start: GesturePoint,
  current: GesturePoint,
  scrollTop: number,
): number {
  if (scrollTop > 0) return 0;
  const dy = current.y - start.y;
  const dx = current.x - start.x;
  if (dy <= 0 || Math.abs(dy) <= Math.abs(dx) * 1.15) return 0;
  // Resistance keeps the list attached to the finger without feeling elastic
  // enough to displace useful content.
  return Math.min(96, Math.round(dy * 0.5));
}

// ---- interactive edge swipe (phone layer stack) --------------------------------
// The layer follows the finger from the inline-start edge and a release either
// completes the Back or springs it home. Everything here is pure; the DOM
// controller (edgeSwipeBack.ts) owns listeners, transforms and timing.

/** A drag may start this close to the edge it moves away from. */
export const EDGE_SWIPE_ZONE = BACK_SWIPE_EDGE;
/** Travel before the gesture claims the touch (below it a tap or scroll is still possible). */
export const EDGE_SWIPE_SLOP = 10;
/** Past this share of the width a slow release still completes the Back. */
export const EDGE_SWIPE_COMMIT_PROGRESS = 0.35;
/** A flick this fast (px per ms toward the inline end) completes the Back from anywhere past the dead zone. */
export const EDGE_SWIPE_COMMIT_VELOCITY = 0.5;
/** Minimum travel for a flick to count, so a twitch cannot pop a layer. */
export const EDGE_SWIPE_FLICK_MIN_TRAVEL = 24;

/** Travel toward the inline end: positive for a swipe that pulls the layer away. */
export function inlineTravel(startX: number, currentX: number, rtl: boolean): number {
  return rtl ? startX - currentX : currentX - startX;
}

/** Whether a touch starting at `x` begins at the inline-start edge. */
export function isEdgeSwipeStart(x: number, viewportWidth: number, rtl: boolean): boolean {
  return rtl ? x >= viewportWidth - EDGE_SWIPE_ZONE : x <= EDGE_SWIPE_ZONE;
}

export type EdgeSwipeIntent = "pending" | "swipe" | "scroll";

/**
 * Decide what an edge touch is doing. Vertical movement hands the touch back to
 * scrolling; deliberate horizontal movement toward the inline end claims it. A
 * drag toward the screen edge never claims it (nothing to pop that way).
 */
export function edgeSwipeIntent(start: GesturePoint, current: GesturePoint, rtl: boolean): EdgeSwipeIntent {
  return swipeIntent(start, current, { rtl, direction: "toward-end", edge: true });
}

/** 0 at rest, 1 when the layer has left the screen. */
export function edgeSwipeProgress(travel: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, travel / width));
}

export interface TravelSample {
  /** Milliseconds, any monotonic origin. */
  t: number;
  /** Inline travel at that instant. */
  travel: number;
}

/** Speed toward the inline end over the trailing window (px per ms; negative = returning). */
export function releaseVelocity(samples: readonly TravelSample[], windowMs = 100): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const first = samples.find((sample) => last.t - sample.t <= windowMs) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? (last.travel - first.travel) / dt : 0;
}

/** Whether releasing completes the Back (true) or springs the layer home (false). */
export function edgeSwipeCommits(input: { travel: number; width: number; velocity: number }): boolean {
  const progress = edgeSwipeProgress(input.travel, input.width);
  if (input.velocity <= -EDGE_SWIPE_COMMIT_VELOCITY) return false;
  if (input.velocity >= EDGE_SWIPE_COMMIT_VELOCITY && input.travel >= EDGE_SWIPE_FLICK_MIN_TRAVEL) return true;
  return progress >= EDGE_SWIPE_COMMIT_PROGRESS;
}

// ---- shell swipes: either direction, from an edge or anywhere ------------------
// The same drag grammar drives every phone shell gesture: the Navigator follows
// a finger toward the inline end, the Workspace one toward the inline start,
// and each leaves the way it came. A swipe may start in the edge zone it moves
// away from, or (surface mode) anywhere on the surface, where it has to be more
// decisive and yields to content that owns horizontal movement.

/** Which way, in inline terms, the finger travels to claim a swipe. */
export type InlineDirection = "toward-end" | "toward-start";

/** Where a swipe may start: only in the edge zone, or anywhere on the surface. */
export type SwipeZone = "edge" | "surface";

/** Away from an edge a swipe must clear more travel before it claims the touch. */
export const SURFACE_SWIPE_SLOP = 12;
/** …and be clearly horizontal, so a diagonal scroll through the chat is never stolen. */
export const SURFACE_SWIPE_RATIO = 1.6;
/** Undecided movement past this distance is not a swipe. */
export const SURFACE_SWIPE_GIVE_UP = 30;

/** Travel along `direction`: positive while the finger moves that way. */
export function directedTravel(startX: number, currentX: number, rtl: boolean, direction: InlineDirection): number {
  const travel = inlineTravel(startX, currentX, rtl);
  return direction === "toward-end" ? travel : -travel;
}

/** Whether `x` lies in the edge zone a swipe in `direction` moves away from. */
export function isSwipeEdgeStart(x: number, viewportWidth: number, rtl: boolean, direction: InlineDirection): boolean {
  if (direction === "toward-end") return isEdgeSwipeStart(x, viewportWidth, rtl);
  return rtl ? x <= EDGE_SWIPE_ZONE : x >= viewportWidth - EDGE_SWIPE_ZONE;
}

/**
 * Decide what a touch is doing for a swipe in `direction`. An edge start uses
 * the lenient edge rule (identical to `edgeSwipeIntent`); a surface start needs
 * more travel and a steeper angle, and gives up once it has wandered without
 * deciding.
 */
export function swipeIntent(
  start: GesturePoint,
  current: GesturePoint,
  input: { rtl: boolean; direction: InlineDirection; edge: boolean },
): EdgeSwipeIntent {
  const travel = directedTravel(start.x, current.x, input.rtl, input.direction);
  const vertical = Math.abs(current.y - start.y);
  const slop = input.edge ? EDGE_SWIPE_SLOP : SURFACE_SWIPE_SLOP;
  const ratio = input.edge ? 1.15 : SURFACE_SWIPE_RATIO;
  if (vertical > slop && vertical > Math.abs(travel)) return "scroll";
  if (travel < -slop) return "scroll";
  if (travel > slop && travel > vertical * ratio) return "swipe";
  if (!input.edge && Math.hypot(travel, vertical) > SURFACE_SWIPE_GIVE_UP) return "scroll";
  return "pending";
}

/** Initial slope of `--motion-stack-ease` (cubic-bezier(.32,.72,0,1)): .72 / .32. */
const SETTLE_CURVE_SLOPE = 2.25;
/** A settle is never shorter than this (unless motion is off), so it still reads as motion. */
export const SETTLE_MIN_MS = 120;

/**
 * How long a released layer takes to finish its travel. The rest of the way
 * takes a share of the full duration, and a flick is never slowed down: the
 * curve leaves at the finger's own speed, so the layer is not seen to brake or
 * lurch at the hand-off. `velocity` is px/ms toward the destination.
 */
export function settleDurationMs(input: { remaining: number; width: number; velocity: number; base: number }): number {
  if (!(input.base > 0)) return 0;
  const remaining = Math.max(0, input.remaining);
  const share = input.width > 0 ? Math.min(1, remaining / input.width) : 1;
  let duration = input.base * (0.45 + 0.55 * share);
  if (input.velocity > 0) duration = Math.min(duration, (SETTLE_CURVE_SLOPE * remaining) / input.velocity);
  return Math.round(Math.min(input.base, Math.max(Math.min(SETTLE_MIN_MS, input.base), duration)));
}

/**
 * Where a claimed drag paints its layer. A swipe is recognised only once the
 * finger has cleared the slop, and moving the layer that far in one frame reads
 * as a lurch. Instead the layer leaves its rest position with the finger and
 * closes the gap over the next `claimTravel` px (at twice the finger's speed),
 * after which it sits exactly under the finger.
 */
export function caughtUpTravel(travel: number, claimTravel: number): number {
  if (!(claimTravel > 0)) return travel;
  const gap = claimTravel * Math.max(0, 1 - (travel - claimTravel) / claimTravel);
  return Math.max(0, travel - gap);
}

/** A CSS `cubic-bezier()` timing function as a pure easing: time share → progress share. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number): number => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number): number => {
    if (!(t > 0)) return 0;
    if (t >= 1) return 1;
    // Newton's method converges in a few steps; bisection covers flat slopes.
    let u = t;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(u) - t;
      if (Math.abs(error) < 1e-6) return sampleY(u);
      const slope = slopeX(u);
      if (Math.abs(slope) < 1e-6) break;
      u = Math.min(1, Math.max(0, u - error / slope));
    }
    let low = 0;
    let high = 1;
    u = t;
    for (let i = 0; i < 40; i++) {
      const x = sampleX(u);
      if (Math.abs(x - t) < 1e-6) break;
      if (x < t) low = u;
      else high = u;
      u = (low + high) / 2;
    }
    return sampleY(u);
  };
}

/**
 * `--motion-stack-ease`: scripted settles (a spring home) follow the same curve
 * as the CSS hand-offs, so a layer moves alike whichever of the two finishes it.
 */
export const stackEase = cubicBezier(0.32, 0.72, 0, 1);

export interface InlineScrollBox {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Whether a horizontal scroller can still move the way a swipe in `direction`
 * would push it. A finger travelling toward the inline end scrolls content
 * back toward its start, so it belongs to the scroller until that start is
 * reached; then the swipe takes over. RTL `scrollLeft` runs from 0 toward
 * negative values, so distances use its magnitude.
 */
export function scrollerTakesSwipe(box: InlineScrollBox, direction: InlineDirection): boolean {
  const max = Math.max(0, box.scrollWidth - box.clientWidth);
  if (max <= 1) return false;
  const fromStart = Math.min(max, Math.abs(box.scrollLeft));
  return (direction === "toward-end" ? fromStart : max - fromStart) > 1;
}
