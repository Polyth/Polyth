import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { QuotaPace, QuotaSnapshot, QuotaWindow } from "@polyth/contracts";
import { computePace, type QuotaSample } from "./pace.ts";

export interface QuotaProvider {
  id: string;
  fetch(signal: AbortSignal): Promise<QuotaSnapshot>;
  /** Present when the source is one account of a multi-account harness. Read
   * on every view so an account rename shows without re-registering. */
  account?(): UsageLimitAccount;
  /** An opaque digest of the stored login, or null when there is none. When it
   * changes after a failed fetch (the person signed in again, or the harness
   * renewed its token) the next poll fetches at once instead of backing off. */
  credentialFingerprint?(): string | null;
}

/** Identifies one account of a multi-account harness, e.g. a second Claude Code login. */
export interface UsageLimitAccount {
  /** The source the account belongs to, e.g. `claude`. */
  family: string;
  /** The harness that runs on this account; equal to the source id. */
  harnessId: string;
  label: string;
}

export interface UsageLimitServiceOptions {
  pollMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  file?: string;
  historyMs?: number;
  now?: () => number;
  /** Brings dynamically discovered sources (harness accounts) up to date before
   * each poll and read. Must be cheap and must not start a process. */
  reconcile?: () => void;
}

export interface UsageLimitBalance {
  id: string;
  label: string;
  amount?: number;
  unit: QuotaWindow["unit"];
  valueLabel?: string;
}

export interface UsageLimitSnapshot extends QuotaSnapshot {
  balances: UsageLimitBalance[];
  pace: Record<string, QuotaPace | null>;
  account?: UsageLimitAccount;
}

export interface UsageLimitService {
  register(provider: QuotaProvider): void;
  unregister(providerId: string): void;
  providerIds(): string[];
  snapshots(): UsageLimitSnapshot[];
  pace(providerId: string): Record<string, QuotaPace | null>;
  refresh(providerId: string): Promise<UsageLimitSnapshot>;
  refreshAll(): Promise<UsageLimitSnapshot[]>;
  start(): void;
  stop(): void;
}

interface PersistedLimitsV1 {
  version: 1;
  snapshots: QuotaSnapshot[];
  samples: Record<string, QuotaSample[]>;
}

const DEFAULT_POLL_MS = 5 * 60_000;
const DEFAULT_JITTER_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Error codes a provider may set itself; anything else reads as `fetch-failed`. */
const PROVIDER_ERROR_CODE = /^[a-z][a-z-]{0,39}$/;

const DEFAULT_HISTORY_MS = 30 * 24 * 60 * 60_000;
const MAX_SAMPLES_PER_WINDOW = 256;
const UNCHANGED_SAMPLE_INTERVAL_MS = 15 * 60_000;

export const redactLimitSecrets = (text: string): string =>
  text
    .replace(/(bearer|token|key|authorization)([=:\s]+)\S+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");

const sanitizeWindows = (windows: unknown): QuotaWindow[] | null => {
  if (!Array.isArray(windows)) return null;
  const out: QuotaWindow[] = [];
  for (const raw of windows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const win = raw as QuotaWindow;
    if (typeof win.id !== "string" || !win.id.trim()) return null;
    if (!Number.isFinite(win.used) || !Number.isFinite(win.limit) || win.used < 0 || win.limit < 0) return null;
    out.push({
      id: win.id.slice(0, 256),
      label: typeof win.label === "string" && win.label.trim() ? win.label.slice(0, 256) : win.id.slice(0, 256),
      used: win.used,
      limit: win.limit,
      unit: ["tokens", "requests", "currency", "percent"].includes(win.unit) ? win.unit : "requests",
      ...(Number.isFinite(win.resetsAt) ? { resetsAt: win.resetsAt } : {}),
      ...(Number.isFinite(win.periodMs) && win.periodMs! > 0 ? { periodMs: win.periodMs } : {}),
    });
  }
  return out;
};

const sanitizeSnapshot = (raw: unknown): QuotaSnapshot | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as QuotaSnapshot;
  if (typeof value.providerId !== "string" || !value.providerId.trim()) return null;
  const windows = sanitizeWindows(value.windows);
  if (!windows) return null;
  return {
    providerId: value.providerId.slice(0, 256),
    ...(typeof value.accountLabel === "string" && value.accountLabel.trim()
      ? { accountLabel: value.accountLabel.slice(0, 256) }
      : {}),
    windows,
    fetchedAt: Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0,
    stale: Boolean(value.stale),
  };
};

const isQuotaSample = (value: unknown): value is QuotaSample =>
  Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value)
  && Number.isFinite((value as QuotaSample).at)
  && Number.isFinite((value as QuotaSample).used)
  && (value as QuotaSample).used >= 0;


const balanceFromWindow = (window: QuotaWindow): UsageLimitBalance | null => {
  if (window.resetsAt !== undefined || window.periodMs !== undefined || window.used !== 0) return null;
  if (!/(?:balance|available|credits?|purchased|free)/i.test(`${window.id} ${window.label}`)) return null;
  const separator = window.label.indexOf(" · ");
  const label = separator > 0 ? window.label.slice(0, separator) : window.label;
  const valueLabel = separator > 0 ? window.label.slice(separator + 3) : undefined;
  return {
    id: window.id,
    label,
    ...(window.limit > 0 ? { amount: window.limit } : {}),
    unit: window.unit,
    ...(valueLabel ? { valueLabel } : {}),
  };
};

export function createUsageLimitService(opts: UsageLimitServiceOptions = {}): UsageLimitService {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const historyMs = opts.historyMs ?? DEFAULT_HISTORY_MS;

  const providers = new Map<string, QuotaProvider>();
  const lastGood = new Map<string, QuotaSnapshot>();
  const lastError = new Map<string, { code: string; message: string }>();
  const inFlight = new Map<string, Promise<UsageLimitSnapshot>>();
  const failures = new Map<string, number>();
  const nextAllowedAt = new Map<string, number>();
  /** The login a source failed with, so a changed one skips the backoff. */
  const failedWith = new Map<string, string | null>();
  const samples = new Map<string, QuotaSample[]>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const pruneSamples = (list: QuotaSample[]): QuotaSample[] => {
    const cutoff = now() - historyMs;
    return list
      .filter((sample) => sample.at >= cutoff && Number.isFinite(sample.at) && Number.isFinite(sample.used))
      .slice(-MAX_SAMPLES_PER_WINDOW);
  };

  if (opts.file) {
    try {
      const parsed = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
      const restoredSnapshots = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Partial<PersistedLimitsV1>).snapshots
          : undefined;
      if (Array.isArray(restoredSnapshots)) {
        for (const raw of restoredSnapshots) {
          const snapshot = sanitizeSnapshot(raw);
          if (!snapshot) continue;
          lastGood.set(snapshot.providerId, snapshot);
          lastError.set(snapshot.providerId, { code: "not-refreshed", message: "restored from the last run" });
        }
      }

      const restoredSamples = !Array.isArray(parsed) && parsed && typeof parsed === "object"
        ? (parsed as Partial<PersistedLimitsV1>).samples
        : undefined;
      if (restoredSamples && typeof restoredSamples === "object" && !Array.isArray(restoredSamples)) {
        for (const [key, list] of Object.entries(restoredSamples)) {
          if (!Array.isArray(list)) continue;
          const clean = pruneSamples(list.filter(isQuotaSample));
          if (clean.length) samples.set(key, clean);
        }
      }
    } catch {
      // First run, old/corrupt cache, or a cache from a newer version.
    }
  }

  const persist = () => {
    if (!opts.file) return;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      const sampleRecord: Record<string, QuotaSample[]> = {};
      for (const [key, list] of samples) {
        const clean = pruneSamples(list);
        if (clean.length) sampleRecord[key] = clean;
      }
      const payload: PersistedLimitsV1 = {
        version: 1,
        snapshots: [...lastGood.values()],
        samples: sampleRecord,
      };
      atomicWriteSync(opts.file, JSON.stringify(payload));
    } catch {
      // Limits are operational telemetry; persistence failure must not block turns.
    }
  };

  const recordSamples = (snapshot: QuotaSnapshot) => {
    for (const window of snapshot.windows) {
      if (!Number.isFinite(window.used) || window.used < 0) continue;
      const key = `${snapshot.providerId}/${window.id}`;
      const list = pruneSamples(samples.get(key) ?? []);
      const previous = list.at(-1);
      const meaningful = !previous
        || previous.used !== window.used
        || snapshot.fetchedAt - previous.at >= UNCHANGED_SAMPLE_INTERVAL_MS;
      if (meaningful) list.push({ at: snapshot.fetchedAt, used: window.used });
      samples.set(key, pruneSamples(list));
    }
  };

  const paceFor = (providerId: string): Record<string, QuotaPace | null> => {
    const snapshot = lastGood.get(providerId);
    const result: Record<string, QuotaPace | null> = {};
    for (const window of snapshot?.windows ?? []) {
      result[window.id] = computePace(
        window,
        samples.get(`${providerId}/${window.id}`) ?? [],
        { now: now() },
      );
    }
    return result;
  };

  const viewOf = (providerId: string): UsageLimitSnapshot => {
    const good = lastGood.get(providerId);
    const error = lastError.get(providerId);
    const base: QuotaSnapshot = good
      ? {
          ...good,
          stale: error !== undefined,
          ...(error ? { error } : {}),
        }
      : {
          providerId,
          windows: [],
          fetchedAt: 0,
          stale: true,
          error: error ?? { code: "never-fetched", message: "no limit data yet" },
        };
    const balances = base.windows
      .map(balanceFromWindow)
      .filter((balance): balance is UsageLimitBalance => balance !== null);
    const windows = base.windows.filter((window) => balanceFromWindow(window) === null);
    const account = providers.get(providerId)?.account?.();
    return { ...base, windows, balances, pace: paceFor(providerId), ...(account ? { account } : {}) };
  };

  const fingerprintOf = (provider: QuotaProvider): string | null => {
    try {
      return provider.credentialFingerprint?.() ?? null;
    } catch {
      return null;
    }
  };

  const doFetch = async (provider: QuotaProvider): Promise<UsageLimitSnapshot> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("limit fetch timed out")),
      timeoutMs,
    );
    try {
      const raw = await provider.fetch(controller.signal);
      const windows = sanitizeWindows(raw?.windows);
      if (!windows) throw new Error("provider returned malformed limit windows");
      const snapshot: QuotaSnapshot = {
        providerId: provider.id,
        ...(typeof raw.accountLabel === "string" && raw.accountLabel.trim()
          ? { accountLabel: raw.accountLabel.slice(0, 256) }
          : {}),
        windows,
        fetchedAt: now(),
        stale: false,
      };
      lastGood.set(provider.id, snapshot);
      lastError.delete(provider.id);
      failures.delete(provider.id);
      nextAllowedAt.delete(provider.id);
      failedWith.delete(provider.id);
      recordSamples(snapshot);
      persist();
      return viewOf(provider.id);
    } catch (error) {
      const failureCount = (failures.get(provider.id) ?? 0) + 1;
      failures.set(provider.id, failureCount);
      nextAllowedAt.set(
        provider.id,
        now() + Math.min(30 * 60_000, pollMs * 2 ** Math.min(failureCount, 5)),
      );
      failedWith.set(provider.id, fingerprintOf(provider));
      const code = (error as { code?: unknown } | null)?.code;
      lastError.set(provider.id, {
        code: controller.signal.aborted
          ? "timeout"
          : typeof code === "string" && PROVIDER_ERROR_CODE.test(code) ? code : "fetch-failed",
        message: redactLimitSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      return viewOf(provider.id);
    } finally {
      clearTimeout(timeout);
    }
  };

  const credentialChanged = (provider: QuotaProvider): boolean =>
    failedWith.has(provider.id) && fingerprintOf(provider) !== failedWith.get(provider.id);

  const reconcile = () => {
    try {
      opts.reconcile?.();
    } catch {
      // Discovery is best effort; the statically registered sources still serve.
    }
  };

  const refresh = (providerId: string): Promise<UsageLimitSnapshot> => {
    const provider = providers.get(providerId);
    if (!provider) {
      return Promise.reject(Object.assign(new Error("unknown limit provider"), { code: "not-found" }));
    }
    const existing = inFlight.get(providerId);
    if (existing) return existing;
    const request = doFetch(provider).finally(() => inFlight.delete(providerId));
    inFlight.set(providerId, request);
    return request;
  };

  const pollOne = (provider: QuotaProvider) => {
    if (now() < (nextAllowedAt.get(provider.id) ?? 0) && !credentialChanged(provider)) return;
    const delay = jitterMs > 0 ? Math.random() * jitterMs : 0;
    const handle = setTimeout(() => void refresh(provider.id).catch(() => {}), delay);
    handle.unref?.();
  };

  return {
    register(provider) {
      const added = !providers.has(provider.id);
      providers.set(provider.id, provider);
      // A source discovered between polls (a newly added account) is fetched
      // now rather than waiting out the poll interval.
      if (added && timer && !polling) pollOne(provider);
    },
    unregister(providerId) {
      providers.delete(providerId);
      failedWith.delete(providerId);
    },
    providerIds: () => {
      reconcile();
      return [...providers.keys()];
    },
    snapshots: () => {
      reconcile();
      return [...providers.keys()].map(viewOf);
    },
    pace: paceFor,
    refresh(providerId) {
      reconcile();
      return refresh(providerId);
    },
    async refreshAll() {
      reconcile();
      return Promise.all([...providers.keys()].map((providerId) => refresh(providerId)));
    },
    start() {
      if (timer) return;
      const poll = () => {
        polling = true;
        try {
          reconcile();
        } finally {
          polling = false;
        }
        for (const provider of providers.values()) pollOne(provider);
      };
      poll();
      timer = setInterval(poll, pollMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function createFakeLimitProvider(id = "fake-provider"): QuotaProvider {
  let used = 120;
  return {
    id,
    async fetch() {
      used += 7;
      const at = Date.now();
      const day = 24 * 60 * 60_000;
      return {
        providerId: id,
        accountLabel: "demo account",
        windows: [
          {
            id: "requests-day",
            label: "Requests (24h)",
            used,
            limit: 1000,
            unit: "requests",
            resetsAt: at + day / 2,
            periodMs: day,
          },
          {
            id: "spend-month",
            label: "Spend (month)",
            used: used / 40,
            limit: 50,
            unit: "currency",
            resetsAt: at + 12 * day,
            periodMs: 30 * day,
          },
        ],
        fetchedAt: at,
        stale: false,
      };
    },
  };
}
