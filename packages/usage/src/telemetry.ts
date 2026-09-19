import type {
  ModelRef,
  Project,
  SessionEvent,
  SessionPersistence,
  SessionProjection,
  TokenUsage,
  TelemetryQuality,
} from "@polyth/contracts";
import {
  canonicalProviderId,
  displayProvider,
  resolveSessionUsageProviderId,
} from "./providerIdentity.ts";

export type UsageTelemetryDimension = "provider" | "model" | "harness" | "project";

export interface UsageTelemetryTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTelemetryDistribution {
  count: number;
  p50: number;
  average: number;
  p95: number;
}

export type UsageCostQuality = TelemetryQuality | "mixed" | null;

export interface UsageTelemetryCounters {
  sessions: number;
  requests: number;
  effectiveTokens: number;
  tokens: UsageTelemetryTokens;
  cost: number;
  /** Quality of recorded provider cost. "mixed" means multiple qualities contributed. */
  costQuality: UsageCostQuality;
  cacheHitPercent: number | null;
  ttftMs: UsageTelemetryDistribution | null;
  tokPerSec: UsageTelemetryDistribution | null;
  durationMs: UsageTelemetryDistribution | null;
  successRate: number | null;
  errorRate: number | null;
  interruptedRate: number | null;
}

export interface UsageTelemetryConsumer extends UsageTelemetryCounters {
  id: string;
  label: string;
}

export interface UsageTelemetryProvider extends UsageTelemetryConsumer {
  models: UsageTelemetryConsumer[];
  harnesses: UsageTelemetryConsumer[];
  projects: UsageTelemetryConsumer[];
}

export interface UsageTelemetrySeries {
  id: string;
  label: string;
  tokens: number[];
  cost: number[];
  sessions: number[];
  requests: number[];
  errors: number[];
  ttftMs: Array<number | null>;
  tokPerSec: Array<number | null>;
}

export interface UsageTelemetryRangeAggregate {
  totals: UsageTelemetryCounters;
  providers: UsageTelemetryProvider[];
  consumers: Record<UsageTelemetryDimension, UsageTelemetryConsumer[]>;
}

export interface UsageTelemetryDto {
  start: number;
  end: number;
  previousStart: number;
  generatedAt: number;
  partial: boolean;
  current: UsageTelemetryRangeAggregate;
  previous: UsageTelemetryRangeAggregate;
  monthCostByProvider: Record<string, number>;
  chart: {
    bucketStarts: number[];
    bucketMs: number;
    byDimension: Record<UsageTelemetryDimension, UsageTelemetrySeries[]>;
  };
}

interface UsageSample {
  at: number;
  sessionId: string;
  providerId: string;
  modelId: string;
  harnessId: string;
  projectId: string;
  projectLabel: string;
  tokens: UsageTelemetryTokens;
  cost: number;
  costSource: TelemetryQuality | null;
}

interface TurnSample {
  at: number;
  sessionId: string;
  providerId: string;
  modelId: string;
  harnessId: string;
  projectId: string;
  projectLabel: string;
  status: "completed" | "error" | "interrupted";
  ttftMs: number | null;
  tokPerSec: number | null;
  durationMs: number | null;
}

interface SessionSamples {
  usage: UsageSample[];
  turns: TurnSample[];
  partial: boolean;
}

interface MutableCounters {
  sessions: Set<string>;
  requests: number;
  tokens: UsageTelemetryTokens;
  cost: number;
  costQualities: Set<TelemetryQuality>;
  ttftMs: number[];
  tokPerSec: number[];
  durationMs: number[];
  completed: number;
  errors: number;
  interrupted: number;
}

interface MutableConsumer extends MutableCounters {
  id: string;
  label: string;
}

const DAY_MS = 24 * 60 * 60_000;
const EVENT_PAGE = 500;
const MAX_EVENTS_PER_SESSION = 25_000;
const DIMENSIONS: UsageTelemetryDimension[] = ["provider", "model", "harness", "project"];

const emptyTokens = (): UsageTelemetryTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const tokensOf = (value: unknown): UsageTelemetryTokens => {
  const raw = value && typeof value === "object" ? value as Partial<TokenUsage> : {};
  return {
    input: finite(raw.input),
    output: finite(raw.output),
    reasoning: finite(raw.reasoning),
    cacheRead: finite(raw.cacheRead),
    cacheWrite: finite(raw.cacheWrite),
  };
};

const addTokens = (target: UsageTelemetryTokens, source: UsageTelemetryTokens): void => {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
};

const effectiveTokens = (tokens: UsageTelemetryTokens): number => tokens.input + tokens.output;

const modelFrom = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ModelRef>;
  return typeof raw.providerID === "string" && typeof raw.modelID === "string"
    ? { providerID: raw.providerID, modelID: raw.modelID }
    : undefined;
};

const harnessFromProjection = (session: SessionProjection): string =>
  session.resolvedHarnessId?.trim()
  || (session.harness?.mode === "pinned" ? session.harness.harnessId.trim() : "")
  || "auto";

const readableIdentifier = (id: string): string =>
  id === "auto"
    ? "Auto"
    : id
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((part) => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");

const providerModel = (
  eventModel: ModelRef | undefined,
  session: SessionProjection,
): { providerId: string; modelId: string } | null => {
  const providerId = eventModel?.providerID
    ? canonicalProviderId(eventModel.providerID)
    : resolveSessionUsageProviderId(session) ?? "";
  if (!providerId) return null;
  const modelId = eventModel?.modelID?.trim() || session.model?.modelID?.trim() || "Automatic";
  return { providerId, modelId };
};

const unionDuration = (intervals: Array<{ start: number; end: number }>): number => {
  if (intervals.length === 0) return 0;
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return 0;
  let total = 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  for (let index = 1; index < sorted.length; index++) {
    const next = sorted[index]!;
    if (next.start <= end) end = Math.max(end, next.end);
    else {
      total += end - start;
      start = next.start;
      end = next.end;
    }
  }
  return total + end - start;
};

const distribution = (values: readonly number[]): UsageTelemetryDistribution | null => {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const quantile = (fraction: number): number => {
    if (clean.length === 1) return clean[0]!;
    const position = (clean.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return clean[lower]! * (1 - weight) + clean[upper]! * weight;
  };
  return {
    count: clean.length,
    p50: quantile(.5),
    average: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    p95: quantile(.95),
  };
};

const emptyMutable = (): MutableCounters => ({
  sessions: new Set(),
  requests: 0,
  tokens: emptyTokens(),
  cost: 0,
  costQualities: new Set(),
  ttftMs: [],
  tokPerSec: [],
  durationMs: [],
  completed: 0,
  errors: 0,
  interrupted: 0,
});

const finalizeCounters = (value: MutableCounters): UsageTelemetryCounters => {
  const eligible = value.tokens.input + value.tokens.cacheRead;
  const terminal = value.completed + value.errors + value.interrupted;
  return {
    sessions: value.sessions.size,
    requests: value.requests,
    effectiveTokens: effectiveTokens(value.tokens),
    tokens: { ...value.tokens },
    cost: value.cost,
    costQuality: value.costQualities.size === 0
      ? null
      : value.costQualities.size === 1
        ? [...value.costQualities][0]!
        : "mixed",
    cacheHitPercent: eligible > 0 ? value.tokens.cacheRead / eligible * 100 : null,
    ttftMs: distribution(value.ttftMs),
    tokPerSec: distribution(value.tokPerSec),
    durationMs: distribution(value.durationMs),
    successRate: terminal > 0 ? value.completed / terminal * 100 : null,
    errorRate: terminal > 0 ? value.errors / terminal * 100 : null,
    interruptedRate: terminal > 0 ? value.interrupted / terminal * 100 : null,
  };
};

const identity = (
  dimension: UsageTelemetryDimension,
  sample: Pick<UsageSample, "providerId" | "modelId" | "harnessId" | "projectId" | "projectLabel">,
): { id: string; label: string } => {
  if (dimension === "provider") return { id: sample.providerId, label: displayProvider(sample.providerId) };
  if (dimension === "model") return { id: `${sample.providerId}/${sample.modelId}`, label: sample.modelId };
  if (dimension === "harness") return { id: sample.harnessId, label: readableIdentifier(sample.harnessId) };
  return { id: sample.projectId, label: sample.projectLabel };
};

const addUsage = (target: MutableCounters, sample: UsageSample): void => {
  target.sessions.add(sample.sessionId);
  addTokens(target.tokens, sample.tokens);
  target.cost += sample.cost;
  if (sample.cost > 0 && sample.costSource) target.costQualities.add(sample.costSource);
};

const addTurn = (target: MutableCounters, sample: TurnSample): void => {
  target.sessions.add(sample.sessionId);
  target.requests += 1;
  if (sample.ttftMs !== null) target.ttftMs.push(sample.ttftMs);
  if (sample.tokPerSec !== null) target.tokPerSec.push(sample.tokPerSec);
  if (sample.durationMs !== null) target.durationMs.push(sample.durationMs);
  if (sample.status === "completed") target.completed++;
  else if (sample.status === "error") target.errors++;
  else target.interrupted++;
};

const summaryMap = (
  usage: readonly UsageSample[],
  turns: readonly TurnSample[],
  dimension: UsageTelemetryDimension,
): UsageTelemetryConsumer[] => {
  const byId = new Map<string, MutableConsumer>();
  const ensure = (sample: UsageSample | TurnSample): MutableConsumer => {
    const itemIdentity = identity(dimension, sample);
    let item = byId.get(itemIdentity.id);
    if (!item) {
      item = { ...itemIdentity, ...emptyMutable() };
      byId.set(itemIdentity.id, item);
    }
    return item;
  };
  for (const sample of usage) addUsage(ensure(sample), sample);
  for (const sample of turns) addTurn(ensure(sample), sample);
  return [...byId.values()]
    .map((item) => ({ id: item.id, label: item.label, ...finalizeCounters(item) }))
    .sort((a, b) =>
      b.cost - a.cost
      || b.effectiveTokens - a.effectiveTokens
      || b.requests - a.requests
      || a.label.localeCompare(b.label));
};

const aggregateRange = (
  allUsage: readonly UsageSample[],
  allTurns: readonly TurnSample[],
  start: number,
  end: number,
): UsageTelemetryRangeAggregate => {
  const usage = allUsage.filter((sample) => sample.at >= start && sample.at <= end);
  const turns = allTurns.filter((sample) => sample.at >= start && sample.at <= end);
  const total = emptyMutable();
  for (const sample of usage) addUsage(total, sample);
  for (const sample of turns) addTurn(total, sample);

  const consumers = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, summaryMap(usage, turns, dimension)]),
  ) as Record<UsageTelemetryDimension, UsageTelemetryConsumer[]>;

  const providerIds = new Set([
    ...usage.map((sample) => sample.providerId),
    ...turns.map((sample) => sample.providerId),
  ]);
  const providers = [...providerIds].map((providerId): UsageTelemetryProvider => {
    const providerUsage = usage.filter((sample) => sample.providerId === providerId);
    const providerTurns = turns.filter((sample) => sample.providerId === providerId);
    const provider = summaryMap(providerUsage, providerTurns, "provider")[0] ?? {
      id: providerId,
      label: displayProvider(providerId),
      ...finalizeCounters(emptyMutable()),
    };
    return {
      ...provider,
      models: summaryMap(providerUsage, providerTurns, "model"),
      harnesses: summaryMap(providerUsage, providerTurns, "harness"),
      projects: summaryMap(providerUsage, providerTurns, "project"),
    };
  }).sort((a, b) =>
    b.cost - a.cost || b.effectiveTokens - a.effectiveTokens || b.requests - a.requests || a.label.localeCompare(b.label));

  return { totals: finalizeCounters(total), providers, consumers };
};

const readEventsSince = async (
  store: SessionPersistence,
  sessionId: string,
  earliest: number,
): Promise<{ events: SessionEvent[]; partial: boolean }> => {
  let beforeSeq: number | undefined;
  let scanned = 0;
  const pages: SessionEvent[][] = [];
  let partial = false;
  for (;;) {
    const page = await store.events(sessionId, undefined, {
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      limit: EVENT_PAGE,
      prefetch: true,
    });
    if (page.length === 0) break;
    pages.unshift(page);
    scanned += page.length;
    const oldest = page[0]!;
    if (oldest.time < earliest || page.length < EVENT_PAGE) break;
    if (scanned >= MAX_EVENTS_PER_SESSION) {
      partial = true;
      break;
    }
    beforeSeq = oldest.seq;
  }
  return { events: pages.flat(), partial };
};

const samplesFromSession = (
  session: SessionProjection,
  events: readonly SessionEvent[],
  projectLabel: string,
  earliest: number,
): SessionSamples => {
  const usage: UsageSample[] = [];
  const turns: TurnSample[] = [];
  const firstSwitch = events.find((event) => event.type === "harness/switched");
  let harnessId = typeof firstSwitch?.data.from === "string" && firstSwitch.data.from.trim()
    ? firstSwitch.data.from.trim()
    : harnessFromProjection(session);

  type ActiveTurn = {
    startedAt: number;
    model?: ModelRef;
    firstAssistantAt: number | null;
    outputTokens: number;
    lastUsageAt: number | null;
    lastUsageModel?: ModelRef;
    toolStarts: Map<string, number>;
    toolIntervals: Array<{ start: number; end: number }>;
    harnessId: string;
  };

  let active: ActiveTurn | null = null;

  const finish = (at: number, reason: "completed" | "error" | "interrupted"): void => {
    if (!active) return;
    const chosen = providerModel(active.lastUsageModel ?? active.model, session);
    if (chosen && at >= earliest) {
      const durationMs = Math.max(0, at - active.startedAt);
      for (const start of active.toolStarts.values()) {
        if (at > start) active.toolIntervals.push({ start, end: at });
      }
      const toolMs = unionDuration(active.toolIntervals);
      const modelMs = Math.max(0, durationMs - toolMs);
      turns.push({
        at,
        sessionId: session.id,
        providerId: chosen.providerId,
        modelId: chosen.modelId,
        harnessId: active.harnessId,
        projectId: session.projectId,
        projectLabel,
        status: reason,
        ttftMs: active.firstAssistantAt === null ? null : Math.max(0, active.firstAssistantAt - active.startedAt),
        tokPerSec: active.outputTokens > 0 && modelMs > 0 ? active.outputTokens / (modelMs / 1000) : null,
        durationMs,
      });
    }
    active = null;
  };

  for (const event of events) {
    const data = event.data as Record<string, unknown>;

    if (event.type === "harness/switched") {
      const next = typeof data.to === "string" ? data.to.trim() : "";
      if (next) harnessId = next;
      continue;
    }

    if (event.type === "turn/started") {
      if (active) finish(event.time, "interrupted");
      active = {
        startedAt: event.time,
        model: modelFrom(data.model),
        firstAssistantAt: null,
        outputTokens: 0,
        lastUsageAt: null,
        toolStarts: new Map(),
        toolIntervals: [],
        harnessId,
      };
      continue;
    }

    if (event.type === "assistant/chunk" || event.type === "assistant/message") {
      if (active && active.firstAssistantAt === null) {
        const text = typeof data.text === "string" ? data.text : "";
        if (text.length > 0) active.firstAssistantAt = event.time;
      }
      continue;
    }

    if (event.type === "tool/started" || event.type === "tool/call") {
      if (!active) continue;
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (callId && !active.toolStarts.has(callId)) active.toolStarts.set(callId, event.time);
      continue;
    }

    if (event.type === "tool/result" || event.type === "tool/error") {
      if (!active) continue;
      const callId = typeof data.callId === "string" ? data.callId : "";
      const start = callId ? active.toolStarts.get(callId) : undefined;
      if (start !== undefined) {
        if (event.time > start) active.toolIntervals.push({ start, end: event.time });
        active.toolStarts.delete(callId);
      }
      continue;
    }

    if (event.type === "usage/recorded") {
      const eventModel = modelFrom(data.model);
      const chosen = providerModel(eventModel, session);
      if (!chosen) continue;
      const sampleTokens = tokensOf(data.tokens);
      const rawCostSource = data.costSource;
      const costSource: TelemetryQuality | null =
        rawCostSource === "native" || rawCostSource === "derived"
          || rawCostSource === "estimated" || rawCostSource === "unknown"
          ? rawCostSource
          : data.cost !== undefined
            ? "unknown"
            : null;
      const sample: UsageSample = {
        at: event.time,
        sessionId: session.id,
        providerId: chosen.providerId,
        modelId: chosen.modelId,
        harnessId: active?.harnessId ?? harnessId,
        projectId: session.projectId,
        projectLabel,
        tokens: sampleTokens,
        cost: finite(data.cost),
        costSource,
      };
      if (event.time >= earliest) usage.push(sample);
      if (active) {
        active.outputTokens += sampleTokens.output;
        active.lastUsageAt = event.time;
        active.lastUsageModel = eventModel;
      }
      continue;
    }

    if (event.type === "turn/stopped" || event.type === "turn/failed") {
      const rawReason = typeof data.reason === "string" ? data.reason : "";
      finish(event.time, rawReason === "completed" ? "completed" : rawReason === "error" || event.type === "turn/failed" ? "error" : "interrupted");
    }
  }

  if (active && active.lastUsageAt !== null) finish(active.lastUsageAt, "interrupted");
  return { usage, turns, partial: false };
};

const bucketShape = (start: number, end: number): { count: number; ms: number } => {
  const duration = Math.max(1, end - start);
  const days = Math.max(1, Math.ceil(duration / DAY_MS));
  const count = days <= 14 ? days : days <= 90 ? Math.min(30, days) : Math.min(52, days);
  return { count, ms: duration / count };
};

const chartSeries = (
  usage: readonly UsageSample[],
  turns: readonly TurnSample[],
  start: number,
  end: number,
  dimension: UsageTelemetryDimension,
  bucketCount: number,
  bucketMs: number,
): UsageTelemetrySeries[] => {
  type MutableSeries = {
    id: string;
    label: string;
    tokens: number[];
    cost: number[];
    sessionIds: Array<Set<string>>;
    requests: number[];
    errors: number[];
    ttft: number[][];
    tps: number[][];
  };
  const byId = new Map<string, MutableSeries>();
  const ensure = (sample: UsageSample | TurnSample): MutableSeries => {
    const item = identity(dimension, sample);
    let series = byId.get(item.id);
    if (!series) {
      series = {
        ...item,
        tokens: Array(bucketCount).fill(0),
        cost: Array(bucketCount).fill(0),
        sessionIds: Array.from({ length: bucketCount }, () => new Set<string>()),
        requests: Array(bucketCount).fill(0),
        errors: Array(bucketCount).fill(0),
        ttft: Array.from({ length: bucketCount }, () => []),
        tps: Array.from({ length: bucketCount }, () => []),
      };
      byId.set(item.id, series);
    }
    return series;
  };
  const bucket = (at: number): number =>
    Math.min(bucketCount - 1, Math.max(0, Math.floor((at - start) / bucketMs)));

  for (const sample of usage) {
    if (sample.at < start || sample.at > end) continue;
    const index = bucket(sample.at);
    const series = ensure(sample);
    series.tokens[index] += effectiveTokens(sample.tokens);
    series.cost[index] += sample.cost;
    series.sessionIds[index]!.add(sample.sessionId);
  }
  for (const sample of turns) {
    if (sample.at < start || sample.at > end) continue;
    const index = bucket(sample.at);
    const series = ensure(sample);
    series.sessionIds[index]!.add(sample.sessionId);
    series.requests[index] += 1;
    if (sample.status === "error") series.errors[index] += 1;
    if (sample.ttftMs !== null) series.ttft[index]!.push(sample.ttftMs);
    if (sample.tokPerSec !== null) series.tps[index]!.push(sample.tokPerSec);
  }

  return [...byId.values()].map((series) => ({
    id: series.id,
    label: series.label,
    tokens: series.tokens,
    cost: series.cost,
    sessions: series.sessionIds.map((set) => set.size),
    requests: series.requests,
    errors: series.errors,
    ttftMs: series.ttft.map((values) => distribution(values)?.p50 ?? null),
    tokPerSec: series.tps.map((values) => distribution(values)?.p50 ?? null),
  })).sort((a, b) =>
    b.cost.reduce((sum, value) => sum + value, 0)
    - a.cost.reduce((sum, value) => sum + value, 0)
    || b.tokens.reduce((sum, value) => sum + value, 0)
    - a.tokens.reduce((sum, value) => sum + value, 0)
    || a.label.localeCompare(b.label));
};

const mapLimit = async <T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      out[index] = await work(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return out;
};

export async function collectUsageTelemetry(input: {
  store: SessionPersistence;
  spaceId: string;
  projects: readonly Project[];
  start: number;
  end: number;
  now?: number;
}): Promise<UsageTelemetryDto> {
  const now = input.now ?? Date.now();
  const end = Math.min(now, input.end);
  const start = Math.min(input.start, end - 1);
  const duration = Math.max(1, end - start);
  const previousStart = start - duration;
  const monthDate = new Date(now);
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getTime();
  const earliest = Math.min(previousStart, monthStart);
  const projectLabels = new Map(input.projects.map((project) => [project.id, project.name]));
  const projections = await input.store.projections(undefined, { spaceId: input.spaceId });
  const candidates = projections.filter((session) => {
    const activity = session.lastTurnAt ?? session.updatedAt;
    return Number.isFinite(activity) && activity >= earliest;
  });

  const collected = await mapLimit(candidates, 8, async (session) => {
    const page = await readEventsSince(input.store, session.id, earliest);
    const samples = samplesFromSession(
      session,
      page.events,
      projectLabels.get(session.projectId) ?? session.projectId,
      earliest,
    );
    return { ...samples, partial: page.partial };
  });

  const usage = collected.flatMap((item) => item.usage);
  const turns = collected.flatMap((item) => item.turns);
  const current = aggregateRange(usage, turns, start, end);
  const previous = aggregateRange(usage, turns, previousStart, start);
  const monthCostByProvider: Record<string, number> = {};
  for (const sample of usage) {
    if (sample.at < monthStart || sample.at > now) continue;
    monthCostByProvider[sample.providerId] = (monthCostByProvider[sample.providerId] ?? 0) + sample.cost;
  }

  const shape = bucketShape(start, end);
  const byDimension = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      chartSeries(usage, turns, start, end, dimension, shape.count, shape.ms),
    ]),
  ) as Record<UsageTelemetryDimension, UsageTelemetrySeries[]>;

  return {
    start,
    end,
    previousStart,
    generatedAt: now,
    partial: collected.some((item) => item.partial),
    current,
    previous,
    monthCostByProvider,
    chart: {
      bucketStarts: Array.from({ length: shape.count }, (_, index) => start + shape.ms * index),
      bucketMs: shape.ms,
      byDimension,
    },
  };
}
