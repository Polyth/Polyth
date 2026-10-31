import { useCallback, useEffect, useRef, useState } from "react";
import { sessionFetch } from "@polyth/session/web-api";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import type { QuotaPace, QuotaSnapshot } from "@polyth/contracts";
import type { UsageLimitAccount, UsageLimitBalance } from "../../src/limits.ts";
import { usageErrorMessage } from "./usageStatsClient.ts";
import { attributableLimits, hostWideLimits, sameLimitsIdentity } from "./limitsIdentity.ts";

export interface UsageLimitSnapshotDto extends QuotaSnapshot {
  balances: UsageLimitBalance[];
  pace: Record<string, QuotaPace | null>;
  /** Present when the source is one account of a multi-account harness. */
  account?: UsageLimitAccount;
  /** "space": computed from the requesting Space's history, not host-wide. */
  scope?: "space";
}

export interface UsageLimitsResponse {
  providers: UsageLimitSnapshotDto[];
  fetchedAt: number;
  /** The server and Space the response answered for; see limitsIdentity.ts. */
  serverInstanceId?: string;
  spaceId?: string;
}

export interface UsageLimitsState {
  providers: UsageLimitSnapshotDto[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const validResponse = (value: UsageLimitsResponse): UsageLimitsResponse => {
  if (!value || !Array.isArray(value.providers) || !Number.isFinite(value.fetchedAt)) {
    throw new Error(tr("usage.errLimitsMalformed"));
  }
  return value;
};

// Limits survive a tab switch, a reload and a new tab instead of remounting
// into a blank loading state. The snapshot is operational telemetry, not
// canonical history, so the last-good value is enough to paint; the mount
// effect still revalidates it, and one older than a day is not shown at all.
//
// Only host-wide sources are persisted or painted from the cache: which Space
// the next response answers for is unknown until it arrives, so a per-Space
// estimate lives in memory with its identity and is merged only into a
// response from the same server and Space. Version 1 stored per-Space sources
// without that identity and is discarded.
const LIMITS_STORAGE_KEY = "polyth.usageLimits.2";
const LEGACY_LIMITS_STORAGE_KEYS = ["polyth.usageLimits.1"];
const MAX_STORED_LIMITS_AGE_MS = 86_400_000;

const hostWideResponse = (response: UsageLimitsResponse): UsageLimitsResponse => ({
  providers: hostWideLimits(response.providers),
  fetchedAt: response.fetchedAt,
});

const readStoredLimits = (): UsageLimitsResponse | null => {
  try {
    if (typeof localStorage === "undefined") return null;
    for (const key of LEGACY_LIMITS_STORAGE_KEYS) localStorage.removeItem(key);
    const raw = localStorage.getItem(LIMITS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = validResponse(JSON.parse(raw) as UsageLimitsResponse);
    return Date.now() - parsed.fetchedAt > MAX_STORED_LIMITS_AGE_MS ? null : hostWideResponse(parsed);
  } catch {
    return null;
  }
};

/** The latest response, per-Space sources included only with their identity. */
let cachedLimits: UsageLimitsResponse | null = readStoredLimits();

const rememberLimits = (response: UsageLimitsResponse): void => {
  cachedLimits = { ...response, providers: attributableLimits(response) };
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LIMITS_STORAGE_KEY, JSON.stringify(hostWideResponse(response)));
  } catch {
    // Quota or private browsing: the in-memory value still serves this tab.
  }
};

/** Warm the limits snapshot ahead of the first widget or Limits page. */
export function prefetchUsageLimits(): Promise<void> {
  return requestUsageLimits().then(rememberLimits, () => undefined);
}

const initialUsageLimitsState = (): UsageLimitsState => {
  const cached = cachedUsageLimits();
  return cached
    ? {
      providers: cached.providers,
      loading: false,
      refreshing: false,
      error: null,
      fetchedAt: cached.fetchedAt,
    }
    : { providers: [], loading: true, refreshing: false, error: null, fetchedAt: null };
};

export async function requestUsageLimits(signal?: AbortSignal): Promise<UsageLimitsResponse> {
  return validResponse(await sessionFetch<UsageLimitsResponse>("/api/usage/limits", signal ? { signal } : undefined));
}

export async function refreshUsageLimits(
  providerId?: string,
  signal?: AbortSignal,
): Promise<UsageLimitsResponse> {
  return validResponse(await sessionFetch<UsageLimitsResponse>("/api/usage/limits/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(providerId ? { providerId } : {}),
    ...(signal ? { signal } : {}),
  }));
}

const mergeProvider = (
  current: readonly UsageLimitSnapshotDto[],
  incoming: readonly UsageLimitSnapshotDto[],
): UsageLimitSnapshotDto[] => {
  if (incoming.length !== 1) return [...incoming];
  const [next] = incoming;
  if (!next) return [...current];
  const found = current.some((provider) => provider.providerId === next.providerId);
  return found
    ? current.map((provider) => provider.providerId === next.providerId ? next : provider)
    : [...current, next];
};

/**
 * Merges a one-source refresh into the last-good snapshot. Cached per-Space
 * sources survive only when the refresh answered for the same server and Space.
 */
const mergeRefresh = (response: UsageLimitsResponse): UsageLimitsResponse => {
  const base = cachedLimits
    ? sameLimitsIdentity(cachedLimits, response) ? cachedLimits.providers : hostWideLimits(cachedLimits.providers)
    : [];
  const incoming = attributableLimits(response);
  const merged: UsageLimitsResponse = {
    // A lone source the response cannot attribute to a Space is dropped, not
    // allowed to clear the rest of the snapshot.
    providers: incoming.length === 0 && response.providers.length === 1 ? [...base] : mergeProvider(base, incoming),
    fetchedAt: response.fetchedAt,
    ...(response.serverInstanceId !== undefined ? { serverInstanceId: response.serverInstanceId } : {}),
    ...(response.spaceId !== undefined ? { spaceId: response.spaceId } : {}),
  };
  rememberLimits(merged);
  return merged;
};

/**
 * The last-good snapshot this tab knows, without a request. It holds only
 * host-wide sources: the Space a later request answers for is not known yet.
 */
export function cachedUsageLimits(): UsageLimitsResponse | null {
  return cachedLimits ? hostWideResponse(cachedLimits) : null;
}

/** Reads the server's current snapshot (no provider request) and keeps it as the last-good one. */
export async function loadUsageLimits(signal?: AbortSignal): Promise<UsageLimitsResponse> {
  const response = await requestUsageLimits(signal);
  rememberLimits(response);
  return { ...response, providers: attributableLimits(response) };
}

/** Asks one source for fresh values and merges them into the last-good snapshot. */
export async function refreshUsageLimitSource(providerId: string, signal?: AbortSignal): Promise<UsageLimitsResponse> {
  return mergeRefresh(await refreshUsageLimits(providerId, signal));
}

export function useUsageLimits(): UsageLimitsState & {
  refresh: () => void;
  refreshProvider: (providerId: string) => Promise<void>;
} {
  const [state, setState] = useState<UsageLimitsState>(initialUsageLimitsState);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);

  const load = useCallback(async (force = false) => {
    const generation = ++requestGeneration.current;
    setState((previous) => ({
      ...previous,
      loading: previous.providers.length === 0,
      refreshing: previous.providers.length > 0,
      error: force ? null : previous.error,
    }));
    try {
      const response = force ? await refreshUsageLimits() : await requestUsageLimits();
      if (!mounted.current || generation !== requestGeneration.current) return;
      rememberLimits(response);
      setState({
        providers: attributableLimits(response),
        loading: false,
        refreshing: false,
        error: null,
        fetchedAt: response.fetchedAt,
      });
    } catch (error) {
      if (!mounted.current || generation !== requestGeneration.current) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        refreshing: false,
        error: usageErrorMessage(error),
      }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    const timer = setInterval(() => void load(false), 60_000);
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const refreshProvider = useCallback(async (providerId: string) => {
    setState((previous) => ({ ...previous, refreshing: true, error: null }));
    try {
      const response = mergeRefresh(await refreshUsageLimits(providerId));
      if (!mounted.current) return;
      setState({
        providers: response.providers,
        loading: false,
        refreshing: false,
        error: null,
        fetchedAt: response.fetchedAt,
      });
    } catch (error) {
      if (!mounted.current) return;
      setState((previous) => ({
        ...previous,
        refreshing: false,
        error: usageErrorMessage(error),
      }));
    }
  }, []);

  return {
    ...state,
    refresh: () => void load(true),
    refreshProvider,
  };
}
