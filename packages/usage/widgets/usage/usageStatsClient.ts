import { useCallback, useEffect, useRef, useState } from "react";
import { sessionFetch } from "@polyth/session/web-api";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import type {
  UsageStatsIdentity,
  UsageStatsQuery,
  UsageStatsReport,
} from "../../src/analytics/contracts.ts";

export interface UsageStatsRequestState {
  key: string;
  report: UsageStatsReport | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  lastSuccessfulAt: number | null;
}

export interface UsageStatsQueryOptions {
  enabled?: boolean;
  /**
   * Keep the current state but start no request (a hidden, kept-alive pane).
   * Un-pausing revalidates once.
   */
  paused?: boolean;
}

const CACHE_VERSION = 2;
const MAX_CACHE_ENTRIES = 24;
/** Reports persisted across tabs and reloads; the in-memory index holds more. */
const MAX_STORED_ENTRIES = 12;
/** Larger reports stay in memory only so the cache never evicts preferences. */
const MAX_STORED_REPORT_BYTES = 400 * 1024;
/** A persisted report older than this is not worth painting before the refresh. */
const MAX_STORED_REPORT_AGE_MS = 7 * 86_400_000;
const listeners = new Set<() => void>();
const cache = new Map<string, { report: UsageStatsReport; savedAt: number }>();
let identity: UsageStatsIdentity | null = null;
let identityRequest: Promise<UsageStatsIdentity> | null = null;
let cacheGeneration = 0;
interface PendingReport {
  promise: Promise<UsageStatsReport>;
  controller: AbortController;
  consumers: number;
}
const pendingReports = new Map<string, PendingReport>();

const STORAGE_PREFIX = `polyth.usageStats.${CACHE_VERSION}.`;
const IDENTITY_STORAGE_KEY = `${STORAGE_PREFIX}identity`;
const storageKey = (key: string): string => `${STORAGE_PREFIX}report.${key}`;

/**
 * Reports and the identity they belong to live in localStorage: a new tab, a
 * reload or a server restart then paints the last report on the first frame
 * and revalidates it, instead of a skeleton. Every read still goes through the
 * runtime/Space fence encoded in the key.
 */
const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const readStoredIdentity = (): UsageStatsIdentity | null => {
  try {
    const raw = storage()?.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UsageStatsIdentity>;
    return typeof parsed.serverInstanceId === "string" && parsed.serverInstanceId && typeof parsed.spaceId === "string" && parsed.spaceId
      ? { serverInstanceId: parsed.serverInstanceId, spaceId: parsed.spaceId }
      : null;
  } catch {
    return null;
  }
};

const writeStoredIdentity = (value: UsageStatsIdentity | null): void => {
  try {
    if (value) storage()?.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(value));
    else storage()?.removeItem(IDENTITY_STORAGE_KEY);
  } catch { /* best effort */ }
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([keyName, item]) => [keyName, canonicalize(item)]));
  }
  return value;
};

export function canonicalUsageQuery(query: UsageStatsQuery): Record<string, unknown> {
  return canonicalize(query) as Record<string, unknown>;
}

export function usageQueryCacheKey(serverIdentity: UsageStatsIdentity, query: UsageStatsQuery): string {
  return JSON.stringify({
    version: CACHE_VERSION,
    serverInstanceId: serverIdentity.serverInstanceId,
    spaceId: serverIdentity.spaceId,
    query: canonicalUsageQuery(query),
  });
}

export const usageErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const status = error !== null && typeof error === "object"
    ? (error as { status?: unknown }).status
    : undefined;
  const hasHttpStatus = typeof status === "number" && status > 0;
  if (!hasHttpStatus && /load failed|failed to fetch|fetch failed|networkerror|network request failed|net::err_/i.test(message)) {
    return tr("usage.errConnection");
  }
  return message;
};

const readStored = (key: string): UsageStatsReport | null => {
  try {
    const raw = storage()?.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { report?: UsageStatsReport; savedAt?: number };
    if (parsed?.report?.schemaVersion !== 1) return null;
    if (typeof parsed.savedAt === "number" && Date.now() - parsed.savedAt > MAX_STORED_REPORT_AGE_MS) return null;
    return parsed.report;
  } catch {
    return null;
  }
};

const storedReportKeys = (): string[] => {
  const store = storage();
  if (!store) return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}report.`)) keys.push(key);
    }
  } catch { /* best effort */ }
  return keys;
};

const writeStored = (key: string, report: UsageStatsReport): void => {
  const store = storage();
  if (!store) return;
  try {
    const serialized = JSON.stringify({ report, savedAt: Date.now() });
    if (serialized.length > MAX_STORED_REPORT_BYTES) {
      store.removeItem(storageKey(key));
      return;
    }
    store.setItem(storageKey(key), serialized);
    // Bound the persisted footprint by the oldest write, not by key order.
    const stored = storedReportKeys();
    if (stored.length > MAX_STORED_ENTRIES) {
      const dated = stored.map((storedKey) => {
        try {
          return { storedKey, savedAt: (JSON.parse(store.getItem(storedKey) ?? "{}") as { savedAt?: number }).savedAt ?? 0 };
        } catch {
          return { storedKey, savedAt: 0 };
        }
      }).sort((a, b) => a.savedAt - b.savedAt);
      for (const entry of dated.slice(0, stored.length - MAX_STORED_ENTRIES)) store.removeItem(entry.storedKey);
    }
  } catch {
    // Private browsing and storage quotas must not make analytics unavailable.
  }
};

const removeStored = (key: string): void => {
  try { storage()?.removeItem(storageKey(key)); } catch { /* best effort */ }
};

const clearStored = (): void => {
  const store = storage();
  if (!store) return;
  try {
    for (const key of storedReportKeys()) store.removeItem(key);
  } catch { /* best effort */ }
};

const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

const setIdentity = (next: UsageStatsIdentity): boolean => {
  if (identity && (
    identity.serverInstanceId === next.serverInstanceId &&
    identity.spaceId === next.spaceId
  )) return false;
  const changed = identity !== null;
  identity = next;
  if (changed) {
    cacheGeneration += 1;
    for (const pending of pendingReports.values()) pending.controller.abort();
    pendingReports.clear();
    clearStored();
    cache.clear();
  }
  writeStoredIdentity(next);
  return true;
};

// The last confirmed identity seeds the first render; the forced check that
// every mount runs replaces it (and clears the cache) if the server moved.
identity = readStoredIdentity();

export function getUsageIdentity(): UsageStatsIdentity | null {
  return identity;
}

export function clearUsageStatsCache(): void {
  cacheGeneration += 1;
  for (const pending of pendingReports.values()) pending.controller.abort();
  pendingReports.clear();
  cache.clear();
  clearStored();
  publish();
}

/**
 * Warm the cache for a query the user is likely to open next (the dashboard's
 * default scope at activation). Errors are swallowed: a prefetch is never
 * user-visible, and the real request reports them itself.
 */
export function prefetchUsageStats(query: UsageStatsQuery): Promise<void> {
  return requestUsageStats(query).then(() => undefined, () => undefined);
}

/** Resolve the current server/Space identity before any report is displayed. */
export function ensureUsageIdentity(force = false): Promise<UsageStatsIdentity> {
  if (identity && !force) return Promise.resolve(identity);
  if (identityRequest) return identityRequest;
  const request = sessionFetch<UsageStatsIdentity>("/api/usage/identity")
    .then((next: UsageStatsIdentity) => {
      if (!next || typeof next.serverInstanceId !== "string" || !next.serverInstanceId || typeof next.spaceId !== "string" || !next.spaceId) {
        throw new Error(tr("usage.errIdentityMalformed"));
      }
      setIdentity(next);
      return next;
    })
    .finally(() => {
      identityRequest = null;
    });
  identityRequest = request;
  return request;
}

export interface UsageStatsRequestGate {
  readonly generation: number;
  begin(): { generation: number; signal: AbortSignal };
  isCurrent(generation: number): boolean;
  invalidate(): void;
}

/** Small pure coordinator used by the hook and deterministic race tests. */
export function createUsageStatsRequestGate(): UsageStatsRequestGate {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    get generation() { return generation; },
    begin() {
      controller?.abort();
      generation += 1;
      controller = new AbortController();
      return { generation, signal: controller.signal };
    },
    isCurrent(value) { return value === generation; },
    invalidate() {
      controller?.abort();
      controller = null;
      generation += 1;
    },
  };
}

/** A consumer can cancel without aborting another widget's shared request. */
const consumeReport = (key: string, pending: PendingReport, signal?: AbortSignal): Promise<UsageStatsReport> => {
  pending.consumers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      pending.consumers -= 1;
      if (pending.consumers === 0 && pendingReports.get(key) === pending) {
        pendingReports.delete(key);
        pending.controller.abort();
      }
      callback();
    };
    const abort = (): void => finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
    pending.promise.then(
      (report) => finish(() => resolve(report)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
};

export async function requestUsageStats(
  query: UsageStatsQuery,
  signal?: AbortSignal,
): Promise<UsageStatsReport> {
  const nextIdentity = await ensureUsageIdentity();
  signal?.throwIfAborted();
  const key = usageQueryCacheKey(nextIdentity, query);
  const existing = pendingReports.get(key);
  if (existing) return consumeReport(key, existing, signal);
  const generation = cacheGeneration;
  const controller = new AbortController();
  const pending: PendingReport = { controller, consumers: 0, promise: undefined! };
  pending.promise = sessionFetch<UsageStatsReport>("/api/usage/stats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
    signal: controller.signal,
  }).then((response) => {
    // Even a transport that ignores abort must not repopulate a cleared cache.
    controller.signal.throwIfAborted();
    if (generation !== cacheGeneration || identity?.serverInstanceId !== nextIdentity.serverInstanceId || identity?.spaceId !== nextIdentity.spaceId) {
      throw new Error(tr("usage.errSuperseded"));
    }
    if (!response || response.schemaVersion !== 1 || typeof response.serverInstanceId !== "string" || typeof response.spaceId !== "string") {
      throw new Error(tr("usage.errReportMalformed"));
    }
    if (response.serverInstanceId !== nextIdentity.serverInstanceId || response.spaceId !== nextIdentity.spaceId) {
      clearUsageStatsCache();
      void ensureUsageIdentity(true).catch(() => undefined);
      throw new Error(tr("usage.errReportOtherRuntime"));
    }
    if (JSON.stringify(canonicalUsageQuery(response.query)) !== JSON.stringify(canonicalUsageQuery(query))) {
      throw new Error(tr("usage.errReportMismatch"));
    }
    cache.delete(key);
    cache.set(key, { report: response, savedAt: Date.now() });
    writeStored(key, response);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
      removeStored(oldest);
    }
    return response;
  }).finally(() => {
    if (pendingReports.get(key) === pending) pendingReports.delete(key);
  });
  pendingReports.set(key, pending);
  return consumeReport(key, pending, signal);
}

/**
 * Pure cache read used to seed a render. It never mutates the in-memory index,
 * so it is safe to call while rendering and still honours the runtime/Space
 * fence encoded in the key.
 */
export function peekCachedUsageStats(
  serverIdentity: UsageStatsIdentity,
  query: UsageStatsQuery,
): UsageStatsReport | null {
  const key = usageQueryCacheKey(serverIdentity, query);
  const inMemory = cache.get(key)?.report ?? null;
  if (inMemory) return inMemory;
  const stored = readStored(key);
  if (stored && stored.serverInstanceId === serverIdentity.serverInstanceId && stored.spaceId === serverIdentity.spaceId) {
    return stored;
  }
  return null;
}

export function subscribeUsageStatsCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const loadingUsageStatsState = (key: string): UsageStatsRequestState => ({
  key,
  report: null,
  loading: true,
  refreshing: false,
  stale: false,
  error: null,
  lastSuccessfulAt: null,
});

/**
 * Build the state a render should expose for a query. Reading a warm cache here
 * (without awaiting identity) means a tab/scope switch paints its report on the
 * first frame instead of a blocking loading state.
 */
const usageStatsSnapshot = (
  key: string,
  query: UsageStatsQuery,
  enabled: boolean,
): UsageStatsRequestState => {
  if (!enabled) {
    return { key: "", report: null, loading: false, refreshing: false, stale: false, error: null, lastSuccessfulAt: null };
  }
  const known = identity;
  const report = known ? peekCachedUsageStats(known, query) : null;
  return {
    key,
    report,
    loading: !report,
    refreshing: !!report,
    stale: false,
    error: null,
    lastSuccessfulAt: report?.generatedAt ?? null,
  };
};

/**
 * SWR hook. A query-key change never displays the previous report under the
 * new label; a cached report for the exact key is shown immediately, then a
 * background request revalidates it. A failed request keeps the last report and
 * exposes an error/stale state.
 */
export function useUsageStats(
  query: UsageStatsQuery,
  options: UsageStatsQueryOptions = {},
): UsageStatsRequestState & { refresh: () => void } {
  const enabled = options.enabled !== false;
  const paused = options.paused === true;
  const serialized = JSON.stringify(canonicalUsageQuery(query));
  const gate = useRef(createUsageStatsRequestGate());
  const [state, setState] = useState<UsageStatsRequestState>(() =>
    usageStatsSnapshot(serialized, query, enabled));
  const [refreshRevision, setRefreshRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      gate.current.invalidate();
      setState(usageStatsSnapshot(serialized, query, false));
      return;
    }
    if (paused) return;
    let disposed = false;
    const current = gate.current.begin();
    const seeded = usageStatsSnapshot(serialized, query, true);
    setState(seeded);
    const fail = (error: unknown): void => {
      if (disposed || !gate.current.isCurrent(current.generation)) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        refreshing: false,
        stale: !!previous.report,
        error: usageErrorMessage(error),
      }));
    };
    const knownIdentity = identity;
    // The forced identity check runs beside the report request rather than in
    // front of it: a known runtime/Space costs no extra round trip, and a
    // changed one aborts the request (cache generation) and is retried below.
    const identityCheck = ensureUsageIdentity(true);
    const firstRequest = knownIdentity ? requestUsageStats(query, current.signal) : null;
    firstRequest?.catch(() => undefined);
    void identityCheck.then(async (serverIdentity) => {
      if (disposed || !gate.current.isCurrent(current.generation)) return;
      // The forced identity check may have observed a new runtime/Space, which
      // clears the cache. Re-read against the resolved identity rather than
      // displaying a report that belongs to a superseded namespace.
      const durable = peekCachedUsageStats(serverIdentity, query);
      if (!durable) {
        setState(loadingUsageStatsState(serialized));
      } else if (durable !== seeded.report) {
        setState({
          key: serialized,
          report: durable,
          loading: false,
          refreshing: true,
          stale: false,
          error: null,
          lastSuccessfulAt: durable.generatedAt,
        });
      }
      const sameIdentity = knownIdentity?.serverInstanceId === serverIdentity.serverInstanceId &&
        knownIdentity?.spaceId === serverIdentity.spaceId;
      try {
        const report = firstRequest && sameIdentity
          ? await firstRequest
          : await requestUsageStats(query, current.signal);
        if (disposed || !gate.current.isCurrent(current.generation)) return;
        if (report.serverInstanceId !== serverIdentity.serverInstanceId || report.spaceId !== serverIdentity.spaceId) {
          clearUsageStatsCache();
          throw new Error(tr("usage.errResponseOtherRuntime"));
        }
        setState({
          key: serialized,
          report,
          loading: false,
          refreshing: false,
          stale: false,
          error: null,
          lastSuccessfulAt: report.generatedAt,
        });
      } catch (error) {
        fail(error);
      }
    }).catch(fail);
    return () => {
      disposed = true;
      gate.current.invalidate();
    };
    // The serialized canonical query is the actual dependency; JSON parsing is
    // intentionally avoided on every render.
  }, [enabled, paused, serialized, refreshRevision]);

  const refresh = useCallback(() => setRefreshRevision((revision) => revision + 1), []);
  // A key change must not expose the previous scope's report for even one
  // frame, so synthesize the correct state for the current key during render.
  const snapshot = enabled && state.key === serialized ? state : usageStatsSnapshot(serialized, query, enabled);
  return { ...snapshot, refresh };
}
