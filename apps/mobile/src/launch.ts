import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";

/**
 * The launch veil the web shell paints first (apps/web/src/index.html): brand
 * night with the 112px Polyth mark at the viewport centre. The native launch
 * screen draws the same picture, so the two can stand in for each other.
 * The web shell owns the element; the Connection Hub drives it through this
 * interface.
 */
export interface LaunchVeil {
  /** The veil is on screen (phone, touch or native boot). */
  readonly active: boolean;
  /** Resolves when the mark is decoded (bounded), so nothing hands over to a
   *  veil that would still paint without its mark. */
  ready(): Promise<void>;
  /** A long wait: let the mark breathe and show one quiet status line. */
  wait(status?: string | null): void;
  setStatus(status: string | null): void;
  /** Lift the veil. `into` names an element showing the same mark (the hub's
   *  brand mark): the veil's mark flies onto it instead of dissolving. */
  lift(options?: { into?: Element | null }): Promise<void>;
  /** Bring a lifted veil back before the page is left. `from` names the
   *  element the mark flies back from (the reverse of `lift({ into })`). */
  restore(options?: { from?: Element | null }): Promise<void>;
}

/** A launch curtain stays up at most this long without a page lifting it. */
export const LAUNCH_CURTAIN_SAFETY_MS = 10_000;
/** A page's own cover (its veil coming back) may take this long before it leaves anyway. */
const LEAVE_COVER_BUDGET_MS = 700;

function nativeShell(): "ios" | "android" | null {
  if (!Capacitor.isNativePlatform()) return null;
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : null;
}

/**
 * Lift the native launch screen. Call it once the web veil is painted: the
 * veil underneath is pixel-identical, so the hand-over is invisible. Safe to
 * call when nothing is shown.
 */
export async function releaseLaunchCurtain(options: { fadeOutMs?: number } = {}): Promise<void> {
  const shell = nativeShell();
  if (!shell) return;
  // Android's launch splash exits with its configured fade; a per-call
  // duration only earns a plugin warning there.
  await SplashScreen.hide(shell === "ios" ? { fadeOutDuration: options.fadeOutMs ?? 150 } : undefined)
    .catch(() => undefined);
}

/**
 * Cover a page swap (Connection Hub → Link bootstrap → workspace, or back)
 * with the native launch screen so no intermediate document can paint. The
 * next page lifts it once its own veil is up. iOS only: its `show()` re-presents
 * the launch storyboard, the veil's exact twin. Android re-shows a different,
 * inset legacy view, so there the WebView's brand background and the
 * bootstrap page's own veil carry the swap instead.
 */
export async function raiseLaunchCurtain(options: { fadeInMs?: number } = {}): Promise<boolean> {
  if (nativeShell() !== "ios") return false;
  const fadeInMs = Math.max(0, options.fadeInMs ?? 0);
  // With autoHide the plugin resolves only after the safety timeout, so the
  // call is not awaited; it is in place long before the next page commits.
  void SplashScreen.show({
    fadeInDuration: fadeInMs,
    autoHide: true,
    showDuration: LAUNCH_CURTAIN_SAFETY_MS,
  }).catch(() => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, fadeInMs + 34));
  return true;
}

let leaveCover: (() => Promise<void>) | null = null;

/** The web shell registers how its page brings the veil back before it is left. */
export function setLaunchLeaveCover(cover: (() => Promise<void>) | null): void {
  leaveCover = cover;
}

/**
 * Before the native shell swaps documents: bring the page's veil back (bounded
 * — leaving never waits on an animation that cannot run), then raise the
 * native curtain over the swap.
 */
export async function coverPageForLeave(): Promise<void> {
  if (!nativeShell()) return;
  const cover = leaveCover;
  if (cover) {
    await Promise.race([
      cover().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, LEAVE_COVER_BUDGET_MS)),
    ]);
  }
  await raiseLaunchCurtain();
}
