// Long-poll wake-ups for HTTP clients (the `polyth` CLI) that cannot hold a
// WebSocket — over the control socket, or with a bearer token that is
// deliberately HTTP-only. A waiter is a hint, never data: after it resolves
// the route re-reads persisted history, so a missed or spurious wake can only
// cost one extra read, never an event.

export interface SessionEventWaiters {
  /** A persisted event was appended to this session. */
  event(sessionId: string): void;
  /** Some session projection (status, title, attention…) changed. */
  projection(): void;
  /** Resolve on the next event of `sessionId`, after `ms`, or on abort. */
  waitForEvent(sessionId: string, ms: number, signal?: AbortSignal): Promise<void>;
  /** Resolve on the next projection change, after `ms`, or on abort. */
  waitForProjection(ms: number, signal?: AbortSignal): Promise<void>;
  /** Pending waiters (diagnostics/tests). */
  size(): number;
  /** Release every waiter (server shutdown). */
  close(): void;
}

/** Longest single wait a client may ask for; proxies commonly cut ~60 s. */
export const MAX_LONG_POLL_MS = 30_000;

export function clampWaitMs(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error("waitMs must be a non-negative integer"), { code: "invalid-input" });
  }
  return Math.min(value, MAX_LONG_POLL_MS);
}

export function createSessionEventWaiters(): SessionEventWaiters {
  const bySession = new Map<string, Set<() => void>>();
  const anyProjection = new Set<() => void>();
  let closed = false;

  const park = (set: Set<() => void>, ms: number, signal: AbortSignal | undefined, onEmpty: () => void): Promise<void> => {
    if (closed || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        set.delete(done);
        onEmpty();
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  };
  const wake = (set: Set<() => void> | undefined): void => {
    if (!set) return;
    for (const done of [...set]) done();
  };

  return {
    event(sessionId) {
      wake(bySession.get(sessionId));
    },
    projection() {
      wake(anyProjection);
    },
    waitForEvent(sessionId, ms, signal) {
      let set = bySession.get(sessionId);
      if (!set) {
        set = new Set();
        bySession.set(sessionId, set);
      }
      const own = set;
      return park(own, ms, signal, () => {
        if (own.size === 0 && bySession.get(sessionId) === own) bySession.delete(sessionId);
      });
    },
    waitForProjection(ms, signal) {
      return park(anyProjection, ms, signal, () => {});
    },
    size() {
      let total = anyProjection.size;
      for (const set of bySession.values()) total += set.size;
      return total;
    },
    close() {
      closed = true;
      for (const set of bySession.values()) wake(set);
      wake(anyProjection);
      bySession.clear();
    },
  };
}
