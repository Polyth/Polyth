import { useEffect, useMemo, useReducer } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import type {
  UsageAnalyticsQuery,
  UsageAnalyticsResponse,
} from "../../src/analyticsTypes.ts";

const transport = createApiTransport();
const CACHE_TTL_MS = 15_000;

export type UsageAnalyticsClientQuery = Omit<UsageAnalyticsQuery, "limit"> & { limit?: number };

interface CacheEntry {
  data: UsageAnalyticsResponse | null;
  error: string | null;
  loading: boolean;
  updatedAt: number;
  promise: Promise<void> | null;
  listeners: Set<() => void>;
}

const cache = new Map<string, CacheEntry>();

const queryKey = (query: UsageAnalyticsClientQuery): string =>
  JSON.stringify(Object.entries(query).sort(([left], [right]) => left.localeCompare(right)));

const entryFor = (key: string): CacheEntry => {
  let entry = cache.get(key);
  if (!entry) {
    entry = {
      data: null,
      error: null,
      loading: false,
      updatedAt: 0,
      promise: null,
      listeners: new Set(),
    };
    cache.set(key, entry);
  }
  return entry;
};

const notify = (entry: CacheEntry): void => {
  for (const listener of [...entry.listeners]) listener();
};

const urlFor = (query: UsageAnalyticsClientQuery): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return `/api/usage/analytics?${params.toString()}`;
};

const load = (
  key: string,
  query: UsageAnalyticsClientQuery,
  force = false,
): Promise<void> => {
  const entry = entryFor(key);
  if (entry.promise) return entry.promise;
  if (!force && entry.data && Date.now() - entry.updatedAt < CACHE_TTL_MS) {
    return Promise.resolve();
  }
  entry.loading = true;
  entry.error = null;
  notify(entry);
  entry.promise = (async () => {
    try {
      entry.data = await transport.get<UsageAnalyticsResponse>(urlFor(query));
      entry.updatedAt = Date.now();
      entry.error = null;
    } catch (cause) {
      entry.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      entry.loading = false;
      entry.promise = null;
      notify(entry);
    }
  })();
  return entry.promise;
};

export function useUsageAnalytics(query: UsageAnalyticsClientQuery): {
  data: UsageAnalyticsResponse | null;
  error: string | null;
  loading: boolean;
  refresh(): Promise<void>;
} {
  const key = useMemo(() => queryKey(query), [query]);
  const stableQuery = useMemo(
    () => Object.fromEntries(JSON.parse(key) as Array<[string, unknown]>) as UsageAnalyticsClientQuery,
    [key],
  );
  const [, render] = useReducer((value: number) => value + 1, 0);
  const entry = entryFor(key);

  useEffect(() => {
    const active = entryFor(key);
    const listener = () => render();
    active.listeners.add(listener);
    void load(key, stableQuery);
    return () => {
      active.listeners.delete(listener);
      if (active.listeners.size === 0 && Date.now() - active.updatedAt > 5 * 60_000) {
        cache.delete(key);
      }
    };
  }, [key, stableQuery]);

  return {
    data: entry.data,
    error: entry.error,
    loading: entry.loading,
    refresh: () => load(key, stableQuery, true),
  };
}

export function invalidateUsageAnalytics(): void {
  for (const [key, entry] of cache) {
    entry.updatedAt = 0;
    if (entry.listeners.size === 0) continue;
    const raw = JSON.parse(key) as Array<[string, unknown]>;
    const query = Object.fromEntries(raw) as UsageAnalyticsClientQuery;
    void load(key, query, true);
  }
}
