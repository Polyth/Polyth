// The iOS PolythKeyboardMotion plugin's report of one keyboard move (see
// SceneDelegate.swift), narrowed to the plain numbers it documents before the
// web shell sees it (apps/web/src/keyboardMotion.ts).

/** One keyboard move's timing from the iOS PolythKeyboardMotion plugin. Times in ms. */
export interface NativeKeyboardMotion {
  durationMs: number;
  animationDurationMs?: number;
  spring?: { mass: number; stiffness: number; damping: number; initialVelocity: number };
  bezier?: [number, number, number, number];
  sentAt?: number;
}

export interface KeyboardMotionEvent {
  duration?: unknown;
  animationDuration?: unknown;
  spring?: unknown;
  bezier?: unknown;
  sentAt?: unknown;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Accept only the plain numbers the plugin documents; anything else is dropped. */
export function normalizeKeyboardMotion(event: KeyboardMotionEvent | null | undefined): NativeKeyboardMotion | null {
  const durationMs = finiteNumber(event?.duration);
  if (durationMs === undefined || durationMs <= 0) return null;
  const motion: NativeKeyboardMotion = { durationMs };
  const animationDurationMs = finiteNumber(event?.animationDuration);
  if (animationDurationMs !== undefined && animationDurationMs > 0) motion.animationDurationMs = animationDurationMs;
  const sentAt = finiteNumber(event?.sentAt);
  if (sentAt !== undefined) motion.sentAt = sentAt;
  const spring = event?.spring as Record<string, unknown> | null | undefined;
  if (spring && typeof spring === "object") {
    const mass = finiteNumber(spring.mass);
    const stiffness = finiteNumber(spring.stiffness);
    const damping = finiteNumber(spring.damping);
    const initialVelocity = finiteNumber(spring.initialVelocity) ?? 0;
    if (mass !== undefined && stiffness !== undefined && damping !== undefined) {
      motion.spring = { mass, stiffness, damping, initialVelocity };
    }
  }
  const bezier = event?.bezier;
  if (!motion.spring && Array.isArray(bezier) && bezier.length === 4) {
    const points = bezier.map(finiteNumber);
    if (points.every((point) => point !== undefined)) motion.bezier = points as [number, number, number, number];
  }
  return motion;
}
