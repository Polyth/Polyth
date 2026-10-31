import { fmtTokens } from "../../../../apps/web/src/format.ts";
import { formatNumber, tr } from "../../../../apps/web/src/i18n/index.ts";
import { cacheCountdown, type UsageCacheWarmth } from "../../src/analytics/cacheHealth.ts";
import type { UsageCacheBurn, UsageCacheHealth } from "../../src/analytics/contracts.ts";

export type CacheTone = "warning" | "critical";

export interface CacheWarmthDisplay {
  state: UsageCacheWarmth | "active";
  value: string;
  detail: string;
  tone?: CacheTone;
  /** The cached prefix, formatted: `32.0k`. */
  cached: string;
  /** How long the cache lives and how that is known, or that it is not reported. */
  lifetime: string;
  /** Share of the lifetime still left in `[0, 1]`; null without a running countdown. */
  remaining: number | null;
}

const unit = (value: number, name: "hour" | "minute" | "second"): string =>
  formatNumber(value, { style: "unit", unit: name, unitDisplay: "short" });

/**
 * A cache span in the units that matter: whole minutes (rounded up, so a
 * countdown never reads lower than the truth) until the last two minutes, then
 * seconds. Zero parts are dropped: `5m`, `1h`, `1h 5m`, `1m 40s`, `40s`.
 */
export function cacheDuration(ms: number, roundUp = false): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 120) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return unit(seconds, "second");
    return seconds === 0 ? unit(minutes, "minute") : `${unit(minutes, "minute")} ${unit(seconds, "second")}`;
  }
  const totalMinutes = roundUp ? Math.ceil(totalSeconds / 60) : Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return unit(minutes, "minute");
  return minutes === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
}

const ttlLabel = (health: UsageCacheHealth): string => {
  if (health.ttlMs === null) return tr("usage.cacheTtlUnknown");
  const ttl = cacheDuration(health.ttlMs);
  return tr(health.ttlBasis === "observed" ? "usage.cacheTtlObserved" : "usage.cacheTtlDefault", { ttl });
};

/**
 * The session card's cache line. A working session is using its cache, so no
 * countdown runs until the turn ends. Expiry is never asserted without a known
 * lifetime: an unknown one only reports how long the cache has been idle.
 */
export function cacheWarmthDisplay(health: UsageCacheHealth, now: number, active = false): CacheWarmthDisplay {
  const parts = { cached: fmtTokens(health.cachedTokens), lifetime: ttlLabel(health) };
  const detail = `${parts.lifetime} · ${tr("usage.cacheTokensCached", { tokens: parts.cached })}`;
  if (active) return { state: "active", value: tr("usage.cacheInUse"), detail, ...parts, remaining: null };
  const countdown = cacheCountdown(health, now);
  if (countdown.state === "unknown") {
    return { state: "unknown", value: tr("usage.cacheIdle", { duration: cacheDuration(countdown.idleMs) }), detail, ...parts, remaining: null };
  }
  if (countdown.state === "expired") {
    return {
      state: "expired",
      value: tr("usage.cacheExpired"),
      detail: tr("usage.cacheRewriteNext", { tokens: parts.cached }),
      tone: "critical",
      ...parts,
      remaining: 0,
    };
  }
  return {
    state: countdown.state,
    value: tr("usage.cacheExpiresIn", { duration: cacheDuration(countdown.remainingMs ?? 0, true) }),
    detail,
    ...(countdown.state === "expiring" ? { tone: "warning" as const } : {}),
    ...parts,
    remaining: health.ttlMs ? Math.max(0, Math.min(1, (countdown.remainingMs ?? 0) / health.ttlMs)) : null,
  };
}

export function cacheBurnDisplay(burn: UsageCacheBurn | null | undefined): { value: string; detail?: string } {
  if (!burn) return { value: "—" };
  if (burn.rewrites === 0) return { value: fmtTokens(0) };
  return {
    value: fmtTokens(burn.tokens),
    detail: tr("usage.cacheBurnDetail", { count: formatNumber(burn.rewrites) }),
  };
}

/**
 * How often the card must repaint: every second in the last two minutes,
 * every 15 s while a countdown runs, every 30 s for idle time, never once
 * expired or while a turn is running.
 */
export function cacheTickMs(health: UsageCacheHealth | null, now: number, active = false): number | null {
  if (!health || active) return null;
  const countdown = cacheCountdown(health, now);
  if (countdown.state === "expired") return null;
  if (countdown.remainingMs === null) return 30_000;
  return countdown.remainingMs <= 120_000 ? 1_000 : 15_000;
}
