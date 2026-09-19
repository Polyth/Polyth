import type { SessionProjection, TokenUsage } from "@polyth/contracts";
import type { QuotaSnapshotDto, QuotaWindowDto } from "@polyth/session/web-api";
import { getLocale } from "../../../../apps/web/src/i18n/index.ts";
import {
  canonicalProviderId,
  displayProvider,
  isPlaceholderProviderId,
  resolveSessionUsageProviderId,
} from "../providerIdentity.ts";

export type UsageRangeDays = 7 | 30 | 90;
export interface UsageDateRange { start: number; end: number }
export type UsageRangeInput = UsageRangeDays | UsageDateRange;
export type UsageChartMetric = "tokens" | "cost" | "sessions";
export type UsageDimension = "provider" | "model" | "harness" | "project";

export interface UsageTrend {
  percent: number;
  direction: "up" | "down" | "flat";
}

export interface UsageTokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageConsumerSummary {
  id: string;
  label: string;
  sessions: number;
  tokens: number;
  cost: number;
}

export interface UsageProviderSummary {
  id: string;
  label: string;
  sessions: number;
  tokens: number;
  cost: number;
  /** Calendar-month recorded API/equivalent spend, independent of selected range. */
  monthCost: number;
  tokenBreakdown: UsageTokenBreakdown;
  cacheHitPercent: number | null;
  trends: {
    sessions: UsageTrend | null;
    tokens: UsageTrend | null;
    cost: UsageTrend | null;
  };
  snapshot?: QuotaSnapshotDto;
  quotaWindow?: QuotaWindowDto;
  /** Highest-utilization provider quota window, expressed as used percentage. */
  quotaUsedPercent: number | null;
  /** Compatibility field for older widgets/tests. */
  remainingPercent: number | null;
  stale: boolean;
  composition: {
    models: UsageConsumerSummary[];
    harnesses: UsageConsumerSummary[];
    projects: UsageConsumerSummary[];
  };
}

export interface UsageModelSummary extends UsageConsumerSummary {
  providerId: string;
  providerLabel: string;
}

export interface UsageChartSeries {
  id: string;
  label: string;
  values: number[];
}

export interface UsageDimensionSeries {
  tokens: UsageChartSeries[];
  cost: UsageChartSeries[];
  sessions: UsageChartSeries[];
}

export interface UsageDashboardData {
  rangeDays: number;
  rangeStart: number;
  rangeEnd: number;
  totals: {
    sessions: number;
    tokens: number;
    cacheRead: number;
    cacheHitPercent: number | null;
    cost: number;
    averageCostPerThousand: number;
    tokenBreakdown: UsageTokenBreakdown;
  };
  trends: {
    sessions: UsageTrend | null;
    tokens: UsageTrend | null;
    cost: UsageTrend | null;
    averageCostPerThousand: UsageTrend | null;
  };
  providers: UsageProviderSummary[];
  models: UsageModelSummary[];
  consumers: Record<UsageDimension, UsageConsumerSummary[]>;
  chart: {
    labels: string[];
    bucketHours: number;
    /** Provider series retained as the simple/default shape. */
    tokens: UsageChartSeries[];
    cost: UsageChartSeries[];
    sessions: UsageChartSeries[];
    byDimension: Record<UsageDimension, UsageDimensionSeries>;
  };
}

const DAY_MS = 24 * 60 * 60_000;

const finiteNonNegative = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const tokenBreakdown = (usage: TokenUsage | undefined): UsageTokenBreakdown => ({
  input: finiteNonNegative(usage?.input),
  output: finiteNonNegative(usage?.output),
  reasoning: finiteNonNegative(usage?.reasoning),
  cacheRead: finiteNonNegative(usage?.cacheRead),
  cacheWrite: finiteNonNegative(usage?.cacheWrite),
});

const addTokenBreakdown = (left: UsageTokenBreakdown, right: UsageTokenBreakdown): UsageTokenBreakdown => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
});

/** Input + output are the stable cross-provider "effective" total. Reasoning and
 * cache stay visible as their own dimensions because providers account for them
 * differently and some already include reasoning inside output. */
const sessionTokens = (session: SessionProjection): number => {
  const tokens = tokenBreakdown(session.tokenTotals);
  return tokens.input + tokens.output;
};

const sessionCost = (session: SessionProjection): number =>
  finiteNonNegative(session.costTotal);

const sessionActivityAt = (session: SessionProjection): number =>
  typeof session.lastTurnAt === "number" && Number.isFinite(session.lastTurnAt)
    ? session.lastTurnAt
    : session.updatedAt;

const sessionProviderId = (session: SessionProjection): string | undefined =>
  resolveSessionUsageProviderId(session);

const sessionModelId = (session: SessionProjection): string =>
  session.model?.modelID?.trim() || "Automatic";

const sessionHarnessId = (session: SessionProjection): string =>
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

const quotaProviderId = (providerId: string): string | undefined => {
  if (isPlaceholderProviderId(providerId)) return undefined;
  const canonical = canonicalProviderId(providerId);
  return canonical || undefined;
};

const trendOf = (current: number, previous: number): UsageTrend | null => {
  if (previous <= 0) return null;
  const percent = ((current - previous) / previous) * 100;
  return {
    percent,
    direction: Math.abs(percent) < .5 ? "flat" : percent > 0 ? "up" : "down",
  };
};

const primaryQuotaWindow = (snapshot: QuotaSnapshotDto | undefined): QuotaWindowDto | undefined =>
  snapshot?.windows.reduce<QuotaWindowDto | undefined>((selected, window) => {
    if (!selected) return window;
    const selectedFraction = selected.limit > 0 ? selected.used / selected.limit : 0;
    const fraction = window.limit > 0 ? window.used / window.limit : 0;
    return fraction > selectedFraction ? window : selected;
  }, undefined);

const sumSessions = (sessions: readonly SessionProjection[]) => {
  let breakdown: UsageTokenBreakdown = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const session of sessions) breakdown = addTokenBreakdown(breakdown, tokenBreakdown(session.tokenTotals));
  const tokens = sessions.reduce((sum, session) => sum + sessionTokens(session), 0);
  const cacheEligible = breakdown.input + breakdown.cacheRead;
  const cost = sessions.reduce((sum, session) => sum + sessionCost(session), 0);
  return {
    sessions: sessions.length,
    tokens,
    cacheRead: breakdown.cacheRead,
    cacheHitPercent: cacheEligible > 0 ? breakdown.cacheRead / cacheEligible * 100 : null,
    cost,
    averageCostPerThousand: tokens > 0 ? cost / tokens * 1_000 : 0,
    tokenBreakdown: breakdown,
  };
};

const metricValue = (session: SessionProjection, metric: UsageChartMetric): number => {
  if (metric === "tokens") return sessionTokens(session);
  if (metric === "cost") return sessionCost(session);
  return 1;
};

const shortDate = (timestamp: number): string =>
  new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" }).format(timestamp);

const bucketLabel = (start: number, end: number): string => {
  const first = shortDate(start);
  const last = shortDate(Math.max(start, end - 1));
  return first === last ? first : `${first}–${last}`;
};

interface ResolvedRange {
  start: number;
  end: number;
  previousStart: number;
  days: number;
  bucketCount: number;
  bucketMs: number;
}

const resolveRange = (range: UsageRangeInput, now: number): ResolvedRange => {
  if (typeof range === "number") {
    const start = now - range * DAY_MS;
    return {
      start,
      end: now,
      previousStart: start - range * DAY_MS,
      days: range,
      bucketCount: range,
      bucketMs: DAY_MS,
    };
  }
  const rawStart = Number.isFinite(range.start) ? range.start : now - 7 * DAY_MS;
  const rawEnd = Number.isFinite(range.end) ? range.end : now;
  const end = Math.min(now, Math.max(rawStart + 1, rawEnd));
  const start = Math.min(rawStart, end - 1);
  const duration = Math.max(1, end - start);
  const days = Math.max(1, Math.ceil(duration / DAY_MS));
  const bucketCount = days <= 14 ? days : days <= 90 ? Math.min(30, days) : Math.min(52, days);
  return {
    start,
    end,
    previousStart: start - duration,
    days,
    bucketCount,
    bucketMs: duration / bucketCount,
  };
};

const dimensionIdentity = (
  session: SessionProjection,
  dimension: UsageDimension,
  projectLabels: Readonly<Record<string, string>>,
): { id: string; label: string } | null => {
  const providerId = sessionProviderId(session);
  if (dimension === "provider") {
    return providerId ? { id: providerId, label: displayProvider(providerId) } : null;
  }
  if (dimension === "model") {
    if (!providerId) return null;
    const modelId = sessionModelId(session);
    return { id: `${providerId}/${modelId}`, label: modelId };
  }
  if (dimension === "harness") {
    const harnessId = sessionHarnessId(session);
    return { id: harnessId, label: readableIdentifier(harnessId) };
  }
  return {
    id: session.projectId,
    label: projectLabels[session.projectId] || session.projectId,
  };
};

const summarizeDimension = (
  sessions: readonly SessionProjection[],
  dimension: UsageDimension,
  projectLabels: Readonly<Record<string, string>>,
): UsageConsumerSummary[] => {
  const summaries = new Map<string, UsageConsumerSummary>();
  for (const session of sessions) {
    const identity = dimensionIdentity(session, dimension, projectLabels);
    if (!identity) continue;
    const summary = summaries.get(identity.id) ?? {
      ...identity,
      sessions: 0,
      tokens: 0,
      cost: 0,
    };
    summary.sessions += 1;
    summary.tokens += sessionTokens(session);
    summary.cost += sessionCost(session);
    summaries.set(identity.id, summary);
  }
  return [...summaries.values()].sort((a, b) =>
    b.cost - a.cost || b.tokens - a.tokens || b.sessions - a.sessions || a.label.localeCompare(b.label));
};

export function buildUsageDashboardData(
  sessions: readonly SessionProjection[],
  snapshots: readonly QuotaSnapshotDto[],
  range: UsageRangeInput,
  now = Date.now(),
  projectLabels: Readonly<Record<string, string>> = {},
): UsageDashboardData {
  const resolvedRange = resolveRange(range, now);
  const { start: rangeStart, end: rangeEnd, previousStart, days: rangeDays, bucketCount, bucketMs } = resolvedRange;
  const current = sessions.filter((session) => {
    const activityAt = sessionActivityAt(session);
    return activityAt >= rangeStart && activityAt <= rangeEnd;
  });
  const previous = sessions.filter((session) => {
    const activityAt = sessionActivityAt(session);
    return activityAt >= previousStart && activityAt < rangeStart;
  });
  const totals = sumSessions(current);
  const previousTotals = sumSessions(previous);

  const monthDate = new Date(now);
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getTime();
  const monthSessions = sessions.filter((session) => {
    const at = sessionActivityAt(session);
    return at >= monthStart && at <= now;
  });

  const providerIds = new Set<string>();
  for (const session of current) {
    const id = sessionProviderId(session);
    if (id) providerIds.add(id);
  }
  for (const session of previous) {
    const id = sessionProviderId(session);
    if (id) providerIds.add(id);
  }
  for (const snapshot of snapshots) {
    const id = quotaProviderId(snapshot.providerId);
    if (id) providerIds.add(id);
  }

  const providers = [...providerIds].map((id): UsageProviderSummary => {
    const providerCurrent = current.filter((session) => sessionProviderId(session) === id);
    const providerPrevious = previous.filter((session) => sessionProviderId(session) === id);
    const providerMonth = monthSessions.filter((session) => sessionProviderId(session) === id);
    const currentTotals = sumSessions(providerCurrent);
    const previousProviderTotals = sumSessions(providerPrevious);
    const snapshot = snapshots.find((item) => quotaProviderId(item.providerId) === id);
    const quotaWindow = primaryQuotaWindow(snapshot);
    const quotaUsedPercent = quotaWindow && quotaWindow.limit > 0
      ? Math.round(Math.min(1, Math.max(0, quotaWindow.used / quotaWindow.limit)) * 100)
      : null;
    return {
      id,
      label: displayProvider(id),
      sessions: currentTotals.sessions,
      tokens: currentTotals.tokens,
      cost: currentTotals.cost,
      monthCost: providerMonth.reduce((sum, session) => sum + sessionCost(session), 0),
      tokenBreakdown: currentTotals.tokenBreakdown,
      cacheHitPercent: currentTotals.cacheHitPercent,
      trends: {
        sessions: trendOf(currentTotals.sessions, previousProviderTotals.sessions),
        tokens: trendOf(currentTotals.tokens, previousProviderTotals.tokens),
        cost: trendOf(currentTotals.cost, previousProviderTotals.cost),
      },
      ...(snapshot ? { snapshot } : {}),
      ...(quotaWindow ? { quotaWindow } : {}),
      quotaUsedPercent,
      remainingPercent: quotaUsedPercent === null ? null : 100 - quotaUsedPercent,
      stale: snapshot?.stale ?? false,
      composition: {
        models: summarizeDimension(providerCurrent, "model", projectLabels),
        harnesses: summarizeDimension(providerCurrent, "harness", projectLabels),
        projects: summarizeDimension(providerCurrent, "project", projectLabels),
      },
    };
  }).sort((a, b) =>
    b.cost - a.cost || b.tokens - a.tokens || b.sessions - a.sessions || a.label.localeCompare(b.label));

  const modelConsumers = summarizeDimension(current, "model", projectLabels);
  const models: UsageModelSummary[] = modelConsumers.map((model) => {
    const slash = model.id.indexOf("/");
    const providerId = slash >= 0 ? model.id.slice(0, slash) : "";
    return {
      ...model,
      providerId,
      providerLabel: providerId ? displayProvider(providerId) : "",
    };
  });

  const dimensions: UsageDimension[] = ["provider", "model", "harness", "project"];
  const consumers = Object.fromEntries(
    dimensions.map((dimension) => [dimension, summarizeDimension(current, dimension, projectLabels)]),
  ) as Record<UsageDimension, UsageConsumerSummary[]>;

  const labels = Array.from({ length: bucketCount }, (_, index) => {
    const start = rangeStart + bucketMs * index;
    return bucketLabel(start, start + bucketMs);
  });

  const makeSeries = (dimension: UsageDimension, metric: UsageChartMetric): UsageChartSeries[] => {
    const byId = new Map<string, UsageChartSeries>();
    for (const session of current) {
      const identity = dimensionIdentity(session, dimension, projectLabels);
      if (!identity) continue;
      let series = byId.get(identity.id);
      if (!series) {
        series = { ...identity, values: Array.from({ length: bucketCount }, () => 0) };
        byId.set(identity.id, series);
      }
      const index = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((sessionActivityAt(session) - rangeStart) / bucketMs)),
      );
      series.values[index] = (series.values[index] ?? 0) + metricValue(session, metric);
    }
    return [...byId.values()].sort((a, b) =>
      b.values.reduce((sum, value) => sum + value, 0)
      - a.values.reduce((sum, value) => sum + value, 0)
      || a.label.localeCompare(b.label));
  };

  const byDimension = Object.fromEntries(dimensions.map((dimension) => [
    dimension,
    {
      tokens: makeSeries(dimension, "tokens"),
      cost: makeSeries(dimension, "cost"),
      sessions: makeSeries(dimension, "sessions"),
    },
  ])) as Record<UsageDimension, UsageDimensionSeries>;

  return {
    rangeDays,
    rangeStart,
    rangeEnd,
    totals,
    trends: {
      sessions: trendOf(totals.sessions, previousTotals.sessions),
      tokens: trendOf(totals.tokens, previousTotals.tokens),
      cost: trendOf(totals.cost, previousTotals.cost),
      averageCostPerThousand: trendOf(totals.averageCostPerThousand, previousTotals.averageCostPerThousand),
    },
    providers,
    models,
    consumers,
    chart: {
      labels,
      bucketHours: bucketMs / (60 * 60_000),
      tokens: byDimension.provider.tokens,
      cost: byDimension.provider.cost,
      sessions: byDimension.provider.sessions,
      byDimension,
    },
  };
}
