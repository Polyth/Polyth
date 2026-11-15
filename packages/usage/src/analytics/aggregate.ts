import type { SessionStatus } from "@polyth/contracts";
import {
  canonicalHarnessId,
  canonicalProviderId,
  displayHarness,
  displayProvider,
} from "../providerIdentity.ts";
import type {
  UsageAggregate,
  UsageBucket,
  UsageCacheHealth,
  UsageDetailSort,
  UsageGroupSummary,
  UsageObservation,
  UsageProjectInfo,
  UsageStatsQuery,
  UsageStatsReport,
  UsageTrend,
} from "./contracts.ts";
import { scanSession } from "./cacheHealth.ts";
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

/** No local bucket is shorter than this, DST days and February included. */
const MIN_BUCKET_MS: Record<UsageBucket, number> = {
  hour: 30 * 60_000,
  day: 22 * 3_600_000,
  week: 6 * 86_400_000,
  month: 27 * 86_400_000,
};

const fitsChartBucketBudget = (
  from: number,
  to: number,
  bucket: NonNullable<UsageStatsQuery["bucket"]>,
  timezone: string,
): boolean => {
  // An all-time range starts in 1970: walking its months through the calendar
  // cost more than the rest of a warm report. Count only when it could be close.
  // Hours keep the walk: only there can a DST fold stall the calendar step.
  if (bucket !== "hour" && (to - from) / MIN_BUCKET_MS[bucket] + 3 <= MAX_CHART_RAW_BUCKETS) return true;
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
 * Raw sums of one session's observations. Unlike a finished `UsageAggregate`
 * these add up, so a report merges one per session instead of re-reading every
 * observation in the Space. Treat a built one as immutable: a session shares
 * it between its totals, its breakdown groups and its chart bucket.
 */
interface Acc {
  count: number;
  sessions: number;
  subagents: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  inputKnown: number;
  outputKnown: number;
  reasoningKnown: number;
  cacheReadKnown: number;
  cacheWriteKnown: number;
  totalSum: number;
  totalKnown: number;
  totalCompleteKnown: number;
  cacheEligibleSum: number;
  cacheReadSum: number;
  cacheMetricsComplete: boolean;
  costSum: number;
  costKnown: number;
  exact: number;
  derived: number;
  estimated: number;
  completed: number;
  failed: number;
  cancelled: number;
  unknown: number;
  turnCount: number;
  missingTurns: number;
  burnTokens: number;
  burnRewrites: number;
  steps: number;
  stepTurns: number;
  retries: number;
  retryTurns: number;
  totalMs: number;
  totalMsTurns: number;
  modelMs: number;
  modelMsTurns: number;
  toolMs: number;
  toolMsTurns: number;
  ttftMs: number;
  ttftTurns: number;
  responseOutputTokens: number;
  responseOutputKnown: boolean;
  wholeTurnOutputTokens: number;
  wholeTurnOutputKnown: boolean;
  days: Set<string>;
}

const emptyAcc = (): Acc => ({
  count: 0, sessions: 0, subagents: 0,
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
  inputKnown: 0, outputKnown: 0, reasoningKnown: 0, cacheReadKnown: 0, cacheWriteKnown: 0,
  totalSum: 0, totalKnown: 0, totalCompleteKnown: 0,
  cacheEligibleSum: 0, cacheReadSum: 0, cacheMetricsComplete: true,
  costSum: 0, costKnown: 0,
  exact: 0, derived: 0, estimated: 0,
  completed: 0, failed: 0, cancelled: 0, unknown: 0,
  turnCount: 0, missingTurns: 0,
  burnTokens: 0, burnRewrites: 0,
  steps: 0, stepTurns: 0, retries: 0, retryTurns: 0,
  totalMs: 0, totalMsTurns: 0, modelMs: 0, modelMsTurns: 0, toolMs: 0, toolMsTurns: 0, ttftMs: 0, ttftTurns: 0,
  responseOutputTokens: 0, responseOutputKnown: false, wholeTurnOutputTokens: 0, wholeTurnOutputKnown: false,
  days: new Set(),
});

/**
 * One pass over observations of a single session. Sums live in locals rather
 * than on the accumulator: fields that start as small integers and become
 * doubles made V8 deoptimize this function about a thousand times per report.
 */
const accumulate = (
  observations: readonly UsageObservation[],
  dateKey: (timestamp: number) => string,
  rewrites: ReadonlyMap<string, number> = NO_REWRITES,
): Acc => {
  let burnTokens = 0, burnRewrites = 0;
  let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0;
  let inputKnown = 0, outputKnown = 0, reasoningKnown = 0, cacheReadKnown = 0, cacheWriteKnown = 0;
  let totalSum = 0, totalKnown = 0, totalCompleteKnown = 0;
  let cacheEligibleSum = 0, cacheReadSum = 0, cacheMetricsComplete = true;
  let costSum = 0, costKnown = 0;
  let exact = 0, derived = 0, estimated = 0;
  let completed = 0, failed = 0, cancelled = 0, unknown = 0;
  let turnCount = 0, missingTurns = 0;
  let subagent = false;
  const days = new Set<string>();
  // Timing/steps/retries are turn-level values. Token/cost telemetry can emit
  // several observations in one turn, so merge those fields once by turn id.
  const byTurn = new Map<string, TurnMeasurement>();
  const measurements: TurnMeasurement[] = [];

  for (const observation of observations) {
    const { tokens, turnId } = observation;
    if (observation.agentKind === "subagent") subagent = true;
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
    days.add(dateKey(observation.timestamp));
    if (observation.quality === "exact") exact += 1;
    else if (observation.quality === "derived") derived += 1;
    else if (observation.quality === "estimated") estimated += 1;
    if (observation.status === "completed") completed += 1;
    else if (observation.status === "failed") failed += 1;
    else if (observation.status === "cancelled") cancelled += 1;
    else unknown += 1;

    let measurement: TurnMeasurement | undefined;
    if (turnId) {
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

  let steps = 0, stepTurns = 0, retries = 0, retryTurns = 0;
  let totalMs = 0, totalMsTurns = 0, modelMs = 0, modelMsTurns = 0, toolMs = 0, toolMsTurns = 0, ttftMs = 0, ttftTurns = 0;
  let responseOutputTokens = 0, responseOutputKnown = false, wholeTurnOutputTokens = 0, wholeTurnOutputKnown = false;
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
  return {
    count, sessions: count > 0 ? 1 : 0, subagents: subagent ? 1 : 0,
    input, output, reasoning, cacheRead, cacheWrite,
    inputKnown, outputKnown, reasoningKnown, cacheReadKnown, cacheWriteKnown,
    totalSum, totalKnown, totalCompleteKnown,
    cacheEligibleSum, cacheReadSum, cacheMetricsComplete,
    costSum, costKnown,
    exact, derived, estimated,
    completed, failed, cancelled, unknown,
    turnCount, missingTurns,
    burnTokens, burnRewrites,
    steps, stepTurns, retries, retryTurns,
    totalMs, totalMsTurns, modelMs, modelMsTurns, toolMs, toolMsTurns, ttftMs, ttftTurns,
    responseOutputTokens, responseOutputKnown, wholeTurnOutputTokens, wholeTurnOutputKnown,
    days,
  };
};

/** Add another session's sums. Turn ids are per session, so turn counts add. */
const mergeAcc = (target: Acc, source: Acc): void => {
  target.count += source.count;
  target.sessions += source.sessions;
  target.subagents += source.subagents;
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.inputKnown += source.inputKnown;
  target.outputKnown += source.outputKnown;
  target.reasoningKnown += source.reasoningKnown;
  target.cacheReadKnown += source.cacheReadKnown;
  target.cacheWriteKnown += source.cacheWriteKnown;
  target.totalSum += source.totalSum;
  target.totalKnown += source.totalKnown;
  target.totalCompleteKnown += source.totalCompleteKnown;
  target.cacheEligibleSum += source.cacheEligibleSum;
  target.cacheReadSum += source.cacheReadSum;
  if (!source.cacheMetricsComplete) target.cacheMetricsComplete = false;
  target.costSum += source.costSum;
  target.costKnown += source.costKnown;
  target.exact += source.exact;
  target.derived += source.derived;
  target.estimated += source.estimated;
  target.completed += source.completed;
  target.failed += source.failed;
  target.cancelled += source.cancelled;
  target.unknown += source.unknown;
  target.turnCount += source.turnCount;
  target.missingTurns += source.missingTurns;
  target.burnTokens += source.burnTokens;
  target.burnRewrites += source.burnRewrites;
  target.steps += source.steps;
  target.stepTurns += source.stepTurns;
  target.retries += source.retries;
  target.retryTurns += source.retryTurns;
  target.totalMs += source.totalMs;
  target.totalMsTurns += source.totalMsTurns;
  target.modelMs += source.modelMs;
  target.modelMsTurns += source.modelMsTurns;
  target.toolMs += source.toolMs;
  target.toolMsTurns += source.toolMsTurns;
  target.ttftMs += source.ttftMs;
  target.ttftTurns += source.ttftTurns;
  target.responseOutputTokens += source.responseOutputTokens;
  if (source.responseOutputKnown) target.responseOutputKnown = true;
  target.wholeTurnOutputTokens += source.wholeTurnOutputTokens;
  if (source.wholeTurnOutputKnown) target.wholeTurnOutputKnown = true;
  for (const day of source.days) target.days.add(day);
};

const finishAcc = (acc: Acc): UsageAggregate => {
  const cost = acc.costKnown > 0 ? acc.costSum : null;
  const total = acc.totalKnown > 0 ? acc.totalSum : null;
  const responseTokPerSec = acc.responseOutputKnown && acc.modelMs > 0
    ? acc.responseOutputTokens / (acc.modelMs / 1_000)
    : null;
  const wholeTurnTokPerSec = acc.wholeTurnOutputKnown && acc.totalMs > 0
    ? acc.wholeTurnOutputTokens / (acc.totalMs / 1_000)
    : null;
  const hasTiming = acc.totalMsTurns + acc.modelMsTurns + acc.toolMsTurns + acc.ttftTurns > 0;
  return {
    observations: acc.count,
    sessions: acc.sessions,
    turns: acc.turnCount > 0 || acc.missingTurns === 0 ? acc.turnCount : null,
    turnsComplete: acc.missingTurns === 0,
    subagents: acc.subagents,
    tokens: {
      input: acc.inputKnown > 0 ? acc.input : null,
      output: acc.outputKnown > 0 ? acc.output : null,
      reasoning: acc.reasoningKnown > 0 ? acc.reasoning : null,
      cacheRead: acc.cacheReadKnown > 0 ? acc.cacheRead : null,
      cacheWrite: acc.cacheWriteKnown > 0 ? acc.cacheWrite : null,
      total,
      totalComplete: total !== null && acc.totalCompleteKnown === acc.count,
    },
    cacheHitPercent: acc.cacheMetricsComplete && acc.cacheEligibleSum > 0
      ? acc.cacheReadSum / acc.cacheEligibleSum * 100
      : null,
    cacheBurn: acc.cacheWriteKnown > 0 ? { rewrites: acc.burnRewrites, tokens: acc.burnTokens } : null,
    cost,
    costComplete: cost !== null && acc.costKnown === acc.count,
    averageCostPerSession: cost === null || acc.sessions === 0 ? null : cost / acc.sessions,
    averageCostPerThousand: cost === null || total === null || total <= 0 ? null : cost / total * 1_000,
    activeDays: acc.days.size,
    longestActivityStreak: longestStreak(acc.days),
    steps: acc.stepTurns > 0 ? acc.steps : null,
    retries: acc.retryTurns > 0 ? acc.retries : null,
    timing: hasTiming ? {
      totalMs: acc.totalMsTurns > 0 ? acc.totalMs : null,
      modelMs: acc.modelMsTurns > 0 ? acc.modelMs : null,
      toolMs: acc.toolMsTurns > 0 ? acc.toolMs : null,
      ttftMs: acc.ttftTurns > 0 ? acc.ttftMs / acc.ttftTurns : null,
    } : null,
    rates: responseTokPerSec !== null || wholeTurnTokPerSec !== null
      ? { responseTokPerSec, wholeTurnTokPerSec }
      : null,
    quality: { exact: acc.exact, derived: acc.derived, estimated: acc.estimated },
    status: { completed: acc.completed, failed: acc.failed, cancelled: acc.cancelled, unknown: acc.unknown },
  };
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

const detailSortValue = (metrics: UsageAggregate, timestamp: number, sort: UsageDetailSort): number => {
  if (sort === "tokens") return metrics.tokens.total ?? -1;
  if (sort === "cost") return metrics.cost ?? -1;
  if (sort === "turns") return metrics.turns ?? -1;
  return timestamp;
};

/** One session's share of one breakdown group, in both compared ranges. */
interface GroupCell {
  id: string;
  /** Any observation of the group: its label derives from the group id alone. */
  sample: UsageObservation;
  /** First in-range observation, which orders equal groups as before. */
  firstTs: number;
  current: Acc | null;
  previous: Acc | null;
}

interface TurnSpan {
  turnId: string;
  firstTs: number;
  lastTs: number;
}

/** What one session adds to a report for one range and chart grid. */
interface SessionPartial {
  /** In-range observations are `observations[lo..hi)`. */
  lo: number;
  hi: number;
  firstTs: number;
  lastTs: number;
  totals: Acc | null;
  previous: Acc | null;
  project: GroupCell[];
  model: GroupCell[];
  harness: GroupCell[];
  /** Visible chart bucket start and the session's sums inside it. */
  chart: Array<[number, Acc]>;
  turns: TurnSpan[];
  backfilled: number;
  /** Filled on first use by a drill-down row. */
  metrics?: UsageAggregate;
  turnObservations?: Map<string, UsageObservation[]>;
  turnMetrics?: Map<string, UsageAggregate>;
}

const EMPTY_PARTIAL: SessionPartial = {
  lo: 0, hi: 0, firstTs: 0, lastTs: 0, totals: null, previous: null,
  project: [], model: [], harness: [], chart: [], turns: [], backfilled: 0,
};

/** A session keeps its share for the ranges people actually switch between. */
const MAX_SESSION_PARTIALS = 6;

/**
 * One session's observations prepared for reporting, plus what it contributed
 * to recent reports. Build it once per change to the session; every report
 * then costs a merge of these instead of a pass over every observation.
 */
export interface UsageSessionRollup {
  readonly sessionId: string;
  /** Finite timestamps only, oldest first. */
  readonly observations: readonly UsageObservation[];
  /** The one project every observation belongs to; undefined when they differ. */
  readonly projectId: string | undefined;
  readonly modelKeys: readonly string[];
  readonly harnessIds: readonly string[];
  readonly cache: { health: UsageCacheHealth | null; rewrites: ReadonlyMap<string, number> };
  readonly partials: Map<string, SessionPartial>;
}

export function createUsageSessionRollup(
  sessionId: string,
  source: readonly UsageObservation[],
): UsageSessionRollup {
  let ordered = true;
  let previousTs = -Infinity;
  for (const observation of source) {
    if (!Number.isFinite(observation.timestamp) || observation.timestamp < previousTs) {
      ordered = false;
      break;
    }
    previousTs = observation.timestamp;
  }
  const observations = ordered
    ? source
    : source.filter((observation) => Number.isFinite(observation.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  const modelKeys: string[] = [];
  const harnessIds: string[] = [];
  let projectId = observations[0]?.projectId;
  let last: UsageObservation | undefined;
  let lastModel = "";
  let lastHarness = "";
  for (const observation of observations) {
    if (observation.projectId !== observations[0]!.projectId) projectId = undefined;
    // A session mostly stays on one model and harness: derive each key once.
    if (!last || observation.providerId !== last.providerId || observation.modelId !== last.modelId
      || observation.modelVariant !== last.modelVariant) lastModel = modelKey(observation);
    if (!last || observation.harnessId !== last.harnessId) lastHarness = canonicalHarnessId(observation.harnessId);
    modelKeys.push(lastModel);
    harnessIds.push(lastHarness);
    last = observation;
  }
  const scan = scanSession(observations);
  return {
    sessionId,
    observations,
    projectId,
    modelKeys,
    harnessIds,
    cache: { health: scan.health, rewrites: scan.rewrites.length ? new Map(scan.rewrites) : NO_REWRITES },
    partials: new Map(),
  };
}

/** First index whose timestamp is at or after `timestamp`. */
const lowerBound = (observations: readonly UsageObservation[], timestamp: number): number => {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (observations[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
};

interface ReportPlan {
  from: number;
  to: number;
  previous: { from: number; to: number } | null;
  bucket: UsageBucket;
  /** Raw bucket starts; the oldest `mergeCount` share the first visible bar. */
  starts: number[];
  mergeCount: number;
  /** An all-time range ends "now": a session's share holds while it has nothing newer. */
  openEnded: boolean;
  key: string;
  dateKey: (timestamp: number) => string;
}

const sessionPartial = (rollup: UsageSessionRollup, plan: ReportPlan): SessionPartial => {
  const { observations } = rollup;
  const { dateKey } = plan;
  const lo = lowerBound(observations, plan.from);
  const hi = lowerBound(observations, plan.to);
  const plo = plan.previous ? lowerBound(observations, plan.previous.from) : 0;
  const phi = plan.previous ? lowerBound(observations, plan.previous.to) : 0;
  if (hi <= lo && phi <= plo) return EMPTY_PARTIAL;
  const current = lo === 0 && hi === observations.length ? observations : observations.slice(lo, hi);
  const before = phi > plo ? observations.slice(plo, phi) : [];
  const rewrites = rollup.cache.rewrites;
  const totals = current.length ? accumulate(current, dateKey, rewrites) : null;
  const previous = before.length ? accumulate(before, dateKey, rewrites) : null;

  const cells = (keys: readonly string[] | string): GroupCell[] => {
    const sample = current[0] ?? before[0]!;
    const firstTs = current[0]?.timestamp ?? Infinity;
    if (typeof keys === "string") return [{ id: keys, sample, firstTs, current: totals, previous }];
    const first = keys[hi > lo ? lo : plo]!;
    let uniform = true;
    for (let index = lo; uniform && index < hi; index += 1) uniform = keys[index] === first;
    for (let index = plo; uniform && index < phi; index += 1) uniform = keys[index] === first;
    if (uniform) return [{ id: first, sample, firstTs, current: totals, previous }];
    const split = new Map<string, { current: UsageObservation[]; previous: UsageObservation[] }>();
    const entry = (id: string) => {
      let lists = split.get(id);
      if (!lists) split.set(id, lists = { current: [], previous: [] });
      return lists;
    };
    for (let index = lo; index < hi; index += 1) entry(keys[index]!).current.push(observations[index]!);
    for (let index = plo; index < phi; index += 1) entry(keys[index]!).previous.push(observations[index]!);
    return [...split].map(([id, lists]) => ({
      id,
      sample: lists.current[0] ?? lists.previous[0]!,
      firstTs: lists.current[0]?.timestamp ?? Infinity,
      current: lists.current.length ? accumulate(lists.current, dateKey, rewrites) : null,
      previous: lists.previous.length ? accumulate(lists.previous, dateKey, rewrites) : null,
    }));
  };

  const chart: Array<[number, Acc]> = [];
  const turns: TurnSpan[] = [];
  let backfilled = 0;
  if (totals) {
    const { starts, mergeCount } = plan;
    const visible = (index: number): number => index < mergeCount ? starts[0]! : starts[index]!;
    const close = (start: number, from: number, to: number): void => {
      chart.push([start, from === 0 && to === current.length ? totals : accumulate(current.slice(from, to), dateKey)]);
    };
    // The newest raw bucket that starts at or before the first observation.
    let cursor = 0;
    for (let low = 0, high = starts.length - 1; low <= high;) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= current[0]!.timestamp) { cursor = middle; low = middle + 1; } else high = middle - 1;
    }
    let segment = 0;
    let bucketStart = visible(cursor);
    const spans = new Map<string, TurnSpan>();
    for (let index = 0; index < current.length; index += 1) {
      const observation = current[index]!;
      const { timestamp, turnId } = observation;
      while (cursor + 1 < starts.length && timestamp >= starts[cursor + 1]!) cursor += 1;
      const start = visible(cursor);
      if (start !== bucketStart) {
        close(bucketStart, segment, index);
        segment = index;
        bucketStart = start;
      }
      if (observation.quality === "derived" && observation.id.startsWith("derived:")) backfilled += 1;
      if (!turnId) continue;
      const span = spans.get(turnId);
      if (span) span.lastTs = timestamp;
      else {
        const created = { turnId, firstTs: timestamp, lastTs: timestamp };
        spans.set(turnId, created);
        turns.push(created);
      }
    }
    close(bucketStart, segment, current.length);
  }
  return {
    lo,
    hi,
    firstTs: current[0]?.timestamp ?? 0,
    lastTs: current.at(-1)?.timestamp ?? 0,
    totals,
    previous,
    project: cells(rollup.projectId ?? observations.map((observation) => observation.projectId)),
    model: cells(rollup.modelKeys),
    harness: cells(rollup.harnessIds),
    chart,
    turns,
    backfilled,
  };
};

const partialFor = (rollup: UsageSessionRollup, plan: ReportPlan): SessionPartial => {
  const cacheable = !plan.openEnded || rollup.observations.at(-1)!.timestamp < plan.to;
  if (!cacheable) return sessionPartial(rollup, plan);
  const cached = rollup.partials.get(plan.key);
  if (cached) return cached;
  const partial = sessionPartial(rollup, plan);
  rollup.partials.set(plan.key, partial);
  if (rollup.partials.size > MAX_SESSION_PARTIALS) rollup.partials.delete(rollup.partials.keys().next().value!);
  return partial;
};

const turnObservations = (rollup: UsageSessionRollup, partial: SessionPartial, turnId: string): UsageObservation[] => {
  if (!partial.turnObservations) {
    const byTurn = new Map<string, UsageObservation[]>();
    for (let index = partial.lo; index < partial.hi; index += 1) {
      const observation = rollup.observations[index]!;
      if (!observation.turnId) continue;
      const list = byTurn.get(observation.turnId);
      if (list) list.push(observation);
      else byTurn.set(observation.turnId, [observation]);
    }
    partial.turnObservations = byTurn;
  }
  return partial.turnObservations.get(turnId)!;
};

interface ReportGroup {
  sample: UsageObservation;
  firstTs: number;
  current: Acc;
  previous: Acc;
}

export interface UsageReportInput {
  serverInstanceId: string;
  spaceId: string;
  query: UsageStatsQuery;
  projects: readonly UsageProjectInfo[];
  sessions: ReadonlyMap<string, UsageSessionMetadata>;
  now?: number;
}

export interface UsageReportBuild {
  /**
   * Prepare sessions that have no share for this range yet until `expired`
   * says to stop. Returns true once `finish` has nothing left to prepare, so a
   * server can spread a cold range over several event-loop turns.
   */
  warm(expired: () => boolean): boolean;
  finish(): UsageStatsReport;
}

/**
 * A report from per-session rollups. Sessions that did not change since the
 * last report for the same range contribute their stored share, so the cost
 * follows the sessions that changed, not the history in scope.
 */
export function createUsageReportBuild(
  input: UsageReportInput & { rollups: Iterable<UsageSessionRollup> },
): UsageReportBuild {
  const { query } = input;
  const now = input.now ?? Date.now();
  const effective = resolveUsageRange(query, now);
  const previous = precedingEquivalentRange(effective.range, effective.from, effective.to, query.timezone);
  const { from, to } = effective;

  // Project and session filters select whole sessions; only a session whose
  // observations span projects is narrowed observation by observation.
  const projectIds = query.projectIds?.length ? new Set(query.projectIds) : null;
  const sessionIds = query.sessionIds?.length ? new Set(query.sessionIds) : null;
  const units: UsageSessionRollup[] = [];
  let earliest = Infinity;
  for (const rollup of input.rollups) {
    if (sessionIds && !sessionIds.has(rollup.sessionId)) continue;
    let unit = rollup;
    if (projectIds) {
      if (rollup.projectId !== undefined) {
        if (!projectIds.has(rollup.projectId)) continue;
      } else {
        unit = createUsageSessionRollup(
          rollup.sessionId,
          rollup.observations.filter((observation) => projectIds.has(observation.projectId)),
        );
      }
    }
    if (unit.observations.length === 0) continue;
    units.push(unit);
    if (from === 0) {
      const first = unit.observations[lowerBound(unit.observations, from)];
      if (first && first.timestamp < to && first.timestamp < earliest) earliest = first.timestamp;
    }
  }

  // Every observation participates in several aggregates. Keep local dates
  // for this report so a large query cannot thrash the bounded global cache.
  const dateKey = createLocalDateKeyer(query.timezone);
  const preferredBucket = chooseUsageBucket(from, to, query.bucket);
  const bucket = fitsChartBucketBudget(from, to, preferredBucket, query.timezone)
    ? preferredBucket
    : chooseUsageBucket(from, to);
  const starts: number[] = [];
  const effectiveFrom = from === 0
    ? startOfLocalBucket(Number.isFinite(earliest) ? earliest : to - 1, bucket, query.timezone)
    : from;
  for (
    let start = startOfLocalBucket(effectiveFrom, bucket, query.timezone);
    start < to && starts.length < MAX_CHART_RAW_BUCKETS;
    start = nextLocalBucket(start, bucket, query.timezone)
  ) {
    starts.push(start);
  }
  if (starts.length === 0) starts.push(startOfLocalBucket(from, bucket, query.timezone));
  const mergeCount = Math.max(0, starts.length - (MAX_CHART_VISIBLE_BUCKETS - 1));
  const openEnded = effective.range === "all";
  const plan: ReportPlan = {
    from,
    to,
    previous,
    bucket,
    starts,
    mergeCount,
    openEnded,
    dateKey,
    key: [
      openEnded ? "all" : `${from}:${to}`,
      previous ? `${previous.from}:${previous.to}` : "",
      query.timezone,
      bucket,
      starts[0],
      mergeCount > 0 ? starts[mergeCount] : "",
    ].join("|"),
  };

  let warmed = 0;
  const warm = (expired: () => boolean): boolean => {
    while (warmed < units.length) {
      const unit = units[warmed]!;
      warmed += 1;
      // Only a missing share costs anything; look the clock up after those.
      if (unit.partials.has(plan.key)) continue;
      partialFor(unit, plan);
      if (expired()) break;
    }
    return warmed >= units.length;
  };

  const finish = (): UsageStatsReport => {
    const projectMap = new Map(input.projects.map((project) => [project.id, project]));
    const totalsAcc = emptyAcc();
    const previousAcc = emptyAcc();
    const groups: Record<UsageGroupDimension, Map<string, ReportGroup>> = {
      project: new Map(),
      model: new Map(),
      harness: new Map(),
    };
    const mergeCells = (dimension: UsageGroupDimension, cells: readonly GroupCell[]): void => {
      const byId = groups[dimension];
      for (const cell of cells) {
        let group = byId.get(cell.id);
        if (!group) byId.set(cell.id, group = { sample: cell.sample, firstTs: Infinity, current: emptyAcc(), previous: emptyAcc() });
        if (cell.current) {
          mergeAcc(group.current, cell.current);
          if (cell.firstTs < group.firstTs) {
            group.firstTs = cell.firstTs;
            group.sample = cell.sample;
          }
        }
        if (cell.previous) mergeAcc(group.previous, cell.previous);
      }
    };
    const chartAccs = new Map<number, Acc>();
    const active: Array<{ rollup: UsageSessionRollup; partial: SessionPartial }> = [];
    let turnsTotal = 0;
    let backfilled = 0;
    for (const rollup of units) {
      const partial = partialFor(rollup, plan);
      if (partial === EMPTY_PARTIAL) continue;
      if (partial.previous) mergeAcc(previousAcc, partial.previous);
      mergeCells("project", partial.project);
      mergeCells("model", partial.model);
      mergeCells("harness", partial.harness);
      if (!partial.totals) continue;
      mergeAcc(totalsAcc, partial.totals);
      for (const [start, acc] of partial.chart) {
        let bar = chartAccs.get(start);
        if (!bar) chartAccs.set(start, bar = emptyAcc());
        mergeAcc(bar, acc);
      }
      active.push({ rollup, partial });
      turnsTotal += partial.turns.length;
      backfilled += partial.backfilled;
    }
    const totals = finishAcc(totalsAcc);
    const previousTotals = finishAcc(previousAcc);
    const detailLimit = Math.max(1, Math.min(200, query.detailLimit ?? 50));
    const detailSort = query.detailSort ?? "activity";

    const makeGroups = (dimension: UsageGroupDimension): UsageGroupSummary[] =>
      [...groups[dimension].values()]
        .filter((group) => group.current.count > 0)
        // Equal groups keep the order of their first observation in the range.
        .sort((a, b) => a.firstTs - b.firstTs)
        .map((group) => {
          const descriptor = groupDimension(group.sample, dimension, projectMap);
          const metrics = finishAcc(group.current);
          const previousMetrics = finishAcc(group.previous);
          return {
            id: descriptor.id,
            label: descriptor.label,
            ...(descriptor.detail ? { detail: descriptor.detail } : {}),
            metrics,
            trend: trend(metrics.cost, previousMetrics.cost) ?? trend(metrics.tokens.total, previousMetrics.tokens.total) ?? undefined,
          };
        })
        .sort((a, b) =>
          (b.metrics.cost ?? -1) - (a.metrics.cost ?? -1) ||
          (b.metrics.tokens.total ?? -1) - (a.metrics.tokens.total ?? -1) ||
          b.metrics.sessions - a.metrics.sessions ||
          a.label.localeCompare(b.label))
        .slice(0, MAX_GROUP_SUMMARIES);

    // Activity rows are chosen by time before any of their telemetry is
    // computed; omitted rows still count toward totals and coverage. Other
    // sort modes rank every row by its metric.
    const sessionMetrics = (partial: SessionPartial): UsageAggregate => partial.metrics ??= finishAcc(partial.totals!);
    active.sort((a, b) => a.partial.firstTs - b.partial.firstTs);
    const sessionCandidates = detailSort === "activity"
      ? [...active].sort((a, b) => b.partial.lastTs - a.partial.lastTs).slice(0, detailLimit)
      : active;
    const sessions = sessionCandidates
      .map((entry) => ({ entry, value: detailSortValue(sessionMetrics(entry.partial), entry.partial.lastTs, detailSort) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, detailLimit)
      .map(({ entry: { rollup, partial } }) => {
        const metadata = input.sessions.get(rollup.sessionId);
        const projectId = rollup.observations[partial.lo]!.projectId;
        const project = projectMap.get(projectId);
        const cache = rollup.cache.health;
        return {
          id: rollup.sessionId,
          title: metadata?.title ?? rollup.sessionId,
          projectId,
          projectName: project?.name ?? projectId,
          ...(project?.path ? { projectPath: project.path } : {}),
          lastActivityAt: partial.lastTs,
          metrics: sessionMetrics(partial),
          status: metadata?.status ?? "idle",
          ...(cache ? { cache } : {}),
        };
      });

    const turnMetrics = (rollup: UsageSessionRollup, partial: SessionPartial, turnId: string): UsageAggregate => {
      const known = partial.turnMetrics?.get(turnId);
      if (known) return known;
      const metrics = finishAcc(accumulate(turnObservations(rollup, partial, turnId), dateKey, rollup.cache.rewrites));
      (partial.turnMetrics ??= new Map()).set(turnId, metrics);
      return metrics;
    };
    const turnSpans: Array<{ rollup: UsageSessionRollup; partial: SessionPartial; span: TurnSpan }> = [];
    for (const { rollup, partial } of active) {
      for (const span of partial.turns) turnSpans.push({ rollup, partial, span });
    }
    turnSpans.sort((a, b) => a.span.firstTs - b.span.firstTs);
    const turnCandidates = detailSort === "activity"
      ? turnSpans.sort((a, b) => b.span.lastTs - a.span.lastTs).slice(0, detailLimit)
      : turnSpans;
    const turns = turnCandidates
      .map((entry) => ({
        entry,
        value: detailSortValue(turnMetrics(entry.rollup, entry.partial, entry.span.turnId), entry.span.lastTs, detailSort),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, detailLimit)
      .map(({ entry: { rollup, partial, span } }) => {
        const observations = turnObservations(rollup, partial, span.turnId);
        const first = observations[0]!;
        const status = observations.some((item) => item.status === "failed")
          ? "failed" as const
          : observations.some((item) => item.status === "cancelled")
            ? "cancelled" as const
            : observations.every((item) => item.status === "completed")
              ? "completed" as const
              : undefined;
        return {
          id: `${rollup.sessionId}\0${span.turnId}`,
          sessionId: rollup.sessionId,
          sessionTitle: input.sessions.get(rollup.sessionId)?.title ?? rollup.sessionId,
          projectId: first.projectId,
          projectName: projectMap.get(first.projectId)?.name ?? first.projectId,
          timestamp: span.lastTs,
          ...(first.modelId ? { modelId: first.modelId } : {}),
          ...(first.modelVariant ? { modelVariant: first.modelVariant } : {}),
          metrics: turnMetrics(rollup, partial, span.turnId),
          ...(status ? { status } : {}),
          ...(first.timing ? { timing: first.timing } : {}),
        };
      });

    const bucketStarts = mergeCount > 0 ? [starts[0]!, ...starts.slice(mergeCount)] : starts;
    const emptyBar = finishAcc(emptyAcc());
    return {
      schemaVersion: 1,
      serverInstanceId: input.serverInstanceId,
      spaceId: input.spaceId,
      query,
      effective: {
        ...effective,
        timezone: query.timezone,
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
      chart: {
        bucket,
        buckets: bucketStarts.map((start, index) => {
          const bar = chartAccs.get(start);
          const metrics = bar ? finishAcc(bar) : emptyBar;
          return {
            start,
            end: index === bucketStarts.length - 1 ? to : bucketStarts[index + 1]!,
            label: usageBucketLabel(start, bucket, query.timezone),
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
      },
      projects: makeGroups("project"),
      models: makeGroups("model"),
      harnesses: makeGroups("harness"),
      sessions,
      turns,
      detailCoverage: {
        sessionsTotal: active.length,
        turnsTotal,
        sessionsTruncated: active.length > sessions.length,
        turnsTruncated: turnsTotal > turns.length,
      },
      coverage: {
        exactObservations: totals.quality.exact,
        derivedObservations: totals.quality.derived,
        estimatedObservations: totals.quality.estimated,
        backfilledSessions: backfilled,
        syncedSessions: input.sessions.size,
        syncedAt: now,
      },
    };
  };

  return { warm, finish };
}

/** A report straight from observations, grouped into sessions here. */
export function buildUsageStatsReport(
  input: UsageReportInput & { observations: readonly UsageObservation[] },
): UsageStatsReport {
  const bySession = new Map<string, UsageObservation[]>();
  for (const observation of input.observations) {
    const list = bySession.get(observation.sessionId);
    if (list) list.push(observation);
    else bySession.set(observation.sessionId, [observation]);
  }
  const rollups: UsageSessionRollup[] = [];
  for (const [sessionId, observations] of bySession) rollups.push(createUsageSessionRollup(sessionId, observations));
  return createUsageReportBuild({ ...input, rollups }).finish();
}
