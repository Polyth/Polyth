// Generic quota service (WP12). Provider-neutral: adapters implement fetch()
// and are registered by the server; this service polls with jitter, dedupes
// in-flight requests, backs off after failures, and always keeps the last-good
// snapshot so the UI can render stale-with-reason instead of a blank.
//
// Quota data is account telemetry — it is never appended to any session log,
// and error messages are redacted so credentials cannot leak to the browser.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { QuotaPace, QuotaSnapshot, QuotaWindow } from "@polyth/contracts";
import { computePace, type QuotaSample } from "./pace.ts";

export { computePace, usableSamples } from "./pace.ts";
export type { QuotaSample, PaceOptions } from "./pace.ts";
export { buildProviderUsageOverview } from "./overview.ts";
export type { ProviderUsageOverview } from "./overview.ts";
export { createHttpQuotaProvider, parseQuotaProviderSpecs } from "./http.ts";
export type { HttpQuotaProviderSpec, HttpQuotaProviderOptions } from "./http.ts";
export {
  discoverQuotaProviders,
  listConfiguredQuotaProviders,
  mapProviderUsage,
} from "./providers/index.ts";
export type { QuotaDiscoveryOptions, QuotaDiscoveryPaths } from "./providers/index.ts";
export { USAGE_WIDGETS } from "../widgets/catalog.ts";

export interface QuotaProvider {
  id: string;
  fetch(signal: AbortSignal): Promise<QuotaSnapshot>;
}

export interface UsageServiceOptions {
  pollMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  /** bounded last-good snapshot persistence */
  file?: string;
  now?: () => number;
}

export interface UsageService {
  register(provider: QuotaProvider): void;
  providerIds(): string[];
  /** last-good snapshots; failed providers appear stale with a redacted reason */
  snapshots(): QuotaSnapshot[];
  /** per-window pace for one provider, computed from the sample history */
  pace(providerId: string): Record<string, QuotaPace | null>;
  refresh(providerId: string): Promise<QuotaSnapshot>;
  start(): void;
  stop(): void;
}

/** Strip token-looking strings out of anything that could reach the browser. */
export const redactSecrets = (text: string): string =>
  text
    .replace(/(bearer|token|key|authorization)([=:\s]+)\S+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");

const MAX_SAMPLES = 60;

const sanitizeWindows = (windows: unknown): QuotaWindow[] | null => {
  if (!Array.isArray(windows)) return null;
  const out: QuotaWindow[] = [];
  for (const w of windows) {
    const win = w as QuotaWindow;
    if (typeof win?.id !== "string" || !win.id) return null;
    if (!Number.isFinite(win.used) || !Number.isFinite(win.limit) || win.used < 0) return null;
    out.push({
      id: win.id,
      label: typeof win.label === "string" ? win.label : win.id,
      used: win.used,
      limit: win.limit,
      unit: ["tokens", "requests", "currency", "percent"].includes(win.unit) ? win.unit : "requests",
      ...(Number.isFinite(win.resetsAt) ? { resetsAt: win.resetsAt } : {}),
      ...(Number.isFinite(win.periodMs) && win.periodMs! > 0 ? { periodMs: win.periodMs } : {}),
    });
  }
  return out;
};

export function createUsageService(opts: UsageServiceOptions = {}): UsageService {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 5 * 60_000;
  const jitterMs = opts.jitterMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const providers = new Map<string, QuotaProvider>();
  const lastGood = new Map<string, QuotaSnapshot>();
  const lastError = new Map<string, { code: string; message: string }>();
  const inFlight = new Map<string, Promise<QuotaSnapshot>>();
  const failures = new Map<string, number>();
  const nextAllowedAt = new Map<string, number>();
  const samples = new Map<string, QuotaSample[]>(); // key: providerId/windowId
  let timer: ReturnType<typeof setInterval> | null = null;

  // restore bounded last-good snapshots; honestly marked stale until refetched
  if (opts.file) {
    try {
      const raw = JSON.parse(readFileSync(opts.file, "utf8")) as QuotaSnapshot[];
      for (const s of raw) {
        lastGood.set(s.providerId, s);
        lastError.set(s.providerId, { code: "not-refreshed", message: "restored from the last run" });
      }
    } catch { /* first run */ }
  }
  const persist = () => {
    if (!opts.file) return;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      atomicWriteSync(opts.file, JSON.stringify([...lastGood.values()]));
    } catch { /* best effort */ }
  };

  const recordSamples = (snapshot: QuotaSnapshot) => {
    for (const w of snapshot.windows) {
      const key = `${snapshot.providerId}/${w.id}`;
      const list = samples.get(key) ?? [];
      list.push({ at: snapshot.fetchedAt, used: w.used });
      if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
      samples.set(key, list);
    }
  };

  const doFetch = async (provider: QuotaProvider): Promise<QuotaSnapshot> => {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(new Error("quota fetch timed out")), timeoutMs);
    try {
      const raw = await provider.fetch(ac.signal);
      const windows = sanitizeWindows(raw?.windows);
      if (!windows) throw new Error("provider returned malformed quota windows");
      const snapshot: QuotaSnapshot = {
        providerId: provider.id,
        ...(typeof raw.accountLabel === "string" ? { accountLabel: raw.accountLabel } : {}),
        windows,
        fetchedAt: now(),
        stale: false,
      };
      lastGood.set(provider.id, snapshot);
      lastError.delete(provider.id);
      failures.delete(provider.id);
      nextAllowedAt.delete(provider.id);
      recordSamples(snapshot);
      persist();
      return snapshot;
    } catch (e) {
      const n = (failures.get(provider.id) ?? 0) + 1;
      failures.set(provider.id, n);
      nextAllowedAt.set(provider.id, now() + Math.min(30 * 60_000, pollMs * 2 ** Math.min(n, 5)));
      lastError.set(provider.id, {
        code: ac.signal.aborted ? "timeout" : "fetch-failed",
        message: redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300),
      });
      return viewOf(provider.id);
    } finally {
      clearTimeout(timeout);
    }
  };

  const viewOf = (providerId: string): QuotaSnapshot => {
    const good = lastGood.get(providerId);
    const error = lastError.get(providerId);
    if (good) return { ...good, stale: error !== undefined, ...(error ? { error } : {}) };
    return {
      providerId, windows: [], fetchedAt: 0, stale: true,
      error: error ?? { code: "never-fetched", message: "no quota data yet" },
    };
  };

  const refresh = (providerId: string): Promise<QuotaSnapshot> => {
    const provider = providers.get(providerId);
    if (!provider) {
      return Promise.reject(Object.assign(new Error("unknown quota provider"), { code: "not-found" }));
    }
    // parallel clients share one in-flight request
    let p = inFlight.get(providerId);
    if (!p) {
      p = doFetch(provider).finally(() => inFlight.delete(providerId));
      inFlight.set(providerId, p);
    }
    return p;
  };

  const pollOne = (provider: QuotaProvider) => {
    const gate = nextAllowedAt.get(provider.id) ?? 0;
    if (now() < gate) return; // backing off
    setTimeout(() => void refresh(provider.id).catch(() => {}), Math.random() * jitterMs);
  };

  return {
    register(provider) {
      providers.set(provider.id, provider);
    },
    providerIds: () => [...providers.keys()],
    snapshots: () => [...providers.keys()].map(viewOf),
    pace(providerId) {
      const snap = lastGood.get(providerId);
      const out: Record<string, QuotaPace | null> = {};
      for (const w of snap?.windows ?? []) {
        out[w.id] = computePace(w, samples.get(`${providerId}/${w.id}`) ?? [], { now: now() });
      }
      return out;
    },
    refresh,
    start() {
      if (timer) return;
      for (const p of providers.values()) pollOne(p);
      timer = setInterval(() => { for (const p of providers.values()) pollOne(p); }, pollMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** Deterministic in-memory provider for development and tests. Enabled on the
 *  server via POLYTH_FAKE_QUOTAS=1 — never by default. */
export function createFakeQuotaProvider(id = "fake-provider"): QuotaProvider {
  let used = 120;
  return {
    id,
    async fetch() {
      used += 7;
      const nowMs = Date.now();
      const period = 24 * 60 * 60_000;
      return {
        providerId: id,
        accountLabel: "demo account",
        windows: [
          { id: "requests-day", label: "Requests (24h)", used, limit: 1000, unit: "requests", resetsAt: nowMs + period / 2, periodMs: period },
          { id: "spend-month", label: "Spend (month)", used: used / 40, limit: 50, unit: "currency", resetsAt: nowMs + 12 * period, periodMs: 30 * period },
        ],
        fetchedAt: nowMs,
        stale: false,
      };
    },
  };
}
