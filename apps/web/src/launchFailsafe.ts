// What a launch does when its page never rendered: the app graph failed to
// load, or boot is stuck on a read that never answers (a Link round trip to
// /api/auth/status has no deadline). The veil must not stay up forever, and
// lifting it onto the empty #root is no better: on the phone app that is a
// blank white page with nothing on it to tap. The inline copy of this rule
// in index.html covers a page whose scripts never ran at all.

/** How long a page may stay unrendered behind its veil. */
export const UNRENDERED_LAUNCH_MS = 15_000;

/** The bundled hub reloads itself at most this often before it gives up. */
export const UNRENDERED_RELOAD_WINDOW_MS = 60_000;

/** sessionStorage key: when the bundled hub last reloaded for this reason. */
export const UNRENDERED_RELOAD_KEY = "polyth.launch.unrendered-reload-at";

export type UnrenderedLaunchFallback = "hub" | "reload" | "lift";

export function unrenderedLaunchFallback(page: {
  /** The Capacitor phone app (not a phone browser, not the desktop app). */
  native: boolean;
  /** The page came from the app's local Polyth Link proxy (127.0.0.1). */
  loopback: boolean;
  lastReloadAt: number | null;
  now: number;
}): UnrenderedLaunchFallback {
  if (!page.native) return "lift";
  // The open server's page: the Connection Hub opens that server again over a
  // fresh connection (`?resume=1`). It does so at most once a minute
  // (RESUME_COOLDOWN_MS), then stays on its server list, so this cannot loop.
  if (page.loopback) return "hub";
  // The bundled hub itself has nowhere to go back to: one reload from behind
  // the veil, then whatever is underneath.
  if (page.lastReloadAt == null || page.now - page.lastReloadAt >= UNRENDERED_RELOAD_WINDOW_MS) return "reload";
  return "lift";
}
