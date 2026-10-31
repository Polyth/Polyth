/** A timeline is attached only at its real tail. The old 80px "near tail"
 * band made a small upward wheel gesture re-enable following immediately. */
export const TIMELINE_TAIL_EPSILON = 2;

/** The reading anchor is deliberately device-independent: the visible area
 * already excludes the phone island and scroll padding. */
export const TIMELINE_FOCUS_RATIO = 0.5;

export interface TimelineVisibleAreaLike {
  top: number;
  bottom: number;
  height: number;
}

export function timelineFocusLine(area: TimelineVisibleAreaLike): number {
  const top = Number.isFinite(area.top) ? area.top : 0;
  const height = Number.isFinite(area.height) ? Math.max(0, area.height) : 0;
  return top + height * TIMELINE_FOCUS_RATIO;
}

/** The tail reserve which puts a tail row's bottom on the focus line. */
export function timelineTurnReserve(area: TimelineVisibleAreaLike): number {
  const focus = timelineFocusLine(area);
  const bottom = Number.isFinite(area.bottom) ? area.bottom : focus;
  return Math.max(0, Math.ceil(bottom - focus));
}

/** Convert a row bottom in scroller-content coordinates to the scrollTop that
 * places it on the focus line. A short transcript naturally clamps to zero. */
export function focusLineScrollTop(input: {
  contentBottom: number;
  viewportTop: number;
  visibleTop: number;
  visibleHeight: number;
}): number {
  const contentBottom = Number.isFinite(input.contentBottom) ? input.contentBottom : 0;
  const viewportTop = Number.isFinite(input.viewportTop) ? input.viewportTop : 0;
  const visibleTop = Number.isFinite(input.visibleTop) ? input.visibleTop : viewportTop;
  const height = Number.isFinite(input.visibleHeight) ? Math.max(0, input.visibleHeight) : 0;
  return Math.max(0, contentBottom - (visibleTop - viewportTop + height * TIMELINE_FOCUS_RATIO));
}

/** Growth of the row being read fills DOWN: streamed prose during a live turn,
 * and every tail change once no turn is live. Rows above stay still until the
 * tail reaches its rest line (the composer edge), then the view follows that
 * edge; the focus line is only for new rows of a live turn. */
export function fillDownScrollTop(input: {
  scrollTop: number;
  maxScrollTop: number;
  /** Bottom of the tail content, in the same coordinates as `restLine`. */
  tailBottom: number;
  /** Where the tail rests: the visible bottom minus the tail clearance. */
  restLine: number;
}): number {
  const overflow = input.tailBottom - input.restLine;
  const next = input.scrollTop + (Number.isFinite(overflow) ? Math.max(0, overflow) : 0);
  return Math.max(0, Math.min(input.maxScrollTop, next));
}

/** Held blank never lifts the followed tail into the top quarter of the
 * reading area: at least this share of the visible height stays transcript. */
export const TIMELINE_TAIL_MIN_VISIBLE_RATIO = 0.25;

export interface TimelineExtentFloorInput {
  /** Highest natural scroll extent reached while following. */
  highWater: number;
  /** Current natural extent with the floor marker excluded. */
  naturalExtent: number;
  /** The visible reading height, used to bound held blank space. */
  visibleHeight: number;
  /** Blank already below the tail at the natural extent: the live reserve
   * and the tail clearance. Held blank adds to it. */
  tailReserve?: number;
  following: boolean;
}

export interface TimelineExtentFloorState {
  extent: number;
  space: number;
  released: boolean;
}

/** Keep a followed timeline's extent monotonic, but never preserve more than
 * half a viewport of blank space after content genuinely shrinks — nor so
 * much that, on top of the blank already below the tail (a live turn reserves
 * the lower half of the view), the tail rises into the top quarter of the
 * reading area or out of it, leaving the reader an empty view. A release is
 * explicit so callers can capture rows and FLIP the downward glide. */
export function ratchetTimelineExtent(input: TimelineExtentFloorInput): TimelineExtentFloorState {
  const natural = Number.isFinite(input.naturalExtent) ? Math.max(0, input.naturalExtent) : 0;
  const highWater = Number.isFinite(input.highWater) ? Math.max(0, input.highWater) : natural;
  if (!input.following) return { extent: natural, space: 0, released: highWater > natural };
  if (natural >= highWater) return { extent: natural, space: 0, released: false };
  const height = Number.isFinite(input.visibleHeight) ? Math.max(0, input.visibleHeight) : 0;
  const reserve = Number.isFinite(input.tailReserve) ? Math.max(0, input.tailReserve ?? 0) : 0;
  const hold = Math.max(0, Math.min(height * 0.5, height * (1 - TIMELINE_TAIL_MIN_VISIBLE_RATIO) - reserve));
  const blank = highWater - natural;
  if (blank <= hold) return { extent: highWater, space: Math.ceil(blank), released: false };
  return { extent: natural + hold, space: Math.ceil(hold), released: true };
}

export interface TimelineFollowSample {
  scrollTop: number;
  previousScrollTop: number;
  distanceFromEnd: number;
  readerDetached: boolean;
  /** Input captured before the scroll event. Layout reflow has no intent. */
  readerIntent?: "toward-history" | "toward-tail" | null;
  /** The whole tail sits at or above its rest line (the composer edge less
   * the tail clearance): nothing of the transcript is hidden below the view. */
  tailRevealed?: boolean;
  /** The reader currently holds a soft-locked live position. */
  softLocked?: boolean;
}

export interface TimelineFollowState {
  readerDetached: boolean;
  following: boolean;
  showJump: boolean;
  /** Following, but holding the reader's own position above blank live
   * runway: new rows fill down into that runway instead of lifting the view
   * to the focus line, until the reader scrolls on into the true tail. */
  softLocked: boolean;
}

/** Resolve a timeline scroll without confusing browser layout correction for
 * reader intent. Wheel, touch, keyboard and scrollbar handlers own detach;
 * ResizeObserver, shrinking turn space and composer reflow carry no intent.
 *
 * A live turn keeps blank runway (reserve, held floor) below its tail, so the
 * tail can be fully visible well before the true scroll end. That is the live
 * edge the reader sees: moving up inside it soft-locks the position instead of
 * detaching, and a detached reader moving down reconnects as soon as the tail
 * is revealed again — never only at the blank end of the runway. Without
 * runway the tail rests at the extent end, so only the true tail applies. */
export function timelineFollowState(sample: TimelineFollowSample): TimelineFollowState {
  const movingDown = sample.scrollTop > sample.previousScrollTop + 0.25;
  const atTail = sample.distanceFromEnd <= TIMELINE_TAIL_EPSILON;
  // The tail is visible with blank runway still below it.
  const liveEdge = sample.tailRevealed === true && !atTail;
  if (sample.readerIntent === "toward-history") {
    if (liveEdge) return { readerDetached: false, following: true, showJump: false, softLocked: true };
    return { readerDetached: true, following: false, showJump: true, softLocked: false };
  }
  if (sample.readerDetached) {
    if (sample.readerIntent === "toward-tail" && movingDown && (atTail || liveEdge)) {
      return { readerDetached: false, following: true, showJump: false, softLocked: liveEdge };
    }
    return { readerDetached: true, following: false, showJump: true, softLocked: false };
  }
  // Following: reaching the true tail hands the view back to live follow.
  return { readerDetached: false, following: true, showJump: false, softLocked: sample.softLocked === true && !atTail };
}
