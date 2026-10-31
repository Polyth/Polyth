/** A signal that aborts after `ms`, bounding a read that must not wait forever
 *  on a stalled connection. The native app's iOS 15 WebView lacks
 *  `AbortSignal.timeout`; there a plain timer aborts instead. */
export function deadlineSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  // Same reason AbortSignal.timeout carries, so a deadline stays
  // distinguishable from a deliberate cancel where the engine keeps the reason.
  setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return controller.signal;
}
