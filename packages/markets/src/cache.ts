import type { MarketCacheState } from "./types.ts";

export interface SwrCachePolicy {
  softTtlMs: number;
  hardTtlMs: number;
  maxEntries: number;
}

export interface SwrCacheResult<T> {
  value: T;
  state: MarketCacheState;
  updatedAt: number;
  revalidating: boolean;
}

interface CacheEntry<T> {
  value: T;
  updatedAt: number;
  touchedAt: number;
}

export class SwrCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(
    key: string,
    policy: SwrCachePolicy,
    load: () => Promise<T>,
  ): Promise<SwrCacheResult<T>> {
    this.validatePolicy(policy);
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry) {
      entry.touchedAt = now;
      const age = Math.max(0, now - entry.updatedAt);
      if (age <= policy.softTtlMs) {
        return { value: entry.value, state: "fresh", updatedAt: entry.updatedAt, revalidating: false };
      }
      if (age <= policy.hardTtlMs) {
        const refresh = this.refresh(key, policy, load);
        void refresh.catch(() => undefined);
        return { value: entry.value, state: "stale", updatedAt: entry.updatedAt, revalidating: true };
      }
    }

    const value = await this.refresh(key, policy, load);
    const refreshed = this.entries.get(key);
    if (!refreshed) throw new Error(`market cache refresh did not store ${key}`);
    return { value, state: "refreshed", updatedAt: refreshed.updatedAt, revalidating: false };
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private refresh(key: string, policy: SwrCachePolicy, load: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(key);
    if (active) return active;

    const request = load().then((value) => {
      const now = this.now();
      this.entries.set(key, { value, updatedAt: now, touchedAt: now });
      this.evict(policy.maxEntries);
      return value;
    }).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private evict(maxEntries: number): void {
    while (this.entries.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.touchedAt < oldestTouched) {
          oldestTouched = entry.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }

  private validatePolicy(policy: SwrCachePolicy): void {
    if (policy.softTtlMs < 0 || policy.hardTtlMs < policy.softTtlMs) {
      throw new Error("market cache TTLs are invalid");
    }
    if (!Number.isInteger(policy.maxEntries) || policy.maxEntries < 1) {
      throw new Error("market cache maxEntries must be a positive integer");
    }
  }
}
