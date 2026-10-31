import type { SessionStatus } from "@polyth/contracts";
import {
  canonicalHarnessId,
  canonicalProviderId,
  displayHarness,
  displayProvider,
} from "../providerIdentity.ts";
import type {
  UsageAggregate,
  UsageChartBucket,
  UsageDetailSort,
  UsageGroupSummary,
  UsageObservation,
  UsageProjectInfo,
  UsageStatsQuery,
  UsageStatsReport,
  UsageTrend,
} from "./contracts.ts";
import { scanCacheHealth } from "./cacheHealth.ts";
import {
  chooseUsageBucket,
  createLocalDateKeyer,
  nextLocalBucket,
  precedingEquivalentRange,
  resolveUsageRange,
  startOfLocalBucket,
  usageBucketLabel,
} from "./time.ts";

export interface UsageSessionMetadata {
  id: string;
  title: string;
  status: SessionStatus;
}

const MAX_CHART_RAW_BUCKETS = 2_000;
const MAX_CHART_VISIBLE_BUCKETS = 120;
const MAX_GROUP_SUMMARIES = 200;
const NO_REWRITES: ReadonlyMap<string, number> = new Map();

const fitsChartBucketBudget = (
  from: number,
  to: number,
  bucket: NonNullable<UsageStatsQuery["bucket"]>,
  timezone: string,
): boolean => {
  let start = startOfLocalBucket(from, bucket, timezone);
  let count = 0;
  while (start < to && count <= MAX_CHART_RAW_BUCKETS) {
    const next = nextLocalBucket(start, bucket, timezone);
    if (next <= start) return false;
    start = next;
    count += 1;
  }
  return count <= MAX_CHART_RAW_BUCKETS;
};

/** Turn-level fields merged once per turn. Every field exists from creation so
 * the shape never changes while a report is aggregated. */
interface TurnMeasurement {
  outputTokens: number;
  outputKnown: boolean;
  steps: number | undefined;
  retries: number | undefined;
  totalMs: number | undefined;
  modelMs: number | undefined;
  toolMs: number | undefined;
  ttftMs: number | undefined;
}

const newMeasurement = (): TurnMeasurement => ({
  outputTokens: 0,
  outputKnown: false,
  steps: undefined,
  retries: undefined,
  totalMs: undefined,
  modelMs: undefined,
  toolMs: undefined,
  ttftMs: undefined,
});

const longestStreak = (activeDays: ReadonlySet<string>): number => {
  let longest = 0;
  let current = 0;
  let previousDay: number | null = null;
  for (const day of [...activeDays].sort()) {
    const [year, month, date] = day.split("-").map(Number);
    const dayUtc = Date.UTC(year!, month! - 1, date!);
    current = previousDay !== null && dayUtc - previousDay === 86_400_000 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previousDay = dayUtc;
  }
  return longest;
};

/**
 * One pass over the observations. Sums live in locals rather than on an
 * accumulator object: fields that start as small integers and become doubles
 * made V8 deoptimize this function about a thousand times per report.
 */
const aggregate = (
  observations: readonly UsageObservation[],
  dateKey: (timestamp: number) => string,
  rewrites: ReadonlyMap<string, number> = NO_REWRITES,
): UsageAggregate => {
  let burnTokens = 0, burnRewrites = 0;
  let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0;
  let inputKnown = 0, outputKnown = 0, reasoningKnown = 0, cacheReadKnown = 0, cacheWriteKnown = 0;
  let totalSum = 0, totalKnown = 0, totalCompleteKnown = 0;
  let cacheEligibleSum = 0, cacheReadSum = 0, cacheMetricsComplete = true;
  let costSum = 0, costKnown = 0;
  let exact = 0, derived = 0, estimated = 0;
  let completed = 0, failed = 0, cancelled = 0, unknown = 0;
  let turnCount = 0, missingTurns = 0;
  const sessions = new Set<string>();
  const subagents = new Set<string>();
  const activeDays = new Set<string>();
  // Timing/steps/retries are turn-level values. Token/cost telemetry can emit
  // several observations in one turn, so merge those fields once by turn id.
  const turnsBySession = new Map<string, Map<string, TurnMeasurement>>();
  const measurements: TurnMeasurement[] = [];

  for (const observation of observations) {
    const { tokens, sessionId, turnId } = observation;
    sessions.add(sessionId);
    if (observation.agentKind === "subagent") subagents.add(sessionId);
    const tokenInput = tokens.input;
    const tokenOutput = tokens.output;
    const tokenCacheRead = tokens.cacheRead;
    const tokenCacheWrite = tokens.cacheWrite;
    if (tokenInput !== null) { input += tokenInput; inputKnown += 1; }
    if (tokenOutput !== null) { output += tokenOutput; outputKnown += 1; }
    if (tokens.reasoning !== null) { reasoning += tokens.reasoning; reasoningKnown += 1; }
    if (tokenCacheRead !== null) { cacheRead += tokenCacheRead; cacheReadKnown += 1; }
    if (tokenCacheWrite !== null) { cacheWrite += tokenCacheWrite; cacheWriteKnown += 1; }
    const burned = rewrites.get(observation.id);
    if (burned !== undefined) { burnTokens += burned; burnRewrites += 1; }
    // Input/output are the mandatory measured core. Cache fields are optional
    // provider telemetry; their absence makes the displayed total a lower bound
    // rather than turning a perfectly useful input/output sample into unknown.
    if (tokenInput !== null && tokenOutput !== null) {
      totalSum += tokenInput + tokenOutput + (tokenCacheRead ?? 0) + (tokenCacheWrite ?? 0);
      totalKnown += 1;
      if (tokenCacheRead !== null && tokenCacheWrite !== null) totalCompleteKnown += 1;
    }
    if (tokenInput === null || tokenCacheRead === null) {
      cacheMetricsComplete = false;
    } else {
      cacheEligibleSum += tokenInput + tokenCacheRead;
      cacheReadSum += tokenCacheRead;
    }
    if (observation.cost !== undefined && observation.cost !== null) {
      costSum += observation.cost;
      costKnown += 1;
    }
    activeDays.add(dateKey(observation.timestamp));
    if (observation.quality === "exact") exact += 1;
    else if (observation.quality === "derived") derived += 1;
    else if (observation.quality === "estimated") estimated += 1;
    if (observation.status === "completed") completed += 1;
    else if (observation.status === "failed") failed += 1;
    else if (observation.status === "cancelled") cancelled += 1;
    else unknown += 1;

    let measurement: TurnMeasurement | undefined;
    if (turnId) {
      let byTurn = turnsBySession.get(sessionId);
      if (!byTurn) {
        byTurn = new Map();
        turnsBySession.set(sessionId, byTurn);
      }
      measurement = byTurn.get(turnId);
      if (!measurement) {
        measurement = newMeasurement();
        byTurn.set(turnId, measurement);
        measurements.push(measurement);
        turnCount += 1;
      }
    } else {
      missingTurns += 1;
      measurement = newMeasurement();
      measurements.push(measurement);
    }
    if (tokenOutput !== null) {
      measurement.outputTokens += tokenOutput;
      measurement.outputKnown = true;
    }
    if (measurement.steps === undefined && observation.steps !== undefined) measurement.steps = observation.steps;
    if (measurement.retries === undefined && observation.retries !== undefined) measurement.retries = observation.retries;
    const timing = observation.timing;
    if (timing) {
      if (measurement.totalMs === undefined && timing.totalMs !== undefined) measurement.totalMs = timing.totalMs;
      if (measurement.modelMs === undefined && timing.modelMs !== undefined) measurement.modelMs = timing.modelMs;
      if (measurement.toolMs === undefined && timing.toolMs !== undefined) measurement.toolMs = timing.toolMs;
      if (measurement.ttftMs === undefined && timing.ttftMs !== undefined) measurement.ttftMs = timing.ttftMs;
    }
  }

  let steps = 0;
  let stepTurns = 0;
  let retries = 0;
  let retryTurns = 0;
  let totalMs = 0;
  let totalMsTurns = 0;
  let modelMs = 0;
  let modelMsTurns = 0;
  let toolMs = 0;
  let toolMsTurns = 0;
  let ttftMs = 0;
  let ttftTurns = 0;
  let responseOutputTokens = 0;
  let responseOutputKnown = false;
  let wholeTurnOutputTokens = 0;
  let wholeTurnOutputKnown = false;
  for (const measurement of measurements) {
    if (measurement.steps !== undefined) { steps += measurement.steps; stepTurns += 1; }
    if (measurement.retries !== undefined) { retries += measurement.retries; retryTurns += 1; }
    if (measurement.totalMs !== undefined) {
      totalMs += measurement.totalMs;
      totalMsTurns += 1;
      if (measurement.outputKnown) {
        wholeTurnOutputTokens += measurement.outputTokens;
        wholeTurnOutputKnown = true;
      }
    }
    if (measurement.modelMs !== undefined) {
      modelMs += measurement.modelMs;
      modelMsTurns += 1;
      if (measurement.outputKnown) {
        responseOutputTokens += measurement.outputTokens;
        responseOutputKnown = true;
      }
    }
    if (measurement.toolMs !== undefined) { toolMs += measurement.toolMs; toolMsTurns += 1; }
    if (measurement.ttftMs !== undefined) { ttftMs += measurement.ttftMs; ttftTurns += 1; }
  }

  const count = observations.length;
  const cost = costKnown > 0 ? costSum : null;
  const total = totalKnown > 0 ? totalSum : null;
  const responseTokPerSec = responseOutputKnown && modelMs > 0
    ? responseOutputTokens / (modelMs / 1_000)
    : null;
  const wholeTurnTokPerSec = wholeTurnOutputKnown && totalMs > 0
    ? wholeTurnOutputTokens / (totalMs / 1_000)
    : null;
  const hasTiming = totalMsTurns + modelMsTurns + toolMsTurns + ttftTurns > 0;

  return {
    observations: count,
    sessions: sessions.size,
    turns: turnCount > 0 || missingTurns === 0 ? turnCount : null,
    turnsComplete: missingTurns === 0,
    subagents: subagents.size,
    tokens: {
      input: inputKnown > 0 ? input : null,
      output: outputKnown > 0 ? output : null,
      reasoning: reasoningKnown > 0 ? reasoning : null,
      cacheRead: cacheReadKnown > 0 ? cacheRead : null,
      cacheWrite: cacheWriteKnown > 0 ? cacheWrite : null,
      total,
      totalComplete: total !== null && totalCompleteKnown === count,
    },
    cacheHitPercent: cacheMetricsComplete && cacheEligibleSum > 0
      ? cacheReadSum / cacheEligibleSum * 100
      : null,
    cacheBurn: cacheWriteKnown > 0 ? { rewrites: burnRewrites, tokens: burnTokens } : null,
    cost,
    costComplete: cost !== null && costKnown === count,
    averageCostPerSession: cost === null || sessions.size === 0 ? null : cost / sessions.size,
    averageCostPerThousand: cost === null || total === null || total <= 0 ? null : cost / total * 1_000,
    activeDays: activeDays.size,
    longestActivityStreak: longestStreak(activeDays),
    steps: stepTurns > 0 ? steps : null,
    retries: retryTurns > 0 ? retries : null,
    timing: hasTiming ? {
      totalMs: totalMsTurns > 0 ? totalMs : null,
      modelMs: modelMsTurns > 0 ? modelMs : null,
      toolMs: toolMsTurns > 0 ? toolMs : null,
      ttftMs: ttftTurns > 0 ? ttftMs / ttftTurns : null,
    } : null,
    rates: responseTokPerSec !== null || wholeTurnTokPerSec !== null
      ? { responseTokPerSec, wholeTurnTokPerSec }
      : null,
    quality: { exact, derived, estimated },
    status: { completed, failed, cancelled, unknown },
  };
};
const matchesDimensions = (observation: UsageObservation, query: UsageStatsQuery): boolean => {
  if (query.projectIds?.length && !query.projectIds.includes(observation.projectId)) return false;
  if (query.sessionIds?.length && !query.sessionIds.includes(observation.sessionId)) return false;
  return true;
};

const trend = (current: number | null, previous: number | null): UsageTrend | null => {
  if (current === null || previous === null || previous <= 0) return null;
  const percent = (current - previous) / previous * 100;
  return {
    percent,
    direction: Math.abs(percent) < .5 ? "flat" : percent > 0 ? "up" : "down",
    current,
    previous,
  };
};

const modelKey = (observation: UsageObservation): string =>
  JSON.stringify([canonicalProviderId(observation.providerId ?? "") || observation.providerId || "", observation.modelId ?? "", observation.modelVariant ?? ""]);

const modelLabel = (observation: UsageObservation): string => {
  const model = observation.modelId ?? "Unknown model";
  return observation.modelVariant ? `${model} · ${observation.modelVariant}` : model;
};

type UsageGroupDimension = "project" | "model" | "harness";

const groupDimension = (
  observation: UsageObservation,
  dimension: UsageGroupDimension,
  projects: ReadonlyMap<string, UsageProjectInfo>,
): { id: string; label: string; detail?: string } => {
  if (dimension === "harness") {
    const id = canonicalHarnessId(observation.harnessId);
    return { id, label: displayHarness(id) };
  }
  if (dimension === "project") {
    const project = projects.get(observation.projectId);
    return {
      id: observation.projectId,
      label: project?.name ?? observation.projectId,
      ...(project?.path ? { detail: project.path } : {}),
    };
  }
  const provider = canonicalProviderId(observation.providerId ?? "");
  return {
    id: modelKey(observation),
    label: modelLabel(observation),
    ...(provider ? { detail: displayProvider(provider) } : {}),
  };
};

const makeGroups = (
  current: readonly UsageObservation[],
  previous: readonly UsageObservation[],
  dimension: UsageGroupDimension,
  projects: ReadonlyMap<string, UsageProjectInfo>,
  dateKey: (timestamp: number) => string,
  rewrites: ReadonlyMap<string, number>,
): UsageGroupSummary[] => {
  const currentGroups = new Map<string, { descriptor: ReturnType<typeof groupDimension>; observations: UsageObservation[] }>();
  const previousGroups = new Map<string, UsageObservation[]>();
  for (const observation of current) {
    const descriptor = groupDimension(observation, dimension, projects);
    const entry = currentGroups.get(descriptor.id) ?? { descriptor, observations: [] };
    entry.observations.push(observation);
    currentGroups.set(descriptor.id, entry);
  }
  for (const observation of previous) {
    const descriptor = groupDimension(observation, dimension, projects);
    const list = previousGroups.get(descriptor.id) ?? [];
    list.push(observation);
    previousGroups.set(descriptor.id, list);
  }
  const summaries = [...currentGroups.values()].map(({ descriptor, observations }) => {
    const metrics = aggregate(observations, dateKey, rewrites);
    const previousMetrics = aggregate(previousGroups.get(descriptor.id) ?? [], dateKey, rewrites);
    return {
      id: descriptor.id,
      label: descriptor.label,
      ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      metrics,
      trend: trend(metrics.cost, previousMetrics.cost) ?? trend(metrics.tokens.total, previousMetrics.tokens.total) ?? undefined,
    };
  }).sort((a, b) =>
    (b.metrics.cost ?? -1) - (a.metrics.cost ?? -1) ||
    (b.metrics.tokens.total ?? -1) - (a.metrics.tokens.total ?? -1) ||
    b.metrics.sessions - a.metrics.sessions ||
    a.label.localeCompare(b.label));
  return summaries.slice(0, MAX_GROUP_SUMMARIES);
};

const chart = (
  observations: readonly UsageObservation[],
  from: number,
  to: number,
  timezone: string,
  requestedBucket: UsageStatsQuery["bucket"],
  dateKey: (timestamp: number) => string,
): { bucket: NonNullable<UsageStatsQuery["bucket"]>; buckets: UsageChartBucket[] } => {
  const preferredBucket = chooseUsageBucket(from, to, requestedBucket);
  const bucket = fitsChartBucketBudget(from, to, preferredBucket, timezone)
    ? preferredBucket
    : chooseUsageBucket(from, to);
  const starts: number[] = [];
  const effectiveFrom = from === 0
    ? (observations.length > 0
      ? startOfLocalBucket(observations[0]!.timestamp, bucket, timezone)
      : startOfLocalBucket(to - 1, bucket, timezone))
    : from;
  for (
    let start = startOfLocalBucket(effectiveFrom, bucket, timezone);
    start < to && starts.length < MAX_CHART_RAW_BUCKETS;
    start = nextLocalBucket(start, bucket, timezone)
  ) {
    starts.push(start);
  }
  if (starts.length === 0) starts.push(startOfLocalBucket(from, bucket, timezone));

  const mergeCount = Math.max(0, starts.length - (MAX_CHART_VISIBLE_BUCKETS - 1));
  const visibleStarts = mergeCount > 0 ? starts.slice(mergeCount) : starts;
  const mergedStart = starts[0]!;
  const observationsByBucket = new Map<number, UsageObservation[]>();
  let bucketCursor = 0;
  for (const observation of observations) {
    if (observation.timestamp < from || observation.timestamp >= to) continue;
    while (bucketCursor + 1 < starts.length && observation.timestamp >= starts[bucketCursor + 1]!) {
      bucketCursor += 1;
    }
    const rawIndex = bucketCursor;
    const visibleIndex = mergeCount > 0 && rawIndex < mergeCount
      ? -1
      : rawIndex - mergeCount;
    const bucketStart = visibleIndex < 0 ? mergedStart : visibleStarts[visibleIndex]!;
    const list = observationsByBucket.get(bucketStart) ?? [];
    list.push(observation);
    observationsByBucket.set(bucketStart, list);
  }

  const bucketStarts = mergeCount > 0 ? [mergedStart, ...visibleStarts] : visibleStarts;
  return {
    bucket,
    buckets: bucketStarts.map((start, index) => {
      const end = index === bucketStarts.length - 1 ? to : bucketStarts[index + 1]!;
      const metrics = aggregate(observationsByBucket.get(start) ?? [], dateKey);
      return {
        start,
        end,
        label: usageBucketLabel(start, bucket, timezone),
        values: {
          tokens: metrics.tokens.total,
          tokensComplete: metrics.tokens.totalComplete,
          cost: metrics.cost,
          costComplete: metrics.costComplete,
          turns: metrics.turns,
          turnsComplete: metrics.turnsComplete,
          sessions: metrics.sessions,
        },
      };
    }),
  };
};

const detailSortValue = (metrics: UsageAggregate, timestamp: number, sort: UsageDetailSort): number => {
  if (sort === "tokens") return metrics.tokens.total ?? -1;
  if (sort === "cost") return metrics.cost ?? -1;
  if (sort === "turns") return metrics.turns ?? -1;
  return timestamp;
};

// Activity groups inherit the report's timestamp order. Choose the visible
// rows before computing all their telemetry; omitted rows still count toward
// totals and coverage. Other sort modes retain their metric-based ordering.
const detailEntries = (
  groups: ReadonlyMap<string, UsageObservation[]>,
  sort: UsageDetailSort,
  limit: number,
): Array<[string, UsageObservation[]]> => {
  const entries = [...groups.entries()];
  return sort === "activity"
    ? entries.sort((a, b) => b[1].at(-1)!.timestamp - a[1].at(-1)!.timestamp).slice(0, limit)
    : entries;
};

export function buildUsageStatsReport(input: {
  serverInstanceId: string;
  spaceId: string;
  query: UsageStatsQuery;
  observations: readonly UsageObservation[];
  projects: readonly UsageProjectInfo[];
  sessions: ReadonlyMap<string, UsageSessionMetadata>;
  now?: number;
}): UsageStatsReport {
  const now = input.now ?? Date.now();
  // Every observation participates in several aggregates. Keep local dates
  // for this report so a large query cannot thrash the bounded global cache.
  const dateKey = createLocalDateKeyer(input.query.timezone);
  const effective = resolveUsageRange(input.query, now);
  const previous = precedingEquivalentRange(
    effective.range,
    effective.from,
    effective.to,
    input.query.timezone,
  );
  const current = input.observations
    .filter((observation) =>
      Number.isFinite(observation.timestamp) &&
      observation.timestamp >= effective.from &&
      observation.timestamp < effective.to &&
      matchesDimensions(observation, input.query))
    .sort((a, b) => a.timestamp - b.timestamp);
  const previousObservations = previous
    ? input.observations.filter((observation) =>
      Number.isFinite(observation.timestamp) &&
      observation.timestamp >= previous.from &&
      observation.timestamp < previous.to &&
      matchesDimensions(observation, input.query))
    : [];
  const projectMap = new Map(input.projects.map((project) => [project.id, project]));
  // Burn needs each session's request before the range boundary, and health is
  // the session's current state, so the scan reads every in-scope observation.
  const cacheScan = scanCacheHealth(input.observations.filter((observation) => matchesDimensions(observation, input.query)));
  const totals = aggregate(current, dateKey, cacheScan.rewrites);
  const previousTotals = aggregate(previousObservations, dateKey, cacheScan.rewrites);
  const detailLimit = Math.max(1, Math.min(200, input.query.detailLimit ?? 50));
  const detailSort = input.query.detailSort ?? "activity";

  const sessionGroups = new Map<string, UsageObservation[]>();
  for (const observation of current) {
    const list = sessionGroups.get(observation.sessionId) ?? [];
    list.push(observation);
    sessionGroups.set(observation.sessionId, list);
  }
  const sessions = detailEntries(sessionGroups, detailSort, detailLimit).map(([sessionId, observations]) => {
    const metadata = input.sessions.get(sessionId);
    const metrics = aggregate(observations, dateKey, cacheScan.rewrites);
    const cache = cacheScan.health.get(sessionId);
    const project = projectMap.get(observations[0]!.projectId);
    return {
      id: sessionId,
      title: metadata?.title ?? sessionId,
      projectId: observations[0]!.projectId,
      projectName: project?.name ?? observations[0]!.projectId,
      ...(project?.path ? { projectPath: project.path } : {}),
      lastActivityAt: observations.at(-1)!.timestamp,
      metrics,
      status: metadata?.status ?? "idle",
      ...(cache ? { cache } : {}),
    };
  }).sort((a, b) => detailSortValue(b.metrics, b.lastActivityAt, detailSort) - detailSortValue(a.metrics, a.lastActivityAt, detailSort)).slice(0, detailLimit);

  const turnGroups = new Map<string, UsageObservation[]>();
  for (const observation of current) {
    if (!observation.turnId) continue;
    const id = `${observation.sessionId}\0${observation.turnId}`;
    const list = turnGroups.get(id) ?? [];
    list.push(observation);
    turnGroups.set(id, list);
  }
  const turns = detailEntries(turnGroups, detailSort, detailLimit).map(([id, observations]) => {
    const first = observations[0]!;
    const metrics = aggregate(observations, dateKey, cacheScan.rewrites);
    const status = observations.some((item) => item.status === "failed")
      ? "failed" as const
      : observations.some((item) => item.status === "cancelled")
        ? "cancelled" as const
        : observations.every((item) => item.status === "completed")
          ? "completed" as const
          : undefined;
    return {
      id,
      sessionId: first.sessionId,
      sessionTitle: input.sessions.get(first.sessionId)?.title ?? first.sessionId,
      projectId: first.projectId,
      projectName: projectMap.get(first.projectId)?.name ?? first.projectId,
      timestamp: observations.at(-1)!.timestamp,
      ...(first.modelId ? { modelId: first.modelId } : {}),
      ...(first.modelVariant ? { modelVariant: first.modelVariant } : {}),
      metrics,
      ...(status ? { status } : {}),
      ...(first.timing ? { timing: first.timing } : {}),
    };
  }).sort((a, b) => detailSortValue(b.metrics, b.timestamp, detailSort) - detailSortValue(a.metrics, a.timestamp, detailSort)).slice(0, detailLimit);

  const coverage = {
    exactObservations: totals.quality.exact,
    derivedObservations: totals.quality.derived,
    estimatedObservations: totals.quality.estimated,
    backfilledSessions: current.filter((item) => item.quality === "derived" && item.id.startsWith("derived:")).length,
    syncedSessions: input.sessions.size,
    syncedAt: now,
  };
  return {
    schemaVersion: 1,
    serverInstanceId: input.serverInstanceId,
    spaceId: input.spaceId,
    query: input.query,
    effective: {
      ...effective,
      timezone: input.query.timezone,
      ...(previous ? { previousFrom: previous.from, previousTo: previous.to } : {}),
    },
    generatedAt: now,
    totals,
    trends: {
      tokens: trend(totals.tokens.total, previousTotals.tokens.total),
      cost: trend(totals.cost, previousTotals.cost),
      sessions: trend(totals.sessions, previousTotals.sessions),
      turns: trend(totals.turns, previousTotals.turns),
    },
    chart: chart(current, effective.from, effective.to, input.query.timezone, input.query.bucket, dateKey),
    projects: makeGroups(current, previousObservations, "project", projectMap, dateKey, cacheScan.rewrites),
    models: makeGroups(current, previousObservations, "model", projectMap, dateKey, cacheScan.rewrites),
    harnesses: makeGroups(current, previousObservations, "harness", projectMap, dateKey, cacheScan.rewrites),
    sessions,
    turns,
    detailCoverage: {
      sessionsTotal: sessionGroups.size,
      turnsTotal: turnGroups.size,
      sessionsTruncated: sessionGroups.size > sessions.length,
      turnsTruncated: turnGroups.size > turns.length,
    },
    coverage,
  };
}
