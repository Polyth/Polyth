/**
 * Event-loop stall reporting.
 *
 * Every store and session read in this server is synchronous, so one slow
 * query, history parse or GC pause blocks all HTTP. Nothing can log while the
 * loop is blocked, but a timer that wakes up late knows how long it was held:
 * this records the stall once the loop runs again, so a stall that recovers on
 * its own (or one the supervisor's liveness watchdog kills) leaves evidence.
 */

/** Timer cadence; the expected wake-up time is measured against it. */
export const STALL_SAMPLE_MS = 500;
/** Lateness worth a warning. Below this, ordinary bursts and GC stay quiet. */
export const STALL_WARN_MS = 1_000;

export interface EventLoopStall {
  /** How long the loop was held beyond the scheduled wake-up. */
  blockedMs: number;
  /** When the loop ran again. */
  endedAt: number;
}

export interface EventLoopStallWatchOptions {
  report?: (stall: EventLoopStall) => void;
  now?: () => number;
  sampleMs?: number;
  warnMs?: number;
}

export function defaultStallReport(stall: EventLoopStall): void {
  const memory = process.memoryUsage();
  const mb = (bytes: number): number => Math.round(bytes / 1_048_576);
  console.warn(
    `[polyth] event loop blocked for ${(stall.blockedMs / 1000).toFixed(1)}s`
      + ` (resumed ${new Date(stall.endedAt).toISOString()}, rss=${mb(memory.rss)}MB heapUsed=${mb(memory.heapUsed)}MB)`,
  );
}

/** Start sampling; returns a disposer. The timer never holds the process open. */
export function watchEventLoopStalls(options: EventLoopStallWatchOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const sampleMs = options.sampleMs ?? STALL_SAMPLE_MS;
  const warnMs = options.warnMs ?? STALL_WARN_MS;
  const report = options.report ?? defaultStallReport;
  let expected = now() + sampleMs;
  const timer = setInterval(() => {
    const current = now();
    const blockedMs = current - expected;
    expected = current + sampleMs;
    if (blockedMs >= warnMs) report({ blockedMs, endedAt: current });
  }, sampleMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
