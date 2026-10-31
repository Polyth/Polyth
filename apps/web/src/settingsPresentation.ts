// Which edge phone Settings arrives from — and therefore which way it leaves
// and which way a swipe dismisses it. Presentation only: nothing here is
// persisted or model-visible.
//
// Opened from the Navigator, Settings takes the Navigator's place on the
// inline-start side: it slides in from there and a swipe toward that edge
// closes it, exactly like the Navigator. Opened from anywhere else it is a
// pushed destination: in from the inline-end edge, out by Back or a swipe
// toward the inline end.

export type SettingsOrigin = "start" | "end";

let next: SettingsOrigin = "end";

/** Name the edge the next Settings opening arrives from (read once, then reset). */
export function presentSettingsFrom(origin: SettingsOrigin): void {
  next = origin;
}

/** The edge this opening arrives from; later openings default to the inline end. */
export function takeSettingsOrigin(): SettingsOrigin {
  const origin = next;
  next = "end";
  return origin;
}

/**
 * Native Back (Android) while Settings is open: Settings steps back one level
 * itself when it can (a phone page back to its list) and reports whether it
 * did; otherwise Back closes it. Registered by the open SettingsView.
 */
let backHandler: (() => boolean) | null = null;

export function setSettingsBackHandler(handler: (() => boolean) | null): void {
  backHandler = handler;
}

/** Let open Settings take one step back; false when there is no step left inside it. */
export function stepSettingsBack(): boolean {
  return backHandler?.() ?? false;
}
