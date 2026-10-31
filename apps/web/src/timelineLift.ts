import { TIMELINE_ENTRANCE_ANIMATION_ID } from "./timelineMotionClaims.ts";
import { timelineVisibleArea } from "./timelineVisibleArea.ts";

/**
 * Tail-lift motion contract.
 *
 * A followed transcript that grows lifts the rows the reader can already see;
 * it never teleports them. The fresh-turn sheet keeps the reserved tail space
 * for the live turn, so an added row moves the
 * transcript up by exactly that row's height while the newest surface keeps its
 * reading level.
 *
 * Streaming growth arrives as many one- or two-pixel layout steps — the
 * ordinary tail follow already reads as smooth there. A discrete arrival (a
 * message, an activity group, a tool row) moves the transcript by tens of
 * pixels in one commit and is animated here.
 *
 * The FLIP keeps the scroll position canonical, exactly like the composer-to-
 * prompt lift in chatMotion: the precise tail scrollTop is written first, then
 * each visible row is translated back to its previous screen position and
 * released. No synthetic smooth-scroll runs against the reader-intent logic in
 * Timeline.tsx.
 */

/** Top-level timeline rows that take part in the lift. An open question is a
 *  trailing card like a pending approval: it hangs from the focus line toward
 *  the composer instead of being lifted onto it as the tail row. */
export const TIMELINE_LIFT_ROW_SELECTOR =
  ".msg:not(.question-open), .activity-group, .execution-row, .task-activity, .github-conflict-card, .pkg-harnesses-switch-marker";

/** Below this the movement is streaming growth, which is smoother untouched. */
export const TIMELINE_LIFT_MIN_PX = 24;

/** Long enough to read as motion, short enough that streaming catches up. */
export const TIMELINE_LIFT_DURATION_MS = 240;
/** Turn-end floor release: a longer, calmer glide into the composer edge. */
export const TIMELINE_SETTLE_DURATION_MS = 360;

const TIMELINE_LIFT_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
export const TIMELINE_SETTLE_EASE = "cubic-bezier(0.2, 0.8, 0.3, 1)";

/** The one running lift per row. */
const activeLifts = new Map<HTMLElement, { animation: Animation }>();

export interface TimelineLiftRow {
  element: HTMLElement;
  /** Row top before the tail scroll was written. */
  top: number;
}

/** Motion switches shared with chatMotion: reduced motion, reduced data,
 *  hidden tab and the desktop low-resource profile all disable the lift. */
export function timelineLiftMotionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The distance a committed layout change is worth animating. Ordinary follow
 * keeps shrinking deltas instant; explicit floor/revert releases may opt into
 * the same FLIP engine for a bounded downward glide. */
export function timelineLiftDistance(delta: number, options: { allowShrink?: boolean } = {}): number {
  if (!Number.isFinite(delta) || Math.abs(delta) < TIMELINE_LIFT_MIN_PX) return 0;
  if (delta < 0 && options.allowShrink !== true) return 0;
  return Math.abs(delta);
}

/** Rows the reader could see before the tail scroll was written, and one
 *  scrollport of rows on either side of them. A lift or a release glide
 *  carries those into view; left out, a row would appear at its final place
 *  at once, across the rows that are still travelling past it. Rows further
 *  away cannot reach the scrollport within one move. */
export function captureTimelineLiftRows(timeline: HTMLElement): TimelineLiftRow[] {
  const port = timelineVisibleArea(timeline);
  const rows: TimelineLiftRow[] = [];
  for (const child of Array.from(timeline.children)) {
    if (!(child instanceof HTMLElement) || !child.matches(TIMELINE_LIFT_ROW_SELECTOR)) continue;
    const rect = child.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= port.top - port.height || rect.top >= port.bottom + port.height) continue;
    rows.push({ element: child, top: rect.top });
  }
  return rows;
}

/** A row that entered in the commit it is lifted in keeps a single transform
 *  owner: the lift carries it from where it was inserted, and its chatMotion
 *  entrance continues as an opacity-only fade. */
function entranceToOpacity(element: HTMLElement): void {
  if (typeof element.getAnimations !== "function") return;
  for (const entrance of element.getAnimations()) {
    if (entrance.id !== TIMELINE_ENTRANCE_ANIMATION_ID || entrance.playState !== "running") continue;
    const timing = entrance.effect?.getComputedTiming();
    const remaining = Number(timing?.endTime ?? 0) - Number(timing?.localTime ?? 0);
    const opacity = Number.parseFloat(getComputedStyle(element).opacity);
    entrance.cancel();
    if (!(remaining > 0) || !(opacity < 1)) continue;
    const fade = element.animate([{ opacity }, { opacity: 1 }], { duration: remaining, easing: "linear", fill: "both" });
    void fade.finished.catch(() => undefined).finally(() => {
      if (fade.playState === "finished") fade.cancel();
    });
  }
}

/** FLIP the captured rows from their previous pixels to the canonical layout.
 *  A lift that starts while another is still moving a row supersedes it: the
 *  row travels from where it was captured (its visual position), never from a
 *  stale layout. `onSettled` runs once every started animation has finished,
 *  been cancelled or been superseded.
 *
 *  Only rows whose path crosses the scrollport move: a row that starts and
 *  ends outside it on the same side is never seen travelling, so it lands at
 *  once. Each moving row is its own compositing layer for the glide, and
 *  touch WebKit flashes blank or misplaced tiles when many layers appear in
 *  the commit that writes the scroll — fewer layers, fewer flashes. The
 *  running transform animation is composited by itself; no will-change is
 *  written, so no layer is forced before or kept after the glide. */
export function playTimelineLift(
  rows: readonly TimelineLiftRow[],
  onSettled?: () => void,
  options: { durationMs?: number; easing?: string } = {},
): boolean {
  const animations: Animation[] = [];
  const duration = options.durationMs ?? TIMELINE_LIFT_DURATION_MS;
  const easing = options.easing ?? TIMELINE_LIFT_EASE;
  let area: { top: number; bottom: number } | null = null;
  for (const row of rows) {
    const { element } = row;
    if (!element.isConnected || typeof element.animate !== "function") continue;
    const previous = activeLifts.get(element);
    if (previous) {
      activeLifts.delete(element);
      previous.animation.cancel();
    }
    // The scroll is already canonical, so measure the row's real travel rather
    // than trusting the caller's delta.
    if (Math.abs(row.top - element.getBoundingClientRect().top) < 1) continue;
    entranceToOpacity(element);
    // Cancelling the entrance removes its residual transform. Measure the
    // canonical position now, so the lift starts at the captured visual pixel.
    const rect = element.getBoundingClientRect();
    const delta = row.top - rect.top;
    if (Math.abs(delta) < 1) continue;
    if (area === null) {
      // The painted region, not the reading area: on phones the rows under
      // the floating island still show through its fading band.
      const timeline = element.parentElement;
      area = timeline ? timeline.getBoundingClientRect() : { top: -Infinity, bottom: Infinity };
    }
    const pathTop = Math.min(rect.top, row.top);
    const pathBottom = Math.max(rect.bottom, row.top + rect.height);
    if (pathBottom <= area.top || pathTop >= area.bottom) continue;
    const animation = element.animate([
      { transform: `translate3d(0, ${delta}px, 0)` },
      { transform: "translate3d(0, 0, 0)" },
    ], { duration, easing, fill: "both" });
    animations.push(animation);
    activeLifts.set(element, { animation });
    void animation.finished.catch(() => undefined).finally(() => {
      if (activeLifts.get(element)?.animation !== animation) return;
      activeLifts.delete(element);
      // Release the filled end state so it cannot outrank a later entrance.
      if (animation.playState === "finished") animation.cancel();
    });
  }
  if (animations.length === 0) return false;
  void Promise.allSettled(animations.map((animation) => animation.finished))
    .then(() => onSettled?.());
  return true;
}

/** True while a lift owns this row's transform. An entrance that starts later
 *  may only fade the row: a second transform would replace the lift and park
 *  the row at its final place while its neighbours are still travelling. */
export function timelineLiftOwns(element: HTMLElement): boolean {
  return activeLifts.has(element);
}

/** True while any lift still moves a row of this timeline. */
export function timelineLiftRunning(timeline: HTMLElement): boolean {
  for (const element of activeLifts.keys()) {
    if (timeline.contains(element)) return true;
  }
  return false;
}

/** Drop every running lift at once (rows land on their canonical layout).
 *  Used before a send, whose own FLIP measures untransformed rows. */
export function cancelTimelineLift(): void {
  for (const [element, { animation }] of activeLifts) {
    activeLifts.delete(element);
    animation.cancel();
  }
}
