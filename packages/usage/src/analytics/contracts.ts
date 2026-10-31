import type { Project, SessionEvent, SessionProjection } from "@polyth/contracts";

export type UsageQuality = "exact" | "derived" | "estimated";
export type UsageObservationStatus = "completed" | "failed" | "cancelled";
export type UsageAgentKind = "main" | "subagent";
export type UsageRangePreset = "7d" | "30d" | "90d" | "all" | "custom";
export type UsageBucket = "hour" | "day" | "week" | "month";
export type UsageChartMetric = "tokens" | "cost" | "turns";
export type UsageDetailSort = "activity" | "tokens" | "cost" | "turns";

/**
 * Canonical provider/harness-neutral observation. Every numeric token field is
 * nullable because absence is not a measured zero. `reasoning` is treated as a
 * subset of output by the adapter contract and is therefore never added twice
 * to `totalModelTokens`.
 */
export interface UsageTokenBreakdown {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface UsageTiming {
  totalMs?: number;
  modelMs?: number;
  toolMs?: number;
  ttftMs?: number;
}

export interface UsageObservation {
  id: string;
  timestamp: number;
  projectId: string;
  sessionId: string;
  turnId?: string;
  providerId?: string;
  modelId?: string;
  modelVariant?: string;
  harnessId?: string;
  agentKind?: UsageAgentKind;
  tokens: UsageTokenBreakdown;
  /** Known reported/delta cost only. Unknown cost remains absent. */
  cost?: number;
  costSource?: "exact" | "derived" | "estimated";
  timing?: UsageTiming;
  steps?: number;
  retries?: number;
  status?: UsageObservationStatus;
  quality: UsageQuality;
}

/** Canonical query used by every scoped total, chart, breakdown and detail. */
export interface UsageStatsQuery {
  /** Preset ranges resolve against local calendar boundaries in `timezone`. */
  range: UsageRangePreset;
  /** Required for `custom`; ignored for named presets. Epoch milliseconds. */
  from?: number;
  to?: number;
  /** IANA viewer timezone, for example `Europe/Kyiv`. */
  timezone: string;
  /** Omitted or empty means all projects accessible in the current Space. */
  projectIds?: string[];
  /** Optional exact session scope. Used by the Session usage surface. */
  sessionIds?: string[];
  bucket?: UsageBucket;
  detailLimit?: number;
  detailSort?: UsageDetailSort;
}

export interface UsageTrend {
  direction: "up" | "down" | "flat";
  percent: number | null;
  current: number | null;
  previous: number | null;
}

/**
 * Where a prompt-cache lifetime came from. `provider-default` is a documented
 * fixed default for the provider; `observed` is proven by a cache hit after an
 * idle gap longer than that default. Nothing else is guessed.
 */
export type UsageCacheTtlBasis = "observed" | "provider-default" | "unknown";

/**
 * Prompt prefix re-written after the cache went cold: a request that wrote
 * cache instead of reading the prefix the previous request had cached, after
 * an idle gap of at least the cache lifetime (or the shortest documented one
 * when the lifetime is unknown), on the same model.
 */
export interface UsageCacheBurn {
  rewrites: number;
  tokens: number;
}

/** Current prompt-cache state of one session, from its latest cache activity. */
export interface UsageCacheHealth {
  /** Time of the latest observation that read or wrote cache. */
  lastActivityAt: number;
  providerId?: string;
  modelId?: string;
  ttlMs: number | null;
  ttlBasis: UsageCacheTtlBasis;
  /** Read + write of the latest cache activity: the prefix a cold cache re-writes. */
  cachedTokens: number;
  burn: UsageCacheBurn;
}

export interface UsageAggregate {
  observations: number;
  sessions: number;
  /** Null when no selected observation carried a recoverable turn id. */
  turns: number | null;
  turnsComplete: boolean;
  subagents: number;
  tokens: UsageTokenBreakdown & {
    /** input + output + cache read + cache write; reasoning is a subset of output. */
    total: number | null;
    /** False when any selected observation omitted a total-token component. */
    totalComplete: boolean;
  };
  cacheHitPercent: number | null;
  /**
   * Cache re-written after expiry. Null when no selected observation reported
   * cache writes; absent in reports from older servers.
   */
  cacheBurn?: UsageCacheBurn | null;
  cost: number | null;
  /** False when at least one selected observation had unknown cost. */
  costComplete: boolean;
  averageCostPerSession: number | null;
  averageCostPerThousand: number | null;
  activeDays: number;
  longestActivityStreak: number;
  steps: number | null;
  retries: number | null;
  timing: {
    /** Sum of measured turn wall times in the selected scope. */
    totalMs: number | null;
    /** Sum of measured model-active time in the selected scope. */
    modelMs: number | null;
    /** Sum of measured tool-active time in the selected scope. */
    toolMs: number | null;
    /** Average TTFT across measured turns. */
    ttftMs: number | null;
  } | null;
  rates: {
    /** Output tokens divided by measured model-active time. */
    responseTokPerSec: number | null;
    /** Output tokens divided by measured whole-turn time. */
    wholeTurnTokPerSec: number | null;
  } | null;
  quality: Record<UsageQuality, number>;
  status: {
    completed: number;
    failed: number;
    cancelled: number;
    unknown: number;
  };
}

export interface UsageGroupSummary {
  id: string;
  label: string;
  detail?: string;
  metrics: UsageAggregate;
  trend?: UsageTrend;
}

export interface UsageChartBucket {
  start: number;
  end: number;
  label: string;
  values: {
    tokens: number | null;
    tokensComplete: boolean;
    cost: number | null;
    costComplete: boolean;
    turns: number | null;
    turnsComplete: boolean;
    sessions: number;
  };
}

export interface UsageSessionDetail {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  projectPath?: string;
  lastActivityAt: number;
  metrics: UsageAggregate;
  status: SessionProjection["status"];
  /** Absent when the session never reported cache telemetry, or from older servers. */
  cache?: UsageCacheHealth;
}

export interface UsageTurnDetail {
  id: string;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
  timestamp: number;
  modelId?: string;
  modelVariant?: string;
  metrics: UsageAggregate;
  status?: UsageObservationStatus;
  timing?: UsageTiming;
}

export interface UsageDataCoverage {
  exactObservations: number;
  derivedObservations: number;
  estimatedObservations: number;
  /** Sessions with cumulative totals but no recoverable usage event. */
  backfilledSessions: number;
  syncedSessions: number;
  syncedAt: number;
}

export interface UsageStatsReport {
  schemaVersion: 1;
  serverInstanceId: string;
  spaceId: string;
  query: UsageStatsQuery;
  effective: {
    range: UsageRangePreset;
    from: number;
    to: number;
    previousFrom?: number;
    previousTo?: number;
    timezone: string;
  };
  generatedAt: number;
  totals: UsageAggregate;
  trends: {
    tokens: UsageTrend | null;
    cost: UsageTrend | null;
    sessions: UsageTrend | null;
    turns: UsageTrend | null;
  };
  chart: {
    bucket: UsageBucket;
    buckets: UsageChartBucket[];
  };
  projects: UsageGroupSummary[];
  models: UsageGroupSummary[];
  /**
   * One group per harness that ran the selected observations, keyed by the
   * canonical harness id. Observations without a recorded harness form the
   * `unknown` group rather than disappearing from the breakdown.
   */
  harnesses: UsageGroupSummary[];
  sessions: UsageSessionDetail[];
  turns: UsageTurnDetail[];
  detailCoverage: {
    sessionsTotal: number;
    turnsTotal: number;
    sessionsTruncated: boolean;
    turnsTruncated: boolean;
  };
  coverage: UsageDataCoverage;
}

export interface UsageStatsIdentity {
  serverInstanceId: string;
  spaceId: string;
}

export interface UsageCollectionProjection {
  projection: SessionProjection;
  events: readonly SessionEvent[];
}

export interface UsageProjectInfo {
  id: string;
  name: string;
  path?: string;
}

export type UsageProjectResolver = () => Promise<readonly Project[]>;
