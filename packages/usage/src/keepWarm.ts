// Keep one chat's prompt cache warm for a period the person chose from the
// composer's context card. Keep-alives are as rare as the cache allows: each
// is sent just before the cache would lapse, never while the chat is working
// (its own requests keep the cache warm), never once the cache outlives the
// period by itself, and never to re-warm a cache that already went cold.
// Browser-safe planner; the controller runs on the server.
import type { SessionCacheFacts } from "./analytics/sessionCache.ts";

/** Same text as the Judgment keep-warm use, so every consumer recognizes it. */
export const KEEP_ALIVE_PROMPT =
  "Automatic keep-alive from Polyth to keep this conversation's prompt cache warm. Do nothing; reply with just: OK";

/** Periods the context card offers, in minutes. */
export const KEEP_WARM_PERIODS = [30, 60, 120, 240, 480] as const;
export const KEEP_WARM_MAX_MINUTES = 480;

const SECOND = 1_000;
/** A keep-alive whose response never shows up in the cache facts by then failed. */
export const PING_SETTLE_MS = 3 * 60 * SECOND;
/** A short "OK" keep-alive usually round-trips within this. */
const TYPICAL_PING_MS = 5 * SECOND;
/** Recheck cadence while a cold cache waits for the person's next turn, or a busy chat. */
const COLD_RECHECK_MS = 60 * SECOND;
const BUSY_RECHECK_MS = 5 * SECOND;
/** A warm cache reads at least this share of the prefix the previous request left. */
const MISS_READ_SHARE = 0.5;
/** Consecutive misses after which pinging evidently does not reach the cache. */
const MAX_MISSES = 2;

/**
 * How long before expiry to send. A cache timer restarts when a request
 * starts, but usage is observed when its response ends, so the estimate runs
 * late by that response's generation time. After our own keep-alive that time
 * is measured (a short "OK"): twice it plus 10 s, 20–60 s. After a person's
 * turn its last answer may have streamed for a while: 90 s. Never more than
 * a third of the lifetime.
 */
export function keepAliveLeadMs(ttlMs: number, afterPing: boolean, latencyMs?: number): number {
  const lead = afterPing
    ? Math.min(60 * SECOND, Math.max(20 * SECOND, 2 * (latencyMs ?? 20 * SECOND) + 10 * SECOND))
    : 90 * SECOND;
  return Math.min(lead, Math.floor(ttlMs / 3));
}

/**
 * Keep-alives a period needs. A cold cache is counted from the person's next
 * turn (assumed now), since nothing is sent before it.
 */
export function estimateKeepAlives(health: { lastActivityAt: number; ttlMs: number | null }, until: number, now: number): number | null {
  const ttl = health.ttlMs;
  if (ttl === null) return null;
  const expiresAt = (health.lastActivityAt + ttl <= now ? now : health.lastActivityAt) + ttl;
  if (expiresAt >= until) return 0;
  // First at expiry minus the after-turn lead, then one per (ttl − lead) until
  // the last one's cache reaches the end of the period.
  const firstAt = expiresAt - keepAliveLeadMs(ttl, false);
  const interval = ttl - keepAliveLeadMs(ttl, true, TYPICAL_PING_MS);
  return Math.max(1, Math.ceil((until - ttl - firstAt) / interval) + 1);
}

export type KeepWarmStop = "period-ended" | "cancelled" | "no-cache" | "unknown-ttl" | "miss" | "send-failed" | "session-unavailable";

export interface KeepWarmEntry {
  sessionId: string;
  startedAt: number;
  until: number;
  sent: number;
  /** A sent keep-alive whose response has not been observed yet. */
  pendingPingAt?: number;
  /** Time of the cache activity our latest settled keep-alive produced. */
  lastPingActivityAt?: number;
  /** Slowest observed keep-alive round trip. */
  latencyMs?: number;
  misses: number;
}

export type KeepWarmPlan =
  | { action: "ping" }
  | { action: "wait"; at: number; cold?: true }
  | { action: "settled"; activityAt: number; latencyMs: number; miss: boolean }
  | { action: "stop"; reason: KeepWarmStop };

/** The next step for one armed chat. Pure: the controller applies it. */
export function planKeepWarm(entry: Readonly<KeepWarmEntry>, facts: SessionCacheFacts | null, now: number): KeepWarmPlan {
  if (now >= entry.until) return { action: "stop", reason: "period-ended" };
  if (!facts) return { action: "stop", reason: "no-cache" };
  const { health } = facts;
  if (health.ttlMs === null) return { action: "stop", reason: "unknown-ttl" };
  if (entry.pendingPingAt !== undefined) {
    if (health.lastActivityAt < entry.pendingPingAt) {
      return now - entry.pendingPingAt >= PING_SETTLE_MS
        ? { action: "settled", activityAt: entry.pendingPingAt, latencyMs: PING_SETTLE_MS, miss: true }
        : { action: "wait", at: now + BUSY_RECHECK_MS };
    }
    const miss = facts.previousCached !== undefined && facts.lastRead < facts.previousCached * MISS_READ_SHARE;
    return { action: "settled", activityAt: health.lastActivityAt, latencyMs: health.lastActivityAt - entry.pendingPingAt, miss };
  }
  const expiresAt = health.lastActivityAt + health.ttlMs;
  // The cache outlives the period by itself: nothing more to send.
  if (expiresAt >= entry.until) return { action: "wait", at: entry.until };
  // Already cold: re-warming now costs the full re-write the person's next
  // message would pay anyway. Wait for that turn, then keep it warm again.
  if (now >= expiresAt) return { action: "wait", at: Math.min(entry.until, now + COLD_RECHECK_MS), cold: true };
  const afterPing = entry.lastPingActivityAt !== undefined && entry.lastPingActivityAt >= health.lastActivityAt;
  const dueAt = expiresAt - keepAliveLeadMs(health.ttlMs, afterPing, entry.latencyMs);
  return now >= dueAt ? { action: "ping" } : { action: "wait", at: dueAt };
}

export interface KeepWarmStatus {
  sessionId: string;
  active: boolean;
  until?: number;
  startedAt?: number;
  sent?: number;
  /** Next planned check or keep-alive. */
  nextAt?: number;
  cold?: boolean;
  stopped?: { reason: KeepWarmStop; at: number };
}

export interface KeepWarmDeps {
  now(): number;
  /** Cache facts from the canonical log; null when the session reported none. */
  facts(sessionId: string): Promise<SessionCacheFacts | null>;
  /** True only for an idle chat with nothing queued or waiting on a person. */
  ready(sessionId: string): Promise<boolean>;
  send(sessionId: string): Promise<void>;
  /** The chat is no longer kept warm, for whatever reason. */
  onStop?(sessionId: string): void;
  onError?(error: unknown): void;
}

/** At most this many chats are kept warm at once; the oldest goes first. */
const MAX_ENTRIES = 100;
const MAX_STOPPED = 200;

export function createKeepWarmController(deps: KeepWarmDeps) {
  const entries = new Map<string, KeepWarmEntry & { checkAt: number; cold?: boolean }>();
  const stopped = new Map<string, { reason: KeepWarmStop; at: number }>();
  let flight: Promise<void> | undefined;

  const stop = (sessionId: string, reason: KeepWarmStop): void => {
    entries.delete(sessionId);
    stopped.delete(sessionId);
    stopped.set(sessionId, { reason, at: deps.now() });
    while (stopped.size > MAX_STOPPED) stopped.delete(stopped.keys().next().value!);
    deps.onStop?.(sessionId);
  };

  const step = async (entry: KeepWarmEntry & { checkAt: number; cold?: boolean }): Promise<void> => {
    const now = deps.now();
    if (now < entry.checkAt) return;
    const facts = await deps.facts(entry.sessionId);
    let plan = planKeepWarm(entry, facts, now);
    if (plan.action === "settled") {
      delete entry.pendingPingAt;
      entry.lastPingActivityAt = plan.activityAt;
      if (!plan.miss) entry.latencyMs = Math.max(entry.latencyMs ?? 0, plan.latencyMs);
      entry.misses = plan.miss ? entry.misses + 1 : 0;
      if (entry.misses >= MAX_MISSES) { stop(entry.sessionId, "miss"); return; }
      plan = planKeepWarm(entry, facts, now);
    }
    if (entries.get(entry.sessionId) !== entry) return;
    if (plan.action === "stop") { stop(entry.sessionId, plan.reason); return; }
    if (plan.action === "wait") {
      entry.checkAt = plan.at;
      if (plan.cold) entry.cold = true;
      else delete entry.cold;
      return;
    }
    if (plan.action !== "ping") return;
    delete entry.cold;
    // Busy or waiting on the person: the chat's own requests keep the cache warm.
    if (!await deps.ready(entry.sessionId)) { entry.checkAt = deps.now() + BUSY_RECHECK_MS; return; }
    if (entries.get(entry.sessionId) !== entry) return;
    entry.pendingPingAt = deps.now();
    entry.sent += 1;
    entry.checkAt = deps.now() + BUSY_RECHECK_MS;
    try {
      await deps.send(entry.sessionId);
    } catch (error) {
      // Never retry an uncertain send.
      stop(entry.sessionId, "send-failed");
      deps.onError?.(error);
    }
  };

  const tickOnce = async (): Promise<void> => {
    for (const entry of [...entries.values()]) {
      if (entries.get(entry.sessionId) !== entry) continue;
      try { await step(entry); }
      catch (error) {
        stop(entry.sessionId, "session-unavailable");
        deps.onError?.(error);
      }
    }
  };

  const status = (sessionId: string): KeepWarmStatus => {
    const entry = entries.get(sessionId);
    if (entry) {
      return {
        sessionId, active: true, until: entry.until, startedAt: entry.startedAt, sent: entry.sent,
        nextAt: entry.checkAt, ...(entry.cold ? { cold: true } : {}),
      };
    }
    const last = stopped.get(sessionId);
    return { sessionId, active: false, ...(last ? { stopped: last } : {}) };
  };

  return {
    /** Keep `sessionId` warm until `until`; replaces an earlier period. */
    start(sessionId: string, until: number): KeepWarmStatus {
      const previous = entries.get(sessionId);
      entries.delete(sessionId);
      stopped.delete(sessionId);
      entries.set(sessionId, {
        sessionId, startedAt: previous?.startedAt ?? deps.now(), until,
        sent: previous?.sent ?? 0, misses: 0, checkAt: 0,
        ...(previous?.pendingPingAt !== undefined ? { pendingPingAt: previous.pendingPingAt } : {}),
        ...(previous?.lastPingActivityAt !== undefined ? { lastPingActivityAt: previous.lastPingActivityAt } : {}),
        ...(previous?.latencyMs !== undefined ? { latencyMs: previous.latencyMs } : {}),
      });
      while (entries.size > MAX_ENTRIES) stop(entries.keys().next().value!, "cancelled");
      return status(sessionId);
    },
    cancel(sessionId: string): KeepWarmStatus {
      if (entries.has(sessionId)) stop(sessionId, "cancelled");
      return status(sessionId);
    },
    status,
    tick(): Promise<void> {
      flight ??= tickOnce().finally(() => { flight = undefined; });
      return flight;
    },
    clear(): void { entries.clear(); stopped.clear(); },
  };
}
export type KeepWarmController = ReturnType<typeof createKeepWarmController>;
