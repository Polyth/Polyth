// Whether Polyth's own navigation swipes (phone shell, package Back, tablet
// drawer, phone Settings) may run at all in this host.
//
// The phone shell's edge and surface swipes exist only in the installed app.
// Opened in a phone browser, the same drag belongs to the browser first: Safari
// and Chrome claim a drag that starts at the screen edge to navigate back, and
// the app can neither see the outcome nor keep the two apart. When the host
// already owns that gesture, Polyth stands down entirely rather than fighting
// it for the touch. The installed Capacitor app (and a standalone install with
// no browser chrome) owns its gestures, so swipes stay there as before.
//
// The decision is capability-based, not device-sniffed: a coarse-pointer web
// host is a browser whose native gesture the page cannot pre-empt. Desktop and
// fine-pointer browsers keep the tablet drawer's swipe (there is no competing
// system gesture), and `isNativeMobile()` is the single native-app signal the
// rest of the shell already uses.
import { isNativeMobile } from "@polyth/mobile/runtime";

/** A touch-capable host — the browser gesture layer that conflicts with ours. */
const COARSE_POINTER_QUERY = "(any-pointer: coarse)";

/**
 * Whether this host has its own touch gesture over the screen edge. True in
 * every coarse-pointer web browser, false in the installed app and on a
 * fine-pointer desktop browser.
 */
export function hostOwnsEdgeGestures(input: {
  nativeApp: boolean;
  coarsePointer: boolean;
}): boolean {
  return !input.nativeApp && input.coarsePointer;
}

function coarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** Live host capability at the moment a gesture would start. */
export function swipeGesturesAvailable(): boolean {
  return !hostOwnsEdgeGestures({ nativeApp: isNativeMobile(), coarsePointer: coarsePointer() });
}
