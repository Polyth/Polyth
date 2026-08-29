// Pure geometry for the prompt navigator tick tape (Timeline right rail).
// Mirrors the polyth PromptNavigatorRail mechanics: a bounded tape of at
// most MAX_TICKS thin ticks at a fixed pitch, widths that grow for the active
// turn and swell in a proximity wave around the cursor, and a window that
// keeps the active tick visible when there are more prompts than ticks.

export const RAIL_MAX_TICKS = 30;
export const RAIL_TICK_PITCH = 6;
export const RAIL_BASE_WIDTH = 10;
export const RAIL_ACTIVE_WIDTH = 14;
export const RAIL_CURSOR_WIDTH = 20;
export const RAIL_PANEL_ROWS = 8;
/** Wave strength by distance from the cursor tick (0 = under the cursor). */
export const RAIL_PROXIMITY_FALLOFF = [1, 0.6, 0.35, 0.15];

/** Slice of prompt indexes shown as ticks: the whole list when it fits,
 *  otherwise a MAX_TICKS window centered on the active prompt. */
export function railWindow(
  total: number,
  activeIndex: number,
  maxTicks: number = RAIL_MAX_TICKS,
): { start: number; end: number } {
  if (total <= maxTicks) return { start: 0, end: total };
  const centered = (activeIndex >= 0 ? activeIndex : total - 1) - Math.floor(maxTicks / 2);
  const start = Math.max(0, Math.min(centered, total - maxTicks));
  return { start, end: start + maxTicks };
}

/** Visual width of one tick, combining the active emphasis with the cursor
 *  proximity wave (the larger of the two wins). */
export function tickWidth(index: number, activeIndex: number, cursorIndex: number): number {
  let width = index === activeIndex ? RAIL_ACTIVE_WIDTH : RAIL_BASE_WIDTH;
  if (cursorIndex >= 0) {
    const distance = Math.abs(index - cursorIndex);
    const falloff = RAIL_PROXIMITY_FALLOFF[distance];
    if (falloff !== undefined) {
      const wave = RAIL_BASE_WIDTH + (RAIL_CURSOR_WIDTH - RAIL_BASE_WIDTH) * falloff;
      if (wave > width) width = wave;
    }
  }
  return Math.round(width);
}

/** Map a pointer offset (px from the top of the tape) to a tick index within
 *  the visible window; -1 when outside the tape. */
export function cursorTickIndex(offsetY: number, visibleCount: number, pitch: number = RAIL_TICK_PITCH): number {
  if (visibleCount <= 0 || offsetY < 0) return -1;
  const index = Math.floor(offsetY / pitch);
  return index >= visibleCount ? -1 : index;
}

/** Scroll-spy: which prompt is the "current turn" given each prompt row's top
 *  offset relative to the scroll container (null = row not rendered, i.e.
 *  windowed out above) and a reading line offset. The active prompt is the
 *  last one at or above the line; when every rendered prompt sits below it,
 *  the newest windowed-out prompt (just above the first rendered one) wins. */
export function activePromptIndex(tops: Array<number | null>, readingLine: number): number {
  let active = -1;
  let firstRendered = -1;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i];
    if (top === null || top === undefined) continue;
    if (firstRendered < 0) firstRendered = i;
    if (top <= readingLine) active = i;
  }
  if (active >= 0) return active;
  if (firstRendered > 0) return firstRendered - 1;
  return tops.length > 0 ? 0 : -1;
}
