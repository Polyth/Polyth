// Small, DOM-free gesture decisions shared by mobile surfaces. Components own
// pointer/touch lifecycle; these helpers only decide intent so vertical scroll
// is never mistaken for a destructive horizontal action.
export interface GesturePoint {
  x: number;
  y: number;
}

export const SESSION_SWIPE_REVEAL = 64;
export const BACK_SWIPE_DISTANCE = 72;
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

export function isEdgeBackSwipe(start: GesturePoint, end: GesturePoint): boolean {
  const distance = horizontalDistance(start, end, BACK_SWIPE_DISTANCE);
  return start.x <= BACK_SWIPE_EDGE && distance !== null && distance >= BACK_SWIPE_DISTANCE;
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
