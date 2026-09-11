// UX-MOBILE-01 §36: bounded native haptics for consequential touch actions.
// Unsupported platforms (notably iOS Safari) simply get nothing. Haptics are
// independent from motion preferences; never use this for hover, scroll,
// typing, replay, or streaming.
export type HapticKind = "selection" | "tap" | "success" | "warning" | "error";
export const NATIVE_HAPTIC_EVENT = "polyth:native-haptic";

const PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 5,
  tap: 8,
  success: [8, 32, 8],
  warning: [12, 42, 12],
  error: [18, 34, 18],
};

export function hapticFeedback(kind: HapticKind = "tap"): void {
  if (typeof window !== "undefined"
    && typeof document !== "undefined"
    && /^(?:android|ios)$/.test(document.body?.dataset.nativePlatform ?? "")) {
    window.dispatchEvent(new CustomEvent(NATIVE_HAPTIC_EVENT, { detail: kind }));
    return;
  }
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // A vibration is never worth an error.
  }
}

export function selectionFeedback(): void {
  hapticFeedback("selection");
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
