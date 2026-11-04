// Timeline windowing: long sessions render only the last
// TIMELINE_WINDOW rows. The window is always a suffix — appends stay visible —
// and "Show earlier" grows it by chunks, while a jump to a hidden prompt grows
// it exactly far enough. Each append to a full window unmounts its oldest row:
// that moves the transcript from above, which the Timeline's reader anchor
// absorbs (foldLayoutShift), never a blank held below the tail. History that
// lands above the window keeps it on its first row (heldWindowStart); those
// rows mount in small chunks as the reader scrolls up to them. Pure math,
// presentation-only: the event log and the render model never change. Polyth
// folds tool runs into Worked groups, so the row count this window sees is
// already far below the raw event count.
export const TIMELINE_WINDOW = 150;
export const TIMELINE_CHUNK = 150;
export const LOW_RESOURCE_TIMELINE_WINDOW = 75;
/** Rows revealed at a time while the reader scrolls up toward the window's
 *  first row: small enough that a slow phone mounts them between two scroll
 *  gestures, large enough to stay a few screens ahead of the reader. */
export const TIMELINE_AUTO_CHUNK = 30;
/** How many of the window's first rows locate it again after history lands. */
export const TIMELINE_HEAD_KEYS = 3;

/** Low-resource desktop mode keeps fewer Markdown/tool subtrees mounted while
 * preserving the same suffix-window and reveal controls. */
export function initialTimelineWindow(lowResource = false): number {
  return lowResource ? LOW_RESOURCE_TIMELINE_WINDOW : TIMELINE_WINDOW;
}

/** Index of the first rendered row when the last `limit` of `total` rows show. */
export function windowStart(total: number, limit: number): number {
  return Math.max(0, total - Math.max(0, limit));
}

/** How many rows the window hides. */
export function hiddenCount(total: number, limit: number): number {
  return windowStart(total, limit);
}

/** Grow the window by one chunk, never past "everything". */
export function grownLimit(total: number, limit: number, chunk = TIMELINE_CHUNK): number {
  return Math.min(total, limit + chunk);
}

/** Smallest limit that makes row `index` visible; the current limit when it
 *  already is (or when the index is out of range). */
export function limitToInclude(total: number, limit: number, index: number): number {
  if (index < 0 || index >= total) return limit;
  return index >= windowStart(total, limit) ? limit : total - index;
}

/** Where the window's first row stands now, from the ids of the first rows it
 *  showed (in order). History that lands above can merge into the first row
 *  and re-key it (an activity block whose earlier steps arrive), so a later
 *  row locates the window too. Null when none of them is left. */
export function locateWindowHead(rowIds: readonly string[], headIds: readonly string[]): number | null {
  for (let offset = 0; offset < headIds.length; offset += 1) {
    const index = rowIds.indexOf(headIds[offset]!);
    if (index >= 0) return Math.max(0, index - offset);
  }
  return null;
}

/** The first rendered row. History that lands above the window (the
 *  background backfill after a session opens on its newest events, a page
 *  loaded from the server) never mounts by itself: the window keeps its first
 *  row, so nothing the reader sees moves, and no long main-thread mount runs
 *  under them. The held rows are revealed as the reader scrolls toward them.
 *  `held` keeps an earlier hold; `committedStart` is where the head stood in
 *  the last committed window, so a head that moved down means rows arrived
 *  above it. A full window (the natural start at or past the head) slides as
 *  before and drops the hold. */
export function heldWindowStart(input: {
  naturalStart: number;
  headIndex: number | null;
  committedStart: number;
  held: boolean;
}): number {
  const { naturalStart, headIndex } = input;
  if (headIndex === null || headIndex <= naturalStart) return naturalStart;
  return input.held || headIndex > input.committedStart ? headIndex : naturalStart;
}
