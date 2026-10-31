import type { SessionEvent } from "@polyth/contracts";

export const STREAM_INGEST_INTERVAL_MS = 100;
export const STREAM_INGEST_MAX_EVENTS = 256;
export const STREAM_INGEST_MAX_BYTES = 512 * 1024;

const STREAM_EVENT_TYPES = new Set([
  "assistant/chunk",
  "assistant/reasoning-chunk",
]);

export function isStreamingTextEvent(event: SessionEvent): boolean {
  return STREAM_EVENT_TYPES.has(event.type);
}

interface Scheduler {
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Pace only sustained text/reasoning. The first streamed event after a quiet
 * spell publishes immediately; later chunks share one store commit per window.
 * Any non-stream event is a barrier and flushes the pending text with itself.
 */
export function createEventIngestionBatcher(
  apply: (events: readonly SessionEvent[], liveKeys: ReadonlySet<string>) => void,
  scheduler: Scheduler = {},
) {
  const intervalMs = scheduler.intervalMs ?? STREAM_INGEST_INTERVAL_MS;
  const now = scheduler.now ?? Date.now;
  const setTimer = scheduler.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = scheduler.clearTimer ?? ((timer) => clearTimeout(timer));

  let pending: SessionEvent[] = [];
  let pendingBytes = 0;
  let pendingLiveKeys = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt: number | null = null;

  const cancelTimer = (): void => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const flush = (): void => {
    cancelTimer();
    if (pending.length === 0) return;
    const events = pending;
    const liveKeys = pendingLiveKeys;
    pending = [];
    pendingBytes = 0;
    pendingLiveKeys = new Set<string>();
    lastFlushAt = now();
    apply(events, liveKeys);
  };

  const pushLive = (event: SessionEvent): void => {
    // Timers may be throttled in a hidden tab. Capacity, not rAF/timer
    // punctuality, is the correctness bound for canonical ingestion.
    const bytes = JSON.stringify(event).length * 2;
    if (pending.length && pendingBytes + bytes > STREAM_INGEST_MAX_BYTES) flush();
    pending.push(event);
    pendingBytes += bytes;
    pendingLiveKeys.add(`${event.sessionId}:${event.seq}`);

    if (!isStreamingTextEvent(event) || pending.length >= STREAM_INGEST_MAX_EVENTS || pendingBytes >= STREAM_INGEST_MAX_BYTES) {
      flush();
      return;
    }

    const current = now();
    if (lastFlushAt === null || current - lastFlushAt >= intervalMs) {
      flush();
      return;
    }

    if (timer === null) {
      timer = setTimer(flush, Math.max(0, intervalMs - (current - lastFlushAt)));
    }
  };

  const pushReplay = (events: readonly SessionEvent[]): void => {
    flush();
    if (events.length > 0) apply(events, new Set<string>());
  };

  return {
    pushLive,
    pushReplay,
    flush,
    dispose: flush,
  };
}
