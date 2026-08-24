// Light haptic feedback for phone taps (UX-MOBILE-01). One short pulse — the
// confirmation channel for touch pickers where hover feedback doesn't exist.
// No-ops silently where the Vibration API is missing (desktop, iOS Safari).

export function tapFeedback(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(10);
  } catch {
    // Some browsers throw when vibration is blocked by permissions policy.
  }
}
