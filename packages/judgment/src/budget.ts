import type { JudgmentBudget } from "./types.ts";
import { JudgmentExecutionError } from "./errors.ts";

export interface JudgmentBudgetReservation { release(elapsedMs: number): void; cancel(): void }
export interface JudgmentBudgetPool {
  reserve(inputBytes: number, wallClockMs: number): JudgmentBudgetReservation;
  snapshot(): { calls: number; inputBytes: number; wallClockMs: number; reservedWallClockMs: number };
}
/** Share this exact pool across runtimes/children to enforce one workflow-tree budget. */
export function createJudgmentBudget(limits: JudgmentBudget): JudgmentBudgetPool {
  for (const n of Object.values(limits)) {
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("Invalid Judgment budget");
  }
  const cap = { ...limits };
  let calls = 0, inputBytes = 0, wallClockMs = 0, reservedWallClockMs = 0;
  return {
    reserve(bytes, ms) {
      if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(ms) || ms < 0
        || calls + 1 > cap.maxCalls || inputBytes + bytes > cap.maxInputBytes
        || wallClockMs + reservedWallClockMs + ms > cap.maxWallClockMs) {
        throw new JudgmentExecutionError("budget-exhausted");
      }
      calls++; inputBytes += bytes; reservedWallClockMs += ms;
      let released = false;
      return { cancel() {
        if (released) return;
        released = true;
        calls--; inputBytes -= bytes; reservedWallClockMs -= ms;
      }, release(elapsed) {
        if (released) return;
        released = true;
        reservedWallClockMs -= ms;
        wallClockMs += Math.min(ms, Math.max(0, elapsed));
      } };
    },
    snapshot: () => ({ calls, inputBytes, wallClockMs, reservedWallClockMs }),
  };
}
