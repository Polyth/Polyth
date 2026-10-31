import { canonicalProviderId } from "../providerIdentity.ts";
import type {
  UsageCacheBurn,
  UsageCacheHealth,
  UsageCacheTtlBasis,
  UsageObservation,
} from "./contracts.ts";

const MINUTE = 60_000;

/**
 * Shortest prompt-cache lifetime any provider documents. An idle gap shorter
 * than this is never treated as expiry evidence when the lifetime is unknown.
 */
export const MIN_DOCUMENTED_CACHE_TTL_MS = 5 * MINUTE;

/**
 * Documented fixed defaults only. Anthropic caches for 5 minutes unless a
 * request opts into its 1-hour lifetime. OpenAI documents its automatic cache
 * as 5–10 minutes, up to an hour off-peak, so it stays unknown, like every
 * provider absent here.
 */
const PROVIDER_DEFAULT_TTL_MS: Readonly<Record<string, number>> = { anthropic: 5 * MINUTE };

/** Documented default prompt-cache lifetime of `providerId`, or null when the
 *  provider documents none (its cache may still exist; its lifetime is unknown). */
export function providerCacheTtlMs(providerId: string | undefined): number | null {
  return PROVIDER_DEFAULT_TTL_MS[canonicalProviderId(providerId ?? "").toLowerCase()] ?? null;
}

/** Longer lifetimes a provider offers. A hit beyond the default proves the next one. */
const PROVIDER_EXTENDED_TTL_MS: Readonly<Record<string, readonly number[]>> = { anthropic: [60 * MINUTE] };

/**
 * A request that reads less than this share of the prefix the previous request
 * left cached missed the cache. Prompts only grow between requests, so a warm
 * cache reads at least the whole previous prefix.
 */
const MISS_READ_SHARE = 0.5;

/**
 * Observation time is when a response ended, so an end-to-end gap includes
 * the next response's own generation time. A hit proves a longer lifetime only
 * when the gap exceeds the default by this margin.
 */
const OBSERVED_TTL_MARGIN_MS = 5 * MINUTE;

/** Within this share of the lifetime (at least a minute) the cache is about to expire. */
const EXPIRING_SHARE = 0.2;
const EXPIRING_MIN_MS = MINUTE;

const cachedTokens = (observation: UsageObservation): number =>
  (observation.tokens.cacheRead ?? 0) + (observation.tokens.cacheWrite ?? 0);

const providerOf = (observation: UsageObservation): string =>
  canonicalProviderId(observation.providerId ?? "").toLowerCase();

const sameCache = (a: UsageObservation, b: UsageObservation): boolean =>
  providerOf(a) === providerOf(b) && (a.modelId ?? "") === (b.modelId ?? "");

interface SessionCacheScan {
  health: UsageCacheHealth | null;
  /** Re-written tokens keyed by observation id. */
  rewrites: Array<[string, number]>;
}

/** One session's observations in time order. */
const scanSession = (observations: readonly UsageObservation[]): SessionCacheScan => {
  const rewrites: Array<[string, number]> = [];
  const burn: UsageCacheBurn = { rewrites: 0, tokens: 0 };
  // Lifetime proven per provider by a hit after a longer gap than its default.
  const observedTtl = new Map<string, number>();
  let previous: UsageObservation | undefined;
  for (const observation of observations) {
    const { cacheRead, cacheWrite } = observation.tokens;
    if (cacheRead === null && cacheWrite === null) continue;
    const cached = cachedTokens(observation);
    // A request that used no cache at all (a tiny prompt) leaves the
    // previous prefix's timer untouched.
    if (cached <= 0) continue;
    if (previous && sameCache(previous, observation)) {
      const gap = observation.timestamp - previous.timestamp;
      const previousCached = cachedTokens(previous);
      const read = cacheRead ?? 0;
      const provider = providerOf(observation);
      const fallback = PROVIDER_DEFAULT_TTL_MS[provider];
      if (read >= previousCached * MISS_READ_SHARE) {
        if (fallback !== undefined && gap > fallback + OBSERVED_TTL_MARGIN_MS) {
          const proven = PROVIDER_EXTENDED_TTL_MS[provider]?.find((ttl) => ttl >= gap);
          if (proven !== undefined && proven > (observedTtl.get(provider) ?? 0)) observedTtl.set(provider, proven);
        }
      } else if (cacheRead !== null && cacheWrite !== null && cacheWrite > 0) {
        const ttl = observedTtl.get(provider) ?? fallback ?? MIN_DOCUMENTED_CACHE_TTL_MS;
        if (gap >= ttl) {
          const tokens = Math.min(cacheWrite, previousCached - read);
          if (tokens > 0) {
            rewrites.push([observation.id, tokens]);
            burn.rewrites += 1;
            burn.tokens += tokens;
          }
        }
      }
    }
    previous = observation;
  }
  if (!previous) return { health: null, rewrites };
  const provider = providerOf(previous);
  const observed = observedTtl.get(provider);
  const fallback = PROVIDER_DEFAULT_TTL_MS[provider];
  const ttlBasis: UsageCacheTtlBasis = observed !== undefined
    ? "observed"
    : fallback !== undefined ? "provider-default" : "unknown";
  return {
    health: {
      lastActivityAt: previous.timestamp,
      ...(provider ? { providerId: provider } : {}),
      ...(previous.modelId ? { modelId: previous.modelId } : {}),
      ttlMs: observed ?? fallback ?? null,
      ttlBasis,
      cachedTokens: cachedTokens(previous),
      burn,
    },
    rewrites,
  };
};

const byTime = (a: UsageObservation, b: UsageObservation): number => a.timestamp - b.timestamp;

export interface UsageCacheScan {
  health: Map<string, UsageCacheHealth>;
  rewrites: Map<string, number>;
}

/**
 * Cache health per session and the re-written tokens of each burned request.
 * Pass every known observation of the sessions in scope, not only a range:
 * the request before a range boundary is what proves a miss after it.
 */
export function scanCacheHealth(observations: readonly UsageObservation[]): UsageCacheScan {
  const bySession = new Map<string, UsageObservation[]>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.timestamp)) continue;
    const list = bySession.get(observation.sessionId);
    if (list) list.push(observation);
    else bySession.set(observation.sessionId, [observation]);
  }
  const health = new Map<string, UsageCacheHealth>();
  const rewrites = new Map<string, number>();
  for (const [sessionId, list] of bySession) {
    const scan = scanSession(list.sort(byTime));
    if (scan.health) health.set(sessionId, scan.health);
    for (const [id, tokens] of scan.rewrites) rewrites.set(id, tokens);
  }
  return { health, rewrites };
}

/** Cache health of one session's observations. */
export const sessionCacheHealth = (observations: readonly UsageObservation[]): UsageCacheHealth | null =>
  scanSession([...observations].filter((item) => Number.isFinite(item.timestamp)).sort(byTime)).health;

export type UsageCacheWarmth = "warm" | "expiring" | "expired" | "unknown";

export interface UsageCacheCountdown {
  state: UsageCacheWarmth;
  /** Time since the latest cache activity. */
  idleMs: number;
  /** Null when the lifetime is unknown. Zero once expired. */
  remainingMs: number | null;
}

export function cacheCountdown(health: UsageCacheHealth, now: number): UsageCacheCountdown {
  const idleMs = Math.max(0, now - health.lastActivityAt);
  if (health.ttlMs === null) return { state: "unknown", idleMs, remainingMs: null };
  const remainingMs = Math.max(0, health.ttlMs - idleMs);
  const state = remainingMs <= 0
    ? "expired"
    : remainingMs <= Math.max(EXPIRING_MIN_MS, health.ttlMs * EXPIRING_SHARE) ? "expiring" : "warm";
  return { state, idleMs, remainingMs };
}

/**
 * Prefer the newer cache activity, but keep the larger burn: a live event tail
 * can be newer than a report yet hold less history.
 */
export function mergeCacheHealth(
  live: UsageCacheHealth | null | undefined,
  reported: UsageCacheHealth | null | undefined,
): UsageCacheHealth | null {
  if (!live) return reported ?? null;
  if (!reported) return live;
  const newer = live.lastActivityAt >= reported.lastActivityAt ? live : reported;
  const burn = live.burn.tokens >= reported.burn.tokens ? live.burn : reported.burn;
  return newer.burn === burn ? newer : { ...newer, burn };
}
