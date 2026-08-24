// UX-MOBILE-01 §36: a short confirmation buzz for consequential touch
// selections — model, mode, starter, send. Deliberately tiny and total:
// unsupported platforms (notably iOS Safari) and users who asked for reduced
// motion simply get nothing. Never used for hover, scroll, or typing.
export function tapFeedback(pattern: number | number[] = 8): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // A vibration is never worth an error.
  }
}
