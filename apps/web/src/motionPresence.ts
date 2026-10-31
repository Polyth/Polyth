import { reportedKeyboardTiming } from "./keyboardMotion.ts";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** One composited frame of slack after the CSS duration, never a visible wait. */
const SURFACE_EXIT_TAIL_MS = 34;

/** Duration tokens a presentation-only exit (or a scripted motion) can wait on. */
export type MotionDurationToken = "--motion-normal" | "--motion-surface" | "--motion-stack" | "--motion-keyboard";

const MOTION_FALLBACK_MS: Record<MotionDurationToken, number> = {
  "--motion-normal": 180,
  "--motion-surface": 240,
  "--motion-stack": 300,
  "--motion-keyboard": 250,
};

export function parseCssDurationMs(value: string): number | null {
  const raw = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "s" ? amount * 1000 : amount;
}

/** Honours the OS preference, the in-app reduce-animations setting and low-resource desktop mode. */
export function motionIsReduced(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The CSS duration a token resolves to right now (0 when motion is reduced). */
export function motionDurationMs(token: MotionDurationToken = "--motion-surface"): number {
  if (motionIsReduced()) return 0;
  const root = document.documentElement;
  if (typeof globalThis.getComputedStyle !== "function") return MOTION_FALLBACK_MS[token];
  const configured = parseCssDurationMs(globalThis.getComputedStyle(root).getPropertyValue(token));
  return configured ?? MOTION_FALLBACK_MS[token];
}

const KEYBOARD_EASE_FALLBACK = "cubic-bezier(0.38, 0.7, 0.125, 1)";

/** The keyboard's slide for scripted motion that must travel with it: its
 *  real curve once a native shell reported one (keyboardMotion.ts), else the
 *  `--motion-keyboard` / `--motion-keyboard-ease` tokens; duration 0 when
 *  motion is reduced. */
export function keyboardMotion(): { duration: number; easing: string } {
  if (motionIsReduced()) return { duration: 0, easing: KEYBOARD_EASE_FALLBACK };
  const reported = reportedKeyboardTiming();
  if (reported) return { duration: reported.duration, easing: reported.easing };
  const duration = motionDurationMs("--motion-keyboard");
  if (duration === 0 || typeof globalThis.getComputedStyle !== "function") {
    return { duration, easing: KEYBOARD_EASE_FALLBACK };
  }
  const easing = globalThis.getComputedStyle(document.documentElement)
    .getPropertyValue("--motion-keyboard-ease").trim();
  return { duration, easing: easing || KEYBOARD_EASE_FALLBACK };
}

export function surfaceMotionDurationMs(): number {
  return motionDurationMs("--motion-surface");
}

/** Travel time of a full-screen phone layer (push, pop, dismissal). */
export function stackMotionDurationMs(): number {
  return motionDurationMs("--motion-stack");
}

/**
 * Keep a presentation-only surface mounted until its exit finishes. Returns a
 * cancellation function so a reopen, replacement, or unmount wins immediately.
 * `token` selects which CSS duration the exit is paced by: surfaces use
 * `--motion-surface`, full-screen phone layers use `--motion-stack`.
 */
export function scheduleSurfaceExit(
  done: () => void,
  token: MotionDurationToken = "--motion-surface",
): () => void {
  const duration = motionDurationMs(token);
  if (duration <= 0) {
    done();
    return () => {};
  }
  const timer = setTimeout(done, duration + SURFACE_EXIT_TAIL_MS);
  return () => clearTimeout(timer);
}
