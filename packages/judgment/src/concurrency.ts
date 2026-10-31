import { JudgmentExecutionError } from "./errors.ts";

export interface JudgmentConcurrency { acquire(signal: AbortSignal): Promise<() => void> }
export interface JudgmentConcurrencyController extends JudgmentConcurrency { setLimit(limit: number): void }
/** FIFO. A timed-out adapter retains its slot until its actual promise settles. */
export function createJudgmentConcurrency(maxConcurrent: number): JudgmentConcurrencyController {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError("Invalid Judgment concurrency");
  let active = 0;
  const queue: Array<() => void> = [];
  const drain = () => { while (active < maxConcurrent && queue.length) queue.shift()!(); };
  return {
    setLimit(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid Judgment concurrency");
      maxConcurrent = limit;
      drain();
    },
    acquire(signal) {
      return new Promise((resolve, reject) => {
        const abort = () => {
          const at = queue.indexOf(grant);
          if (at >= 0) queue.splice(at, 1);
          signal.removeEventListener("abort", abort);
          reject(new JudgmentExecutionError("cancelled"));
        };
        const grant = () => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) { abort(); return; }
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            drain();
          });
        };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        if (active < maxConcurrent) grant(); else queue.push(grant);
      });
    },
  };
}
