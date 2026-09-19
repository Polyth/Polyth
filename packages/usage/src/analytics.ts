import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject, SessionEvent, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import type {
  UsageAnalyticsAggregation,
  UsageAnalyticsGroupBy,
  UsageAnalyticsGroupSummary,
  UsageAnalyticsMetric,
  UsageAnalyticsQuery,
  UsageAnalyticsResponse,
  UsageAnalyticsSeries,
  UsageAnalyticsSummary,
  UsageObservation,
  UsageObservationStatus,
  UsagePerformanceStats,
} from "./analyticsTypes.ts";

const SCHEMA_VERSION = 1;
const MAX_RANGE_MS = 366 * 24 * 60 * 60_000;
const SYNC_CONCURRENCY = 6;

const ANALYTICS_METRICS: readonly UsageAnalyticsMetric[] = [
  "recordedCost", "inputTokens", "outputTokens", "totalTokens", "cachePercent",
  "outputTokPerSec", "wholeTurnTokPerSec", "ttftMs", "turnDurationMs",
  "modelTimeMs", "toolTimeMs", "successRate", "errorRate", "turns", "sessions",
];
const ANALYTICS_GROUPS: readonly UsageAnalyticsGroupBy[] = ["none", "provider", "model", "harness", "project"];
const ANALYTICS_AGGREGATIONS: readonly UsageAnalyticsAggregation[] = ["sum", "average", "p50", "p95"];

type Row = Record<string, unknown>;

interface Checkpoint {
  lastSeq: number;
  lastTurnAt: number;
  pending: boolean;
}

interface DeriveResult {
  observations: UsageObservation[];
  safeSeq: number;
  pending: boolean;
}

interface TurnBuilder {
  turnId: string;
  startTime: number;
  model: { providerId: string; modelId: string } | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  recordedCost: number;
  costKnown: boolean;
  costSource: string | null;
  assistantTimes: number[];
  toolStarts: Map<string, number>;
  toolIntervals: Array<{ start: number; end: number }>;
  toolCalls: Set<string>;
  contextUsedTokens: number | null;
  contextLimitTokens: number | null;
  regenerated: boolean;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonNegative = (value: unknown): number => {
  const n = finite(value);
  return n === null ? 0 : Math.max(0, n);
};

const stringField = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const objectField = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const modelIdentity = (value: unknown): { providerId: string; modelId: string } | null => {
  const raw = objectField(value);
  const providerId = stringField(raw.providerID) ?? stringField(raw.providerId);
  const modelId = stringField(raw.modelID) ?? stringField(raw.modelId);
  return providerId && modelId ? { providerId, modelId } : null;
};

const percentile = (values: readonly number[], quantile: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? null;
};

const performanceStats = (values: readonly (number | null)[]): UsagePerformanceStats => {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (clean.length === 0) return { average: null, p50: null, p95: null };
  return {
    average: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    p50: percentile(clean, .5),
    p95: percentile(clean, .95),
  };
};

const unionDuration = (intervals: readonly { start: number; end: number }[]): number => {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  let total = 0;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    total += Math.max(0, end - start);
    start = interval.start;
    end = interval.end;
  }
  return total + Math.max(0, end - start);
};

const modelSegments = (
  start: number,
  end: number,
  intervals: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> => {
  const segments: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const tool of [...intervals].sort((a, b) => a.start - b.start)) {
    if (tool.start > cursor) segments.push({ start: cursor, end: Math.min(tool.start, end) });
    cursor = Math.max(cursor, tool.end);
  }
  if (cursor < end) segments.push({ start: cursor, end });
  return segments.filter((segment) => segment.end > segment.start);
};

const averageTtft = (
  start: number,
  end: number,
  intervals: readonly { start: number; end: number }[],
  assistantTimes: readonly number[],
): number | null => {
  const values: number[] = [];
  for (const segment of modelSegments(start, end, intervals)) {
    const first = assistantTimes
      .filter((time) => time >= segment.start && time < segment.end)
      .sort((a, b) => a - b)[0];
    if (first !== undefined) values.push(Math.max(0, first - segment.start));
  }
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
};

const toolCallId = (data: Record<string, unknown>, seq: number): string =>
  stringField(data.callId) ?? stringField(data.id) ?? `seq-${seq}`;

const contextValue = (data: Record<string, unknown>, names: readonly string[]): number | null => {
  for (const name of names) {
    const value = finite(data[name]);
    if (value !== null) return Math.max(0, value);
  }
  return null;
};

const startBuilder = (
  event: SessionEvent,
  projection: SessionProjection,
  regenerated: boolean,
): TurnBuilder => {
  const data = objectField(event.data);
  return {
    turnId: stringField(data.turnId) ?? `turn-${event.seq}`,
    startTime: event.time,
    model: modelIdentity(data.model) ?? modelIdentity(projection.model),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    recordedCost: 0,
    costKnown: false,
    costSource: null,
    assistantTimes: [],
    toolStarts: new Map(),
    toolIntervals: [],
    toolCalls: new Set(),
    contextUsedTokens: null,
    contextLimitTokens: null,
    regenerated,
  };
};

const finishBuilder = (
  builder: TurnBuilder,
  projection: SessionProjection,
  stopTime: number,
  stopData: Record<string, unknown>,
): UsageObservation => {
  for (const start of builder.toolStarts.values()) {
    if (stopTime > start) builder.toolIntervals.push({ start, end: stopTime });
  }
  builder.toolStarts.clear();

  const turnDurationMs = Math.max(0, stopTime - builder.startTime);
  const toolTimeMs = Math.min(turnDurationMs, unionDuration(builder.toolIntervals));
  const modelTimeMs = Math.max(0, turnDurationMs - toolTimeMs);
  const ttftMs = averageTtft(
    builder.startTime,
    stopTime,
    builder.toolIntervals,
    builder.assistantTimes,
  );
  const reason = stringField(stopData.reason) ?? "completed";
  const status: UsageObservationStatus = reason === "completed"
    ? "success"
    : reason === "aborted"
      ? "aborted"
      : "failed";
  const model = builder.model ?? modelIdentity(projection.model) ?? {
    providerId: "unknown",
    modelId: "unknown",
  };
  const outputTokPerSec = builder.outputTokens > 0 && modelTimeMs > 0
    ? builder.outputTokens / (modelTimeMs / 1000)
    : null;
  const wholeTurnTokPerSec = builder.outputTokens > 0 && turnDurationMs > 0
    ? builder.outputTokens / (turnDurationMs / 1000)
    : null;

  return {
    timestamp: stopTime,
    projectId: projection.projectId,
    sessionId: projection.id,
    turnId: builder.turnId,
    harnessId: projection.resolvedHarnessId ?? null,
    providerId: model.providerId,
    modelId: model.modelId,
    agentId: projection.agent ?? null,
    agentRole: null,
    workflowId: null,
    parentSessionId: projection.parentId ?? null,
    inputTokens: builder.inputTokens,
    outputTokens: builder.outputTokens,
    reasoningTokens: builder.reasoningTokens,
    cacheReadTokens: builder.cacheReadTokens,
    cacheWriteTokens: builder.cacheWriteTokens,
    recordedCost: builder.costKnown ? builder.recordedCost : null,
    costSource: builder.costSource,
    turnDurationMs,
    modelTimeMs,
    toolTimeMs,
    ttftMs,
    outputTokPerSec,
    wholeTurnTokPerSec,
    steps: builder.toolCalls.size,
    contextUsedTokens: builder.contextUsedTokens,
    contextLimitTokens: builder.contextLimitTokens,
    status,
    retry: stopData.retry !== undefined && stopData.retry !== null && stopData.retry !== false,
    regenerated: builder.regenerated,
    aborted: status === "aborted",
    failed: status === "failed",
  };
};

/**
 * Derive immutable, per-turn observations from the canonical session log.
 * safeSeq advances only through complete turns. A live/incomplete tail is
 * intentionally replayed on the next sync instead of becoming a second source
 * of session truth.
 */
export function deriveUsageObservations(
  projection: SessionProjection,
  events: readonly SessionEvent[],
  afterSeq = 0,
): DeriveResult {
  const observations: UsageObservation[] = [];
  let current: TurnBuilder | null = null;
  let safeSeq = afterSeq;
  let pendingRegeneration = false;

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= afterSeq) continue;
    const data = objectField(event.data);

    if (event.type === "session/rewound") {
      pendingRegeneration = true;
      if (current === null) safeSeq = event.seq;
      continue;
    }

    if (event.type === "turn/started") {
      current = startBuilder(event, projection, pendingRegeneration);
      pendingRegeneration = false;
      continue;
    }

    if (current === null) {
      safeSeq = event.seq;
      continue;
    }

    if (event.type === "usage/recorded") {
      const tokens = objectField(data.tokens);
      current.inputTokens += nonNegative(tokens.input);
      current.outputTokens += nonNegative(tokens.output);
      current.reasoningTokens += nonNegative(tokens.reasoning);
      current.cacheReadTokens += nonNegative(tokens.cacheRead);
      current.cacheWriteTokens += nonNegative(tokens.cacheWrite);
      const cost = finite(data.cost);
      if (cost !== null) {
        current.recordedCost += Math.max(0, cost);
        current.costKnown = true;
      }
      current.costSource = stringField(data.costSource) ?? current.costSource;
      current.model = modelIdentity(data.model) ?? current.model;
      continue;
    }

    if (
      event.type === "assistant/chunk"
      || event.type === "assistant/reasoning-chunk"
      || event.type === "assistant/message"
    ) {
      current.assistantTimes.push(event.time);
      continue;
    }

    if (event.type === "tool/call" || event.type === "tool/started") {
      const id = toolCallId(data, event.seq);
      current.toolCalls.add(id);
      if (!current.toolStarts.has(id)) current.toolStarts.set(id, event.time);
      continue;
    }

    if (event.type === "tool/result" || event.type === "tool/error") {
      const id = toolCallId(data, event.seq);
      const start = current.toolStarts.get(id);
      if (start !== undefined) {
        if (event.time > start) current.toolIntervals.push({ start, end: event.time });
        current.toolStarts.delete(id);
      }
      continue;
    }

    if (event.type === "context/updated") {
      current.contextUsedTokens = contextValue(data, ["usedTokens", "used", "tokens"]) ?? current.contextUsedTokens;
      current.contextLimitTokens = contextValue(data, ["limitTokens", "limit", "maxTokens"]) ?? current.contextLimitTokens;
      continue;
    }

    if (event.type === "turn/stopped" || event.type === "turn/failed") {
      const stoppedTurnId = stringField(data.turnId);
      if (stoppedTurnId && stoppedTurnId !== current.turnId) continue;
      const stopData = event.type === "turn/failed" && data.reason === undefined
        ? { ...data, reason: "error" }
        : data;
      observations.push(finishBuilder(current, projection, event.time, stopData));
      current = null;
      safeSeq = event.seq;
      continue;
    }
  }

  return { observations, safeSeq, pending: current !== null };
}

const emptySummary = (): UsageAnalyticsSummary => ({
  observations: 0,
  sessions: 0,
  recordedCost: 0,
  costKnownTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cachePercent: null,
  successRate: null,
  errorRate: null,
  abortedRate: null,
  ttftMs: { average: null, p50: null, p95: null },
  outputTokPerSec: { average: null, p50: null, p95: null },
  wholeTurnTokPerSec: { average: null, p50: null, p95: null },
  turnDurationMs: { average: null, p50: null, p95: null },
  modelTimeMs: { average: null, p50: null, p95: null },
  toolTimeMs: { average: null, p50: null, p95: null },
});

const summarize = (rows: readonly UsageObservation[]): UsageAnalyticsSummary => {
  if (rows.length === 0) return emptySummary();
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const cacheReadTokens = rows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  const success = rows.filter((row) => row.status === "success").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const aborted = rows.filter((row) => row.status === "aborted").length;
  const eligibleCache = inputTokens + cacheReadTokens;
  return {
    observations: rows.length,
    sessions: new Set(rows.map((row) => row.sessionId)).size,
    recordedCost: rows.reduce((sum, row) => sum + (row.recordedCost ?? 0), 0),
    costKnownTurns: rows.filter((row) => row.recordedCost !== null).length,
    inputTokens,
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    reasoningTokens: rows.reduce((sum, row) => sum + row.reasoningTokens, 0),
    cacheReadTokens,
    cacheWriteTokens: rows.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
    cachePercent: eligibleCache > 0 ? cacheReadTokens / eligibleCache : null,
    successRate: success / rows.length,
    errorRate: failed / rows.length,
    abortedRate: aborted / rows.length,
    ttftMs: performanceStats(rows.map((row) => row.ttftMs)),
    outputTokPerSec: performanceStats(rows.map((row) => row.outputTokPerSec)),
    wholeTurnTokPerSec: performanceStats(rows.map((row) => row.wholeTurnTokPerSec)),
    turnDurationMs: performanceStats(rows.map((row) => row.turnDurationMs)),
    modelTimeMs: performanceStats(rows.map((row) => row.modelTimeMs)),
    toolTimeMs: performanceStats(rows.map((row) => row.toolTimeMs)),
  };
};

const metricValue = (row: UsageObservation, metric: UsageAnalyticsMetric): number | null => {
  switch (metric) {
    case "recordedCost": return row.recordedCost;
    case "inputTokens": return row.inputTokens;
    case "outputTokens": return row.outputTokens;
    case "totalTokens": return row.inputTokens + row.outputTokens + row.reasoningTokens;
    case "cachePercent": {
      const eligible = row.inputTokens + row.cacheReadTokens;
      return eligible > 0 ? row.cacheReadTokens / eligible : null;
    }
    case "outputTokPerSec": return row.outputTokPerSec;
    case "wholeTurnTokPerSec": return row.wholeTurnTokPerSec;
    case "ttftMs": return row.ttftMs;
    case "turnDurationMs": return row.turnDurationMs;
    case "modelTimeMs": return row.modelTimeMs;
    case "toolTimeMs": return row.toolTimeMs;
    case "successRate": return row.status === "success" ? 1 : 0;
    case "errorRate": return row.status === "failed" ? 1 : 0;
    case "turns": return 1;
    case "sessions": return 1;
  }
};

const aggregateMetric = (
  rows: readonly UsageObservation[],
  metric: UsageAnalyticsMetric,
  aggregation: UsageAnalyticsAggregation,
): number | null => {
  if (rows.length === 0) return null;
  if (metric === "sessions") return new Set(rows.map((row) => row.sessionId)).size;
  if (metric === "turns") return rows.length;
  const values = rows
    .map((row) => metricValue(row, metric))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return null;
  if (metric === "successRate" || metric === "errorRate") {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (aggregation === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (aggregation === "average") return values.reduce((sum, value) => sum + value, 0) / values.length;
  return percentile(values, aggregation === "p95" ? .95 : .5);
};

const groupId = (row: UsageObservation, by: UsageAnalyticsGroupBy): string => {
  switch (by) {
    case "provider": return row.providerId || "unknown";
    case "model": return row.modelId || "unknown";
    case "harness": return row.harnessId || "unknown";
    case "project": return row.projectId || "unknown";
    case "none": return "all";
  }
};

const bucketForRange = (from: number, to: number): number => {
  const duration = Math.max(1, to - from);
  if (duration <= 2 * 60 * 60_000) return 5 * 60_000;
  if (duration <= 36 * 60 * 60_000) return 15 * 60_000;
  if (duration <= 8 * 24 * 60 * 60_000) return 60 * 60_000;
  if (duration <= 35 * 24 * 60 * 60_000) return 6 * 60 * 60_000;
  return 24 * 60 * 60_000;
};

const rowNumber = (row: Row, key: string): number => finite(row[key]) ?? 0;
const rowNullableNumber = (row: Row, key: string): number | null => finite(row[key]);

const observationFromRow = (row: Row): UsageObservation => {
  const status = stringField(row.status);
  const normalizedStatus: UsageObservationStatus = status === "failed" || status === "aborted"
    ? status
    : "success";
  return {
    timestamp: rowNumber(row, "timestamp"),
    projectId: stringField(row.project_id) ?? "",
    sessionId: stringField(row.session_id) ?? "",
    turnId: stringField(row.turn_id) ?? "",
    harnessId: stringField(row.harness_id),
    providerId: stringField(row.provider_id) ?? "unknown",
    modelId: stringField(row.model_id) ?? "unknown",
    agentId: stringField(row.agent_id),
    agentRole: stringField(row.agent_role),
    workflowId: stringField(row.workflow_id),
    parentSessionId: stringField(row.parent_session_id),
    inputTokens: rowNumber(row, "input_tokens"),
    outputTokens: rowNumber(row, "output_tokens"),
    reasoningTokens: rowNumber(row, "reasoning_tokens"),
    cacheReadTokens: rowNumber(row, "cache_read_tokens"),
    cacheWriteTokens: rowNumber(row, "cache_write_tokens"),
    recordedCost: rowNullableNumber(row, "recorded_cost"),
    costSource: stringField(row.cost_source),
    turnDurationMs: rowNumber(row, "turn_duration_ms"),
    modelTimeMs: rowNumber(row, "model_time_ms"),
    toolTimeMs: rowNumber(row, "tool_time_ms"),
    ttftMs: rowNullableNumber(row, "ttft_ms"),
    outputTokPerSec: rowNullableNumber(row, "output_tps"),
    wholeTurnTokPerSec: rowNullableNumber(row, "whole_turn_tps"),
    steps: rowNumber(row, "steps"),
    contextUsedTokens: rowNullableNumber(row, "context_used_tokens"),
    contextLimitTokens: rowNullableNumber(row, "context_limit_tokens"),
    status: normalizedStatus,
    retry: rowNumber(row, "retry") === 1,
    regenerated: rowNumber(row, "regenerated") === 1,
    aborted: normalizedStatus === "aborted",
    failed: normalizedStatus === "failed",
  };
};

export class UsageAnalyticsIndex {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    const version = rowNumber(this.db.prepare("PRAGMA user_version").get() as Row, "user_version");
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`usage analytics schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          parent_session_id TEXT,
          harness_id TEXT,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          agent_id TEXT,
          agent_role TEXT,
          workflow_id TEXT,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL,
          recorded_cost REAL,
          cost_source TEXT,
          turn_duration_ms INTEGER NOT NULL,
          model_time_ms INTEGER NOT NULL,
          tool_time_ms INTEGER NOT NULL,
          ttft_ms REAL,
          output_tps REAL,
          whole_turn_tps REAL,
          steps INTEGER NOT NULL,
          context_used_tokens INTEGER,
          context_limit_tokens INTEGER,
          status TEXT NOT NULL,
          retry INTEGER NOT NULL,
          regenerated INTEGER NOT NULL,
          PRIMARY KEY (session_id, turn_id)
        );
        CREATE INDEX IF NOT EXISTS observations_time_idx ON observations(timestamp);
        CREATE INDEX IF NOT EXISTS observations_project_time_idx ON observations(project_id, timestamp);
        CREATE INDEX IF NOT EXISTS observations_provider_time_idx ON observations(provider_id, timestamp);
        CREATE INDEX IF NOT EXISTS observations_model_time_idx ON observations(model_id, timestamp);
        CREATE TABLE IF NOT EXISTS checkpoints (
          session_id TEXT PRIMARY KEY,
          last_seq INTEGER NOT NULL,
          last_turn_at INTEGER NOT NULL,
          pending INTEGER NOT NULL
        );
        PRAGMA user_version=1;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  checkpoint(sessionId: string): Checkpoint {
    const row = this.db.prepare(
      "SELECT last_seq, last_turn_at, pending FROM checkpoints WHERE session_id = ?",
    ).get(sessionId) as Row | undefined;
    return row
      ? {
          lastSeq: rowNumber(row, "last_seq"),
          lastTurnAt: rowNumber(row, "last_turn_at"),
          pending: rowNumber(row, "pending") === 1,
        }
      : { lastSeq: 0, lastTurnAt: 0, pending: false };
  }

  commitSync(
    session: SessionProjection,
    result: DeriveResult,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`
        INSERT INTO observations (
          session_id, turn_id, timestamp, project_id, parent_session_id, harness_id,
          provider_id, model_id, agent_id, agent_role, workflow_id,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
          recorded_cost, cost_source, turn_duration_ms, model_time_ms, tool_time_ms,
          ttft_ms, output_tps, whole_turn_tps, steps, context_used_tokens, context_limit_tokens,
          status, retry, regenerated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
          timestamp=excluded.timestamp,
          project_id=excluded.project_id,
          parent_session_id=excluded.parent_session_id,
          harness_id=excluded.harness_id,
          provider_id=excluded.provider_id,
          model_id=excluded.model_id,
          agent_id=excluded.agent_id,
          agent_role=excluded.agent_role,
          workflow_id=excluded.workflow_id,
          input_tokens=excluded.input_tokens,
          output_tokens=excluded.output_tokens,
          reasoning_tokens=excluded.reasoning_tokens,
          cache_read_tokens=excluded.cache_read_tokens,
          cache_write_tokens=excluded.cache_write_tokens,
          recorded_cost=excluded.recorded_cost,
          cost_source=excluded.cost_source,
          turn_duration_ms=excluded.turn_duration_ms,
          model_time_ms=excluded.model_time_ms,
          tool_time_ms=excluded.tool_time_ms,
          ttft_ms=excluded.ttft_ms,
          output_tps=excluded.output_tps,
          whole_turn_tps=excluded.whole_turn_tps,
          steps=excluded.steps,
          context_used_tokens=excluded.context_used_tokens,
          context_limit_tokens=excluded.context_limit_tokens,
          status=excluded.status,
          retry=excluded.retry,
          regenerated=excluded.regenerated
      `);
      for (const row of result.observations) {
        insert.run(
          row.sessionId, row.turnId, row.timestamp, row.projectId, row.parentSessionId,
          row.harnessId, row.providerId, row.modelId, row.agentId, row.agentRole, row.workflowId,
          row.inputTokens, row.outputTokens, row.reasoningTokens, row.cacheReadTokens,
          row.cacheWriteTokens, row.recordedCost, row.costSource, row.turnDurationMs,
          row.modelTimeMs, row.toolTimeMs, row.ttftMs, row.outputTokPerSec,
          row.wholeTurnTokPerSec, row.steps, row.contextUsedTokens, row.contextLimitTokens,
          row.status, row.retry ? 1 : 0, row.regenerated ? 1 : 0,
        );
      }
      this.db.prepare(`
        INSERT INTO checkpoints(session_id, last_seq, last_turn_at, pending)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          last_seq=excluded.last_seq,
          last_turn_at=excluded.last_turn_at,
          pending=excluded.pending
      `).run(
        session.id,
        result.safeSeq,
        result.pending ? -1 : session.lastTurnAt ?? 0,
        result.pending ? 1 : 0,
      );
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  private rows(from: number, to: number, query: UsageAnalyticsQuery): UsageObservation[] {
    const clauses = ["timestamp >= ?", "timestamp < ?"];
    const params: SQLInputValue[] = [from, to];
    const filter = (column: string, value: string | undefined) => {
      if (!value) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    };
    filter("project_id", query.projectId);
    filter("provider_id", query.providerId);
    filter("model_id", query.modelId);
    filter("harness_id", query.harnessId);
    const raw = this.db.prepare(
      `SELECT * FROM observations WHERE ${clauses.join(" AND ")} ORDER BY timestamp ASC`,
    ).all(...params) as Row[];
    return raw.map(observationFromRow);
  }

  query(query: UsageAnalyticsQuery): UsageAnalyticsResponse {
    const duration = query.to - query.from;
    const previousFrom = Math.max(0, query.from - duration);
    const currentRows = this.rows(query.from, query.to, query);
    const previousRows = this.rows(previousFrom, query.from, query);
    const grouped = new Map<string, UsageObservation[]>();
    for (const row of currentRows) {
      const id = groupId(row, query.groupBy);
      const list = grouped.get(id);
      if (list) list.push(row);
      else grouped.set(id, [row]);
    }

    const ranked = [...grouped.entries()]
      .map(([id, rows]) => ({
        id,
        rows,
        sortValue: aggregateMetric(rows, query.metric, query.aggregation) ?? 0,
      }))
      .sort((a, b) => b.sortValue - a.sortValue || b.rows.length - a.rows.length || a.id.localeCompare(b.id))
      .slice(0, query.limit);

    const groups: UsageAnalyticsGroupSummary[] = ranked.map(({ id, rows }) => ({
      id,
      ...summarize(rows),
    }));

    const bucketMs = bucketForRange(query.from, query.to);
    const series: UsageAnalyticsSeries[] = ranked.map(({ id, rows }) => {
      const buckets = new Map<number, UsageObservation[]>();
      for (const row of rows) {
        const time = query.from + Math.floor((row.timestamp - query.from) / bucketMs) * bucketMs;
        const list = buckets.get(time);
        if (list) list.push(row);
        else buckets.set(time, [row]);
      }
      return {
        id,
        points: [...buckets.entries()]
          .sort(([left], [right]) => left - right)
          .flatMap(([time, bucketRows]) => {
            const value = aggregateMetric(bucketRows, query.metric, query.aggregation);
            return value === null ? [] : [{ time, value }];
          }),
      };
    });

    const firstObservationAt = currentRows[0]?.timestamp ?? null;
    const lastObservationAt = currentRows.at(-1)?.timestamp ?? null;
    const costKnown = currentRows.filter((row) => row.recordedCost !== null).length;
    const indexed = this.db.prepare(
      "SELECT COUNT(*) AS count FROM checkpoints WHERE last_seq > 0",
    ).get() as Row;

    return {
      query,
      bucketMs,
      summary: summarize(currentRows),
      previousSummary: summarize(previousRows),
      groups,
      series,
      coverage: {
        indexedSessions: rowNumber(indexed, "count"),
        observations: currentRows.length,
        costCoverage: currentRows.length > 0 ? costKnown / currentRows.length : null,
        firstObservationAt,
        lastObservationAt,
      },
    };
  }
}

const eventSync = async (
  service: SessionService,
  index: UsageAnalyticsIndex,
  session: SessionProjection,
): Promise<void> => {
  const checkpoint = index.checkpoint(session.id);
  const lastTurnAt = session.lastTurnAt ?? 0;
  if (!checkpoint.pending && checkpoint.lastTurnAt === lastTurnAt) return;
  const events = await service.events(session.id, checkpoint.lastSeq);
  const result = deriveUsageObservations(session, events, checkpoint.lastSeq);
  index.commitSync(session, result);
};

const syncRelevantSessions = async (
  service: SessionService,
  index: UsageAnalyticsIndex,
  from: number,
): Promise<void> => {
  const sessions = (await service.list()).filter((session) =>
    (session.lastTurnAt ?? 0) >= from);
  for (let offset = 0; offset < sessions.length; offset += SYNC_CONCURRENCY) {
    const batch = sessions.slice(offset, offset + SYNC_CONCURRENCY);
    const outcomes = await Promise.allSettled(batch.map((session) => eventSync(service, index, session)));
    outcomes.forEach((outcome, indexInBatch) => {
      if (outcome.status === "rejected") {
        console.warn(
          `[usage] analytics sync skipped session ${batch[indexInBatch]?.id ?? "unknown"}:`,
          outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
        );
      }
    });
  }
};

export interface UsageAnalyticsService {
  query(space: SpaceContext, query: UsageAnalyticsQuery): Promise<UsageAnalyticsResponse>;
  close(): void;
}

export function createUsageAnalyticsService(host: ServerPackageHost): UsageAnalyticsService {
  const indexes = new Map<string, UsageAnalyticsIndex>();

  const forSpace = (space: SpaceContext): UsageAnalyticsIndex => {
    const root = host.spaceStorage(space).packageDir("usage");
    let index = indexes.get(root);
    if (!index) {
      index = new UsageAnalyticsIndex(join(root, "analytics.sqlite"));
      indexes.set(root, index);
    }
    return index;
  };

  return {
    async query(space, query) {
      const index = forSpace(space);
      const duration = query.to - query.from;
      const syncFrom = Math.max(0, query.from - duration);
      await syncRelevantSessions(host.forSpace(space).sessions, index, syncFrom);
      return index.query(query);
    },
    close() {
      for (const index of indexes.values()) index.close();
      indexes.clear();
    },
  };
}

const allowed = <T extends string>(value: string | null, values: readonly T[], fallback: T): T =>
  value !== null && values.includes(value as T) ? value as T : fallback;

const defaultAggregation = (metric: UsageAnalyticsMetric): UsageAnalyticsAggregation => {
  if (
    metric === "outputTokPerSec"
    || metric === "wholeTurnTokPerSec"
    || metric === "ttftMs"
    || metric === "turnDurationMs"
    || metric === "modelTimeMs"
    || metric === "toolTimeMs"
  ) return "p50";
  if (metric === "cachePercent" || metric === "successRate" || metric === "errorRate") return "average";
  return "sum";
};

const rangeDuration = (value: string | null): number => {
  switch (value) {
    case "1h": return 60 * 60_000;
    case "24h": return 24 * 60 * 60_000;
    case "30d": return 30 * 24 * 60 * 60_000;
    case "90d": return 90 * 24 * 60 * 60_000;
    case "7d":
    default:
      return 7 * 24 * 60 * 60_000;
  }
};

const numericParam = (params: URLSearchParams, key: string): number | null => {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

export function parseUsageAnalyticsQuery(
  params: URLSearchParams,
  now = Date.now(),
): UsageAnalyticsQuery {
  const explicitFrom = numericParam(params, "from");
  const explicitTo = numericParam(params, "to");
  const fallbackDuration = rangeDuration(params.get("range"));
  const to = Math.max(1, Math.floor(explicitTo ?? now));
  const from = Math.max(0, Math.floor(explicitFrom ?? to - fallbackDuration));
  if (to <= from || to - from > MAX_RANGE_MS) {
    throw Object.assign(new Error("usage analytics range must be positive and no longer than 366 days"), {
      code: "invalid-input",
    });
  }
  const metric = allowed(params.get("metric"), ANALYTICS_METRICS, "outputTokPerSec");
  const groupBy = allowed(params.get("groupBy"), ANALYTICS_GROUPS, "provider");
  const requestedAggregation = params.get("aggregation");
  const aggregation = requestedAggregation === null
    ? defaultAggregation(metric)
    : allowed(requestedAggregation, ANALYTICS_AGGREGATIONS, defaultAggregation(metric));
  const limitRaw = numericParam(params, "limit") ?? 8;
  const clean = (key: string) => stringField(params.get(key)) ?? undefined;
  return {
    from,
    to,
    metric,
    groupBy,
    aggregation,
    projectId: clean("projectId"),
    providerId: clean("providerId"),
    modelId: clean("modelId"),
    harnessId: clean("harnessId"),
    limit: Math.min(20, Math.max(1, Math.round(limitRaw))),
  };
}

export const analyticsQueryFromObject = (input: JsonObject, now = Date.now()): UsageAnalyticsQuery => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
  }
  return parseUsageAnalyticsQuery(params, now);
};
