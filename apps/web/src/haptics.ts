// UX-MOBILE-01 §36: bounded native haptics for consequential touch actions.
// Unsupported platforms (notably iOS Safari) and users who asked for reduced
// motion simply get nothing. Never used for hover, scroll, or typing.
export type HapticKind = "tap" | "success" | "warning" | "error";

const PATTERNS: Record<HapticKind, number | number[]> = {
  tap: 8,
  success: [8, 32, 8],
  warning: [12, 42, 12],
  error: [18, 34, 18],
};

export function hapticFeedback(kind: HapticKind = "tap"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // A vibration is never worth an error.
  }
}

export function tapFeedback(): void {
  hapticFeedback("tap");
}

export function successFeedback(): void {
  hapticFeedback("success");
}

export function warningFeedback(): void {
  hapticFeedback("warning");
}

export function errorFeedback(): void {
  hapticFeedback("error");
}
