export type UsageAnalyticsMetric =
  | "recordedCost"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "cachePercent"
  | "outputTokPerSec"
  | "wholeTurnTokPerSec"
  | "ttftMs"
  | "turnDurationMs"
  | "modelTimeMs"
  | "toolTimeMs"
  | "contextUsedTokens"
  | "contextPercent"
  | "successRate"
  | "errorRate"
  | "turns"
  | "sessions";

export type UsageAnalyticsGroupBy = "none" | "provider" | "model" | "harness" | "project";
export type UsageAnalyticsAggregation = "sum" | "average" | "p50" | "p95";
export type UsageObservationStatus = "success" | "failed" | "aborted";

export interface UsageObservation {
  timestamp: number;
  projectId: string;
  sessionId: string;
  turnId: string;
  harnessId: string | null;
  providerId: string;
  modelId: string;
  agentId: string | null;
  agentRole: string | null;
  workflowId: string | null;
  parentSessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Canonical provider/runtime cost telemetry. For subscription-backed
   * providers this is an API-equivalent workload value, not cash spent.
   * Billing metadata decides how the UI presents it.
   */
  recordedCost: number | null;
  costSource: string | null;
  turnDurationMs: number;
  modelTimeMs: number;
  toolTimeMs: number;
  ttftMs: number | null;
  outputTokPerSec: number | null;
  wholeTurnTokPerSec: number | null;
  steps: number;
  contextUsedTokens: number | null;
  contextLimitTokens: number | null;
  status: UsageObservationStatus;
  retry: boolean;
  regenerated: boolean;
  aborted: boolean;
  failed: boolean;
}

export interface UsageAnalyticsQuery {
  from: number;
  to: number;
  metric: UsageAnalyticsMetric;
  groupBy: UsageAnalyticsGroupBy;
  aggregation: UsageAnalyticsAggregation;
  projectId?: string;
  providerId?: string;
  modelId?: string;
  harnessId?: string;
  limit: number;
}

export interface UsagePerformanceStats {
  average: number | null;
  p50: number | null;
  p95: number | null;
}

export interface UsageAnalyticsSummary {
  observations: number;
  sessions: number;
  recordedCost: number;
  costKnownTurns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cachePercent: number | null;
  successRate: number | null;
  errorRate: number | null;
  abortedRate: number | null;
  ttftMs: UsagePerformanceStats;
  outputTokPerSec: UsagePerformanceStats;
  wholeTurnTokPerSec: UsagePerformanceStats;
  turnDurationMs: UsagePerformanceStats;
  modelTimeMs: UsagePerformanceStats;
  toolTimeMs: UsagePerformanceStats;
  contextUsedTokens: UsagePerformanceStats;
  contextPercent: UsagePerformanceStats;
}

export interface UsageAnalyticsGroupSummary extends UsageAnalyticsSummary {
  id: string;
}

export interface UsageAnalyticsPoint {
  time: number;
  value: number;
}

export interface UsageAnalyticsSeries {
  id: string;
  points: UsageAnalyticsPoint[];
}

export interface UsageAnalyticsCoverage {
  indexedSessions: number;
  observations: number;
  costCoverage: number | null;
  firstObservationAt: number | null;
  lastObservationAt: number | null;
}

export interface UsageAnalyticsResponse {
  query: UsageAnalyticsQuery;
  bucketMs: number;
  summary: UsageAnalyticsSummary;
  previousSummary: UsageAnalyticsSummary;
  groups: UsageAnalyticsGroupSummary[];
  series: UsageAnalyticsSeries[];
  coverage: UsageAnalyticsCoverage;
}
