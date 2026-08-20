// Timeline windowing (L13, OC-02-011): long sessions render only the last
// TIMELINE_WINDOW rows. The window is always a suffix — appends stay visible
// and follow-scroll works unchanged — and "Show earlier" grows it by chunks,
// while a jump to a hidden prompt grows it exactly far enough. Pure math,
// presentation-only: the event log and the render model never change. Polyth
// folds tool runs into Worked groups, so the row count this window sees is
// already far below the raw event count.
export const TIMELINE_WINDOW = 150;
export const TIMELINE_CHUNK = 150;

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
