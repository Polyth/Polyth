import { JudgmentExecutionError } from "./errors.ts";

export function createDeadline(timeoutMs: number, parents: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  let reason: "cancelled" | "timeout" = "cancelled";
  const cancel = () => { if (!controller.signal.aborted) { reason = "cancelled"; controller.abort(); } };
  for (const parent of parents) {
    if (parent?.aborted) cancel();
    else parent?.addEventListener("abort", cancel, { once: true });
  }
  const expire = () => { if (!controller.signal.aborted) { reason = "timeout"; controller.abort(); } };
  const timer = setTimeout(expire, timeoutMs);
  return {
    signal: controller.signal,
    reason: () => reason,
    expire,
    dispose() { clearTimeout(timer); for (const parent of parents) parent?.removeEventListener("abort", cancel); },
  };
}
export function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new JudgmentExecutionError("cancelled"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new JudgmentExecutionError("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
