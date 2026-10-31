// The software keyboard's real slide, as reported by a native shell.
//
// `--motion-keyboard` / `--motion-keyboard-ease` (tokens.css) are a fixed
// guess at the iOS keyboard (250 ms on one bezier). UIKit actually moves the
// keyboard on a private spring whose length differs per OS and device, so a
// composer riding on the guess runs ahead of or behind it. The iOS app replays
// the keyboard's curve on a probe view and reports the resulting Core Animation
// (a spring, or a bezier) with every keyboard move. This module:
//
// - turns it into a duration and an easing (a CSS `linear()` sampled from the
//   spring) that keyboardMotion() (motionPresence.ts) hands to every script
//   that rides the keyboard — the compositor ride of the docks and transcript
//   (keyboardRide.ts), the composer morph (composerMorph.ts) — and that the
//   long-draft editor cap's transition (mobileViewport.css) is re-timed to.
//   Kept in memory, never written to <html>: a custom property written there
//   restyles every element of the app, which is a stall at the very moment
//   the keyboard sets off;
// - catches up the bridge's delivery delay: animations that ride the keyboard
//   are advanced to where the keyboard already is, and a motion report that
//   arrives after its keyboard event retimes animations already under way.
//
// Without a report (browsers, Android, older app builds) nothing changes.

/** One keyboard move as reported by the native shell. Times in ms. */
export interface NativeKeyboardMotion {
  /** UIKit's nominal animation duration. */
  durationMs: number;
  /** The Core Animation's real active duration, when the curve was sampled. */
  animationDurationMs?: number;
  spring?: { mass: number; stiffness: number; damping: number; initialVelocity: number };
  bezier?: [number, number, number, number];
  /** Wall-clock (Date.now()) time the native layer sent the report. */
  sentAt?: number;
}

export interface KeyboardMotionTiming {
  duration: number;
  easing: string;
}

/** Id carried by scripted animations that ride the keyboard (composer morph). */
export const KEYBOARD_RIDE_ANIMATION_ID = "keyboard-ride";

/** Properties whose CSS transitions ride the keyboard (mobileViewport.css):
 *  only the long-draft editor cap. The frame and the docks never transition —
 *  keyboardRide.ts moves them on the compositor and re-times itself. */
const RIDING_TRANSITIONS = new Set(["max-height"]);
const RIDING_TARGETS = ".composer-mobile .composer-card textarea";
/** Larger gaps are a clock jump or a stale report, not bridge delay. A ride
 *  that starts after a stall of the page still catches up with the keyboard
 *  up to its whole length (the rides clamp to their duration). */
const MAX_CATCH_UP_MS = 1000;
/** A report this old no longer describes the move being started. */
const REPORT_FRESH_MS = 400;
const SPRING_SAMPLES = 48;
const MIN_DURATION_MS = 50;
const MAX_DURATION_MS = 2000;

let latest: { motion: NativeKeyboardMotion; receivedAt: number } | null = null;
/** The keyboard's last reported timing: it outlives its move, as the next
 *  keyboard move almost always runs the same curve. */
let reported: KeyboardMotionTiming | null = null;

/** The keyboard's real slide, once a native shell has reported one. */
export function reportedKeyboardTiming(): KeyboardMotionTiming | null {
  return reported;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Displacement from the target of a unit spring released at 1 (CASpringAnimation's model). */
function springDisplacement(spring: NonNullable<NativeKeyboardMotion["spring"]>, t: number): number {
  const { mass, stiffness, damping, initialVelocity } = spring;
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const velocity = -initialVelocity;
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const b = (velocity + zeta * omega) / omegaD;
    return Math.exp(-zeta * omega * t) * (Math.cos(omegaD * t) + b * Math.sin(omegaD * t));
  }
  if (zeta === 1) return (1 + (velocity + omega) * t) * Math.exp(-omega * t);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  const c2 = (velocity - r1) / (r2 - r1);
  return (1 - c2) * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
}

/** A CSS `linear()` easing that traces the spring over `durationMs`; Core
 *  Animation ends the spring at its duration, so the last stop is exactly 1. */
export function springEasing(spring: NonNullable<NativeKeyboardMotion["spring"]>, durationMs: number): string | null {
  const { mass, stiffness, damping, initialVelocity } = spring;
  if (![mass, stiffness, damping, initialVelocity, durationMs].every(finite)) return null;
  if (mass <= 0 || stiffness <= 0 || damping < 0 || durationMs <= 0) return null;
  const stops: string[] = ["0"];
  for (let i = 1; i < SPRING_SAMPLES; i += 1) {
    const progress = 1 - springDisplacement(spring, (durationMs / 1000) * (i / SPRING_SAMPLES));
    if (!Number.isFinite(progress)) return null;
    stops.push(String(Math.round(progress * 10000) / 10000));
  }
  stops.push("1");
  return `linear(${stops.join(", ")})`;
}

function linearEasingSupported(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    && CSS.supports("transition-timing-function", "linear(0, 1)");
}

/** The tokens a report resolves to, or null when it carries nothing usable. */
export function keyboardMotionTiming(motion: NativeKeyboardMotion, linearSupported = linearEasingSupported()): KeyboardMotionTiming | null {
  const duration = finite(motion.animationDurationMs) && motion.animationDurationMs > 0
    ? motion.animationDurationMs
    : motion.durationMs;
  if (!finite(duration) || duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) return null;
  let easing: string | null = null;
  if (motion.spring && linearSupported) easing = springEasing(motion.spring, duration);
  else if (motion.bezier && motion.bezier.length === 4 && motion.bezier.every(finite)) {
    const [x1, y1, x2, y2] = motion.bezier;
    if (x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1) easing = `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
  }
  if (!easing) return null;
  return { duration: Math.round(duration), easing };
}

function ridingAnimations(): Animation[] {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return [];
  return document.getAnimations().filter((animation) => {
    if (animation.id === KEYBOARD_RIDE_ANIMATION_ID) return true;
    const property = (animation as Animation & { transitionProperty?: string }).transitionProperty;
    if (!property || !RIDING_TRANSITIONS.has(property)) return false;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element && target.matches(RIDING_TARGETS);
  });
}

/** How far the keyboard has already travelled when its report is handled. */
function keyboardElapsedMs(now: number): number {
  const sentAt = latest?.motion.sentAt;
  if (!latest || now - latest.receivedAt > REPORT_FRESH_MS || !finite(sentAt)) return 0;
  const elapsed = Date.now() - sentAt;
  return elapsed > 0 && elapsed <= MAX_CATCH_UP_MS ? elapsed : 0;
}

/** How far the keyboard has already travelled now, from the freshest report
 *  (0 without one): the bridge's delivery delay a ride starting now catches up. */
export function keyboardMoveElapsedMs(now = performance.now()): number {
  return keyboardElapsedMs(now);
}

/** Retime animations that ride the keyboard to its reported curve and advance
 *  them to where the keyboard already is. Animations further along than the
 *  keyboard (a morph that began on focus) are left where they are. */
export function syncKeyboardRiders(now = performance.now()): void {
  if (!latest || now - latest.receivedAt > REPORT_FRESH_MS) return;
  const timing = keyboardMotionTiming(latest.motion);
  const elapsed = keyboardElapsedMs(now);
  for (const animation of ridingAnimations()) {
    try {
      if (timing) animation.effect?.updateTiming({ duration: timing.duration, easing: timing.easing });
      const current = typeof animation.currentTime === "number" ? animation.currentTime : 0;
      // A start time on the timeline's own clock, not a currentTime measured
      // against the last frame: the rider shows where the keyboard is now.
      if (elapsed > current) animation.startTime = now - elapsed;
    } catch {
      // A transition the engine will not retime keeps its own timing.
    }
  }
}

/** Record a keyboard move's real timing (see top). mobileViewport.ts owns
 *  the seam and the resync. */
export function recordNativeKeyboardMotion(motion: NativeKeyboardMotion): void {
  latest = { motion, receivedAt: performance.now() };
  const timing = keyboardMotionTiming(motion);
  if (timing) reported = timing;
}

/** Test seam. */
export function resetNativeKeyboardMotion(): void {
  latest = null;
  reported = null;
}
