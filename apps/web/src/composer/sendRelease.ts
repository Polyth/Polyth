// Whether lifting a finger sends. Touch Send is admitted on pointerup, so this
// decides what a click normally would: the press the browser gave to Send
// sends unless the finger left Send before lifting.
//
// The drawn disc is not the target. Send's touch box reaches past the disc
// (its `::after`, `--hit-min`), and the browser also gives Send a press that
// lands a few pixels outside that box. A release judged against the disc alone
// swallowed every tap on that outer ring: Send looked pressed and did nothing.

/** A finger that travelled no further than this did not slide anywhere: the
 *  tap sends wherever the browser let it land. Below the platform's own pan
 *  threshold, past which the gesture is cancelled rather than released. */
export const SEND_TAP_SLOP_PX = 10;

export interface SendRelease {
  /** Where the press began, when known. */
  down: { x: number; y: number } | null;
  up: { x: number; y: number };
  /** The control's drawn box. */
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** The release is over the control's own hit area (hit-tested, so it counts
   *  the touch box past the drawn edge); `null` when it cannot be told. */
  overControl: boolean | null;
}

export function releaseSends({ down, up, rect, overControl }: SendRelease): boolean {
  // No layout to judge by (a detached or unrendered control): a release is a tap.
  if (rect.width === 0 && rect.height === 0) return true;
  if (down && Math.hypot(up.x - down.x, up.y - down.y) <= SEND_TAP_SLOP_PX) return true;
  if (overControl) return true;
  return up.x >= rect.left && up.x <= rect.right && up.y >= rect.top && up.y <= rect.bottom;
}
