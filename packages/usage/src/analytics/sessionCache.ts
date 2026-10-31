// Cache facts of one session straight from its canonical log, for server
// consumers that act on cache warmth (e.g. a keep-alive policy). Browser-safe.
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { sessionCacheHealth } from "./cacheHealth.ts";
import { collectSessionObservations } from "./collect.ts";
import type { UsageCacheHealth } from "./contracts.ts";

export interface SessionCacheFacts {
  health: UsageCacheHealth;
  /** Cache read of the latest response that used the cache. */
  lastRead: number;
  /** Read + write of the cache activity before it; undefined for the first. */
  previousCached?: number;
}

/** Null when the session never reported cache reads or writes. */
export function sessionCacheFacts(projection: SessionProjection, events: readonly SessionEvent[]): SessionCacheFacts | null {
  const observations = collectSessionObservations(projection, events);
  const health = sessionCacheHealth(observations);
  if (!health) return null;
  const cached = observations
    .filter((item) => Number.isFinite(item.timestamp) && (item.tokens.cacheRead ?? 0) + (item.tokens.cacheWrite ?? 0) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const last = cached.at(-1), previous = cached.at(-2);
  return {
    health,
    lastRead: last?.tokens.cacheRead ?? 0,
    ...(previous ? { previousCached: (previous.tokens.cacheRead ?? 0) + (previous.tokens.cacheWrite ?? 0) } : {}),
  };
}
