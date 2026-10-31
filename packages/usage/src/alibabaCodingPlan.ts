import type { QuotaSnapshot, QuotaWindow, SpaceContext } from "@polyth/contracts";
import type { UsageObservation } from "./analytics/contracts.ts";
import { getAuthEntry, stringValue, type QuotaRuntime } from "./opencodeAuth.ts";

/**
 * Alibaba Coding Plan has no usage endpoint. The plan is estimated from the
 * signed-in account's canonical Polyth usage observations, so the source is
 * per-Space: the route asks the analytics service for the requesting Space
 * only. A global QuotaProvider would have to cross tenant boundaries.
 *
 * The estimate counts one request per exact (or token-estimated) usage
 * observation of a completed turn. Failed, cancelled and still-running turns
 * and derived legacy backfill are left out, so it can under-count requests the
 * plan billed for a turn that later failed; it never counts a guess.
 */
export const ALIBABA_CODING_PLAN_ID = "alibaba-coding-plan";
const PROVIDER_IDS = new Set([ALIBABA_CODING_PLAN_ID, "alibaba"]);
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

export type AlibabaCodingPlanTier = "lite" | "pro";

export const ALIBABA_CODING_PLAN_LIMITS: Readonly<
  Record<AlibabaCodingPlanTier, { fiveHour: number; weekly: number; monthly: number }>
> = {
  lite: { fiveHour: 1200, weekly: 9000, monthly: 18000 },
  pro: { fiveHour: 6000, weekly: 45000, monthly: 90000 },
};

export interface AlibabaCodingPlanWindow {
  used: number;
  limit: number;
  resetsAt?: number;
}

export interface AlibabaCodingPlanQuota {
  tier: AlibabaCodingPlanTier;
  fiveHour: AlibabaCodingPlanWindow;
  weekly: AlibabaCodingPlanWindow;
  monthly: AlibabaCodingPlanWindow;
}

const windowFor = (
  timestamps: readonly number[],
  now: number,
  windowMs: number,
  limit: number,
): AlibabaCodingPlanWindow => {
  const floor = now - windowMs;
  let used = 0;
  let oldest: number | null = null;
  for (const at of timestamps) {
    if (at < floor || at > now) continue;
    used += 1;
    if (oldest === null || at < oldest) oldest = at;
  }
  return {
    used,
    limit,
    ...(oldest !== null ? { resetsAt: oldest + windowMs } : {}),
  };
};

export const computeAlibabaCodingPlanQuota = (params: {
  timestamps: readonly number[];
  tier: AlibabaCodingPlanTier;
  now: number;
  limits?: { fiveHour: number; weekly: number; monthly: number };
}): AlibabaCodingPlanQuota => {
  const limits = params.limits ?? ALIBABA_CODING_PLAN_LIMITS[params.tier];
  return {
    tier: params.tier,
    fiveHour: windowFor(params.timestamps, params.now, FIVE_HOUR_MS, limits.fiveHour),
    weekly: windowFor(params.timestamps, params.now, WEEKLY_MS, limits.weekly),
    monthly: windowFor(params.timestamps, params.now, MONTHLY_MS, limits.monthly),
  };
};

const normalizeTier = (value: string | null): AlibabaCodingPlanTier => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "pro" || normalized === "professional" ? "pro" : "lite";
};

const readTier = (runtime: QuotaRuntime): AlibabaCodingPlanTier => {
  const entry = getAuthEntry(runtime.readAuth(), [ALIBABA_CODING_PLAN_ID, "alibaba"]);
  const tier = stringValue(entry?.tier)
    ?? stringValue(entry?.planTier)
    ?? stringValue(entry?.plan_tier)
    ?? stringValue(entry?.subscriptionTier);
  return normalizeTier(tier);
};

const isConfigured = (runtime: QuotaRuntime): boolean => {
  const envKey = stringValue(runtime.env.ALIBABA_CODING_PLAN_API_KEY)
    ?? stringValue(runtime.env.ALIBABA_API_KEY);
  if (envKey) return true;
  const entry = getAuthEntry(runtime.readAuth(), [ALIBABA_CODING_PLAN_ID, "alibaba"]);
  return Boolean(stringValue(entry?.key) ?? stringValue(entry?.token));
};

const toWindow = (
  id: string,
  label: string,
  window: AlibabaCodingPlanWindow,
  periodMs: number,
): QuotaWindow => ({
  id,
  label,
  used: window.used,
  limit: window.limit,
  unit: "requests",
  periodMs,
  ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
});

export interface AlibabaCodingPlanSource {
  id: string;
  isConfigured(): boolean;
  snapshot(space: SpaceContext, signal?: AbortSignal): Promise<QuotaSnapshot>;
}

export const createAlibabaCodingPlanSource = (options: {
  runtime: QuotaRuntime;
  observations: (space: SpaceContext, from: number) => Promise<UsageObservation[]>;
  now?: () => number;
}): AlibabaCodingPlanSource => {
  const now = options.now ?? Date.now;
  return {
    id: ALIBABA_CODING_PLAN_ID,
    isConfigured: () => isConfigured(options.runtime),
    async snapshot(space, signal): Promise<QuotaSnapshot> {
      if (!isConfigured(options.runtime)) throw new Error("Alibaba Coding Plan is not configured");
      if (signal?.aborted) throw new Error("Alibaba Coding Plan request aborted");
      const at = now();
      const observations = await options.observations(space, at - MONTHLY_MS);
      const byObservation = new Map<string, number>();
      for (const observation of observations) {
        if (
          observation.timestamp < at - MONTHLY_MS
          || observation.timestamp > at
          || observation.providerId === undefined
          || !PROVIDER_IDS.has(observation.providerId)
          // Only requests of a turn that completed count. A missing status is
          // a turn still running (or one whose stop was never recorded), and a
          // derived observation is a legacy fallback — possibly a whole
          // session's cumulative totals — not one request.
          || observation.status !== "completed"
          || observation.quality === "derived"
        ) continue;
        byObservation.set(observation.id, observation.timestamp);
      }
      const timestamps = [...byObservation.values()];
      const tier = readTier(options.runtime);
      const quota = computeAlibabaCodingPlanQuota({ timestamps, tier, now: at });
      const label = tier === "pro" ? "Pro" : "Lite";
      const windows = [
        toWindow("5h", "5h", quota.fiveHour, FIVE_HOUR_MS),
        toWindow("weekly", "Weekly", quota.weekly, WEEKLY_MS),
        toWindow("monthly", "Monthly", quota.monthly, MONTHLY_MS),
      ];
      return {
        providerId: ALIBABA_CODING_PLAN_ID,
        accountLabel: `Alibaba Coding Plan (${label})`,
        windows,
        fetchedAt: at,
        stale: false,
      };
    },
  };
};
