import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Chart,
  registerables,
  type ChartConfiguration,
} from "chart.js";
import { fmtTokens } from "../../../../apps/web/src/format.ts";
import { getLocale } from "../../../../apps/web/src/i18n/index.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import type {
  UsageAnalyticsAggregation,
  UsageAnalyticsGroupBy,
  UsageAnalyticsGroupSummary,
  UsageAnalyticsMetric,
  UsageAnalyticsResponse,
  UsageAnalyticsSeries,
} from "../../src/analyticsTypes.ts";
import {
  useUsageAnalytics,
  type UsageAnalyticsClientQuery,
} from "./analyticsClient.ts";
import { useQuotaSnapshots } from "./quotaUi.tsx";
import {
  useUsagePrefs,
  type UsageMetricId,
  type UsageProviderCostProfile,
} from "../usagePrefs.ts";

Chart.register(...registerables);

export interface UsageAnalyticsRange {
  from: number;
  to: number;
}

export interface UsageAnalyticsScope {
  range: UsageAnalyticsRange;
  projectId?: string;
  providerId?: string;
  modelId?: string;
  harnessId?: string;
}

const money = (value: number): string =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);

const number = (value: number, digits = 1): string =>
  new Intl.NumberFormat(getLocale(), { maximumFractionDigits: digits }).format(value);

const percent = (value: number | null, digits = 0): string =>
  value === null ? "—" : new Intl.NumberFormat(getLocale(), {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(value);

const duration = (value: number | null): string => {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${number(value / 1_000, value < 10_000 ? 2 : 1)}s`;
};

const rate = (value: number | null): string =>
  value === null ? "—" : `${number(value, value < 100 ? 1 : 0)}/s`;

const totalTokens = (summary: UsageAnalyticsResponse["summary"]): number =>
  summary.inputTokens + summary.outputTokens + summary.reasoningTokens;

const delta = (current: number | null, previous: number | null): number | null => {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
};

const deltaLabel = (value: number | null): string =>
  value === null
    ? "—"
    : `${value >= 0 ? "+" : ""}${new Intl.NumberFormat(getLocale(), {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(value)}`;

const palette = (): string[] => {
  if (typeof document === "undefined") return ["currentColor"];
  const style = getComputedStyle(document.documentElement);
  const values = ["--accent", "--purple", "--blue", "--green", "--amber", "--text-dim"]
    .map((name) => style.getPropertyValue(name).trim())
    .filter(Boolean);
  return values.length > 0 ? values : ["currentColor"];
};

const reducedMotion = (): boolean =>
  typeof window !== "undefined"
  && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    || document.documentElement.dataset.reduceAnimations === "true");

const timeLabel = (time: number, span: number): string => {
  const date = new Date(time);
  if (span <= 48 * 60 * 60_000) {
    return new Intl.DateTimeFormat(getLocale(), {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  if (span <= 45 * 24 * 60 * 60_000) {
    return new Intl.DateTimeFormat(getLocale(), {
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
  }).format(date);
};

const queryFor = (
  scope: UsageAnalyticsScope,
  metric: UsageAnalyticsMetric,
  groupBy: UsageAnalyticsGroupBy,
  aggregation: UsageAnalyticsAggregation,
  limit = 8,
): UsageAnalyticsClientQuery => ({
  from: scope.range.from,
  to: scope.range.to,
  metric,
  groupBy,
  aggregation,
  ...(scope.projectId ? { projectId: scope.projectId } : {}),
  ...(scope.providerId ? { providerId: scope.providerId } : {}),
  ...(scope.modelId ? { modelId: scope.modelId } : {}),
  ...(scope.harnessId ? { harnessId: scope.harnessId } : {}),
  limit,
});

function AnalyticsState({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  children: ReactNode;
}) {
  if (loading && empty) return <div className="usage-analytics-state">Indexing usage…</div>;
  if (error && empty) return <div className="usage-analytics-state error">Analytics unavailable · {error}</div>;
  if (empty) return <div className="usage-analytics-state">No turn telemetry in this range.</div>;
  return <>{children}</>;
}

function Trend({
  value,
  inverse = false,
}: {
  value: number | null;
  inverse?: boolean;
}) {
  if (value === null) return <span className="usage-analytics-delta muted">—</span>;
  const favorable = inverse ? value < 0 : value > 0;
  return (
    <span
      className={`usage-analytics-delta ${favorable ? "good" : value === 0 ? "neutral" : "bad"}`}
      aria-label={`${deltaLabel(value)} versus previous period`}
    >
      {deltaLabel(value)}
    </span>
  );
}

function LineChart({
  data,
  valueFormat,
  labels = {},
  height = 190,
}: {
  data: UsageAnalyticsResponse;
  valueFormat(value: number): string;
  labels?: Record<string, string>;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || data.series.length === 0) return;
    const colors = palette();
    const times = [...new Set(data.series.flatMap((series) => series.points.map((point) => point.time)))]
      .sort((a, b) => a - b);
    const span = data.query.to - data.query.from;
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: times.map((time) => timeLabel(time, span)),
        datasets: data.series.map((series, index) => {
          const values = new Map(series.points.map((point) => [point.time, point.value]));
          return {
            label: labels[series.id] ?? series.id,
            data: times.map((time) => values.get(time) ?? null),
            borderColor: colors[index % colors.length],
            backgroundColor: colors[index % colors.length],
            borderWidth: 2,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: false,
            tension: .25,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion() ? false : { duration: 160 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: data.series.length > 1,
            position: "bottom",
            labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: (context) => `${context.dataset.label}: ${valueFormat(Number(context.raw ?? 0))}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 7 } },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(127,127,127,.12)" },
            ticks: { callback: (value) => valueFormat(Number(value)) },
          },
        },
      },
    } as ChartConfiguration);
    return () => chart.destroy();
  }, [data, height, labels, valueFormat]);

  return (
    <div className="usage-analytics-chart" style={{ height }}>
      <canvas ref={ref} role="img" aria-label="Usage telemetry over time" />
    </div>
  );
}

function Block({
  title,
  meta,
  className = "",
  children,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`usage-analytics-block ${className}`}>
      <header className="usage-analytics-block-head">
        <div>
          <h3>{title}</h3>
          {meta && <span>{meta}</span>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function UsageSummaryBlock({
  scope,
  metrics = ["cost", "tokens", "sessions", "ttft", "tps", "cache"],
}: {
  scope: UsageAnalyticsScope;
  metrics?: readonly UsageMetricId[];
}) {
  const query = useMemo(
    () => queryFor(scope, "outputTokPerSec", "none", "p50", 1),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  const prefs = useUsagePrefs();
  const hasSubscriptions = Object.values(prefs.providerCosts)
    .some((profile) => profile.billing === "subscription");
  const items = data ? {
    cost: {
      label: hasSubscriptions ? "Cost telemetry" : "Spend",
      value: money(data.summary.recordedCost),
      trend: delta(data.summary.recordedCost, data.previousSummary.recordedCost),
      hint: hasSubscriptions ? "Subscription usage is API-equivalent" : undefined,
    },
    tokens: {
      label: "Tokens",
      value: fmtTokens(totalTokens(data.summary)),
      trend: delta(totalTokens(data.summary), totalTokens(data.previousSummary)),
    },
    sessions: {
      label: "Sessions",
      value: number(data.summary.sessions, 0),
      trend: delta(data.summary.sessions, data.previousSummary.sessions),
    },
    ttft: {
      label: "TTFT",
      value: duration(data.summary.ttftMs.p50),
      trend: delta(data.summary.ttftMs.p50, data.previousSummary.ttftMs.p50),
      inverse: true,
    },
    tps: {
      label: "Speed",
      value: rate(data.summary.outputTokPerSec.p50),
      trend: delta(data.summary.outputTokPerSec.p50, data.previousSummary.outputTokPerSec.p50),
    },
    cache: {
      label: "Cache",
      value: percent(data.summary.cachePercent),
      trend: data.summary.cachePercent !== null && data.previousSummary.cachePercent !== null
        ? data.summary.cachePercent - data.previousSummary.cachePercent
        : null,
    },
    errors: {
      label: "Errors",
      value: percent(data.summary.errorRate, 1),
      trend: delta(data.summary.errorRate, data.previousSummary.errorRate),
      inverse: true,
    },
    success: {
      label: "Success",
      value: percent(data.summary.successRate, 1),
      trend: delta(data.summary.successRate, data.previousSummary.successRate),
    },
  } : null;

  return (
    <Block title="Summary" className="usage-summary-block">
      <AnalyticsState
        loading={state.loading}
        error={state.error}
        empty={!data || data.summary.observations === 0}
      >
        <div className="usage-summary-kpis">
          {metrics.slice(0, 6).flatMap((metric) => {
            const item = items?.[metric as keyof typeof items];
            return item ? [(
              <div className="usage-summary-kpi" key={metric}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <Trend value={item.trend} inverse={"inverse" in item ? item.inverse : false} />
                {"hint" in item && item.hint && <small>{item.hint}</small>}
              </div>
            )] : [];
          })}
        </div>
      </AnalyticsState>
    </Block>
  );
}

export function UsageThroughputBlock({
  scope,
  groupBy = "provider",
  aggregation = "p50",
}: {
  scope: UsageAnalyticsScope;
  groupBy?: UsageAnalyticsGroupBy;
  aggregation?: UsageAnalyticsAggregation;
}) {
  const query = useMemo(
    () => queryFor(scope, "outputTokPerSec", groupBy, aggregation, 6),
    [aggregation, groupBy, scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  const change = data
    ? delta(data.summary.outputTokPerSec.p50, data.previousSummary.outputTokPerSec.p50)
    : null;
  return (
    <Block
      title="Token throughput"
      meta={data ? <>p50 {rate(data.summary.outputTokPerSec.p50)} <Trend value={change} /></> : "Real workload speed"}
    >
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        {data && <LineChart data={data} valueFormat={(value) => `${number(value, 0)}/s`} />}
      </AnalyticsState>
    </Block>
  );
}

export function UsageTtftBlock({
  scope,
  groupBy = "provider",
  aggregation = "p50",
}: {
  scope: UsageAnalyticsScope;
  groupBy?: UsageAnalyticsGroupBy;
  aggregation?: UsageAnalyticsAggregation;
}) {
  const query = useMemo(
    () => queryFor(scope, "ttftMs", groupBy, aggregation, 6),
    [aggregation, groupBy, scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  const change = data ? delta(data.summary.ttftMs.p50, data.previousSummary.ttftMs.p50) : null;
  return (
    <Block title="TTFT" meta={data ? <>p50 {duration(data.summary.ttftMs.p50)} <Trend value={change} inverse /></> : "First response latency"}>
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        {data && <LineChart data={data} valueFormat={(value) => duration(value)} />}
      </AnalyticsState>
    </Block>
  );
}

const providerProfile = (
  id: string,
  profiles: Record<string, UsageProviderCostProfile>,
): UsageProviderCostProfile => profiles[id] ?? {
  billing: "api",
  monthlyCost: null,
  monthlyBudget: null,
};

export function UsageSpendTrendBlock({
  scope,
  groupBy = "provider",
}: {
  scope: UsageAnalyticsScope;
  groupBy?: UsageAnalyticsGroupBy;
}) {
  const query = useMemo(
    () => queryFor(scope, "recordedCost", groupBy, "sum", 6),
    [groupBy, scope],
  );
  const state = useUsageAnalytics(query);
  const prefs = useUsagePrefs();
  const data = state.data;
  const labels = useMemo(() => {
    if (!data || groupBy !== "provider") return {};
    return Object.fromEntries(data.groups.map((group) => {
      const profile = providerProfile(group.id, prefs.providerCosts);
      return [group.id, profile.billing === "subscription" ? `${group.id} · API equiv.` : group.id];
    }));
  }, [data, groupBy, prefs.providerCosts]);

  const actualApi = data?.groups.reduce((sum, group) =>
    providerProfile(group.id, prefs.providerCosts).billing === "api"
      ? sum + group.recordedCost
      : sum, 0) ?? 0;
  const equivalent = data?.groups.reduce((sum, group) =>
    providerProfile(group.id, prefs.providerCosts).billing === "subscription"
      ? sum + group.recordedCost
      : sum, 0) ?? 0;

  return (
    <Block
      title="Spend trend"
      meta={data
        ? equivalent > 0
          ? <>{money(actualApi)} API · {money(equivalent)} subscription API-equivalent</>
          : <>{money(actualApi)} recorded API spend</>
        : "Recorded cost telemetry"}
    >
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        {data && <LineChart data={data} labels={labels} valueFormat={money} />}
      </AnalyticsState>
    </Block>
  );
}

export function UsagePerformanceBlock({ scope }: { scope: UsageAnalyticsScope }) {
  const query = useMemo(
    () => queryFor(scope, "outputTokPerSec", "provider", "p50", 6),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  const rows = data ? [
    ["TTFT", duration(data.summary.ttftMs.p50), duration(data.summary.ttftMs.p95)],
    ["Output speed", rate(data.summary.outputTokPerSec.p50), rate(data.summary.outputTokPerSec.p95)],
    ["Turn duration", duration(data.summary.turnDurationMs.p50), duration(data.summary.turnDurationMs.p95)],
    ["Errors", percent(data.summary.errorRate, 1), "—"],
  ] : [];
  return (
    <Block title="Performance" meta="p50 / p95 from completed turns">
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        <div className="usage-performance-table">
          <div className="head"><span>Metric</span><span>p50</span><span>p95</span></div>
          {rows.map(([label, p50, p95]) => (
            <div key={label}><span>{label}</span><strong>{p50}</strong><strong>{p95}</strong></div>
          ))}
        </div>
      </AnalyticsState>
    </Block>
  );
}

interface ChangeFact {
  label: string;
  value: number;
  format: (value: number) => string;
  inverse?: boolean;
}

export function UsageWhatChangedBlock({ scope }: { scope: UsageAnalyticsScope }) {
  const query = useMemo(
    () => queryFor(scope, "outputTokPerSec", "none", "p50", 1),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  const facts = useMemo(() => {
    if (!data) return [] as ChangeFact[];
    const current = data.summary;
    const previous = data.previousSummary;
    const candidates: Array<ChangeFact | null> = [
      previous.recordedCost > 0 ? {
        label: "Cost telemetry",
        value: delta(current.recordedCost, previous.recordedCost) ?? 0,
        format: deltaLabel,
      } : null,
      totalTokens(previous) > 0 ? {
        label: "Token volume",
        value: delta(totalTokens(current), totalTokens(previous)) ?? 0,
        format: deltaLabel,
      } : null,
      previous.outputTokPerSec.p50 ? {
        label: "Output speed",
        value: delta(current.outputTokPerSec.p50, previous.outputTokPerSec.p50) ?? 0,
        format: deltaLabel,
      } : null,
      previous.ttftMs.p50 ? {
        label: "TTFT",
        value: delta(current.ttftMs.p50, previous.ttftMs.p50) ?? 0,
        format: deltaLabel,
        inverse: true,
      } : null,
      current.cachePercent !== null && previous.cachePercent !== null ? {
        label: "Cache hit",
        value: current.cachePercent - previous.cachePercent,
        format: (value) => `${value >= 0 ? "+" : ""}${number(value * 100, 0)} pp`,
      } : null,
      previous.errorRate ? {
        label: "Error rate",
        value: delta(current.errorRate, previous.errorRate) ?? 0,
        format: deltaLabel,
        inverse: true,
      } : null,
    ];
    return candidates
      .filter((fact): fact is ChangeFact => fact !== null)
      .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
      .slice(0, 5);
  }, [data]);

  return (
    <Block title="What changed?" meta="Compared with the previous equal period">
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        <div className="usage-change-list">
          {facts.map((fact) => {
            const favorable = fact.inverse ? fact.value < 0 : fact.value > 0;
            return (
              <div key={fact.label}>
                <span>{fact.label}</span>
                <strong className={favorable ? "good" : fact.value === 0 ? "neutral" : "bad"}>
                  {fact.format(fact.value)}
                </strong>
              </div>
            );
          })}
          {facts.length === 0 && <div className="usage-analytics-state">Need a previous period for comparison.</div>}
        </div>
      </AnalyticsState>
    </Block>
  );
}

const monthRange = (now = Date.now()): UsageAnalyticsRange => {
  const date = new Date(now);
  return {
    from: new Date(date.getFullYear(), date.getMonth(), 1).getTime(),
    to: now,
  };
};

export function UsageSubscriptionValueBlock({
  providerId,
  projectId,
}: {
  providerId?: string;
  projectId?: string;
}) {
  const prefs = useUsagePrefs();
  const scope = useMemo<UsageAnalyticsScope>(() => ({
    range: monthRange(),
    ...(projectId ? { projectId } : {}),
    ...(providerId ? { providerId } : {}),
  }), [projectId, providerId]);
  const query = useMemo(
    () => queryFor(scope, "recordedCost", "provider", "sum", 12),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const subscriptions = state.data?.groups
    .map((group) => ({ group, profile: providerProfile(group.id, prefs.providerCosts) }))
    .filter(({ profile }) => profile.billing === "subscription" && (profile.monthlyCost ?? 0) > 0)
    .sort((left, right) => right.group.recordedCost - left.group.recordedCost) ?? [];
  const selected = providerId
    ? subscriptions.find(({ group }) => group.id === providerId) ?? null
    : subscriptions[0] ?? null;

  return (
    <Block title="Subscription value" meta="Current month · API-equivalent workload">
      <AnalyticsState
        loading={state.loading}
        error={state.error}
        empty={!state.data || state.data.summary.observations === 0}
      >
        {selected ? (() => {
          const monthly = selected.profile.monthlyCost ?? 0;
          const equivalent = selected.group.recordedCost;
          const multiplier = monthly > 0 ? equivalent / monthly : null;
          return (
            <div className="usage-subscription-value">
              <div className="usage-subscription-provider">
                <ProviderLogo providerID={selected.group.id} className="usage-analytics-provider-logo" />
                <strong>{selected.group.id}</strong>
              </div>
              <div><span>Subscription</span><strong>{money(monthly)} / mo</strong></div>
              <div><span>API equivalent</span><strong>{money(equivalent)}</strong></div>
              <div><span>Value</span><strong>{multiplier === null ? "—" : `${number(multiplier, 1)}×`}</strong></div>
              <div><span>Estimated difference</span><strong>{money(equivalent - monthly)}</strong></div>
              {selected.group.costKnownTurns < selected.group.observations && (
                <small>Cost telemetry is partial for this provider.</small>
              )}
            </div>
          );
        })() : (
          <div className="usage-analytics-state">
            Configure a subscription provider and monthly price in Usage settings.
          </div>
        )}
      </AnalyticsState>
    </Block>
  );
}

function BubbleChart({ groups }: { groups: readonly UsageAnalyticsGroupSummary[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const points = groups.flatMap((group) => {
      const speed = group.outputTokPerSec.p50;
      if (speed === null || group.outputTokens <= 0 || group.recordedCost <= 0) return [];
      return [{
        id: group.id,
        x: group.recordedCost / group.outputTokens * 1_000_000,
        y: speed,
        volume: group.outputTokens,
      }];
    });
    if (points.length === 0) return;
    const colors = palette();
    const maxVolume = Math.max(...points.map((point) => point.volume));
    const chart = new Chart(canvas, {
      type: "bubble",
      data: {
        datasets: points.map((point, index) => ({
          label: point.id,
          data: [{
            x: point.x,
            y: point.y,
            r: 5 + 12 * Math.sqrt(point.volume / maxVolume),
          }],
          borderColor: colors[index % colors.length],
          backgroundColor: colors[index % colors.length],
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion() ? false : { duration: 160 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const point = points[context.datasetIndex];
                return point
                  ? `${point.id}: ${rate(point.y)} · ${money(point.x)} / 1M output`
                  : "";
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            title: { display: true, text: "Recorded cost / 1M output" },
            ticks: { callback: (value) => money(Number(value)) },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: "Output tok/s · p50" },
          },
        },
      },
    } as ChartConfiguration);
    return () => chart.destroy();
  }, [groups]);
  return (
    <div className="usage-analytics-chart usage-efficiency-chart">
      <canvas ref={ref} role="img" aria-label="Model efficiency: cost versus output speed" />
    </div>
  );
}

export function UsageModelEfficiencyBlock({ scope }: { scope: UsageAnalyticsScope }) {
  const query = useMemo(
    () => queryFor(scope, "outputTokPerSec", "model", "p50", 12),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const usable = state.data?.groups.filter((group) =>
    group.outputTokPerSec.p50 !== null && group.outputTokens > 0 && group.recordedCost > 0) ?? [];
  return (
    <Block title="Model efficiency" meta="Bubble size = output volume · recorded/equivalent cost">
      <AnalyticsState loading={state.loading} error={state.error} empty={usable.length === 0}>
        <BubbleChart groups={usable} />
      </AnalyticsState>
    </Block>
  );
}

const breakdownMetric = (
  group: UsageAnalyticsGroupSummary,
  metric: "cost" | "tokens" | "output" | "sessions" | "requests",
): number => {
  switch (metric) {
    case "cost": return group.recordedCost;
    case "tokens": return group.inputTokens + group.outputTokens + group.reasoningTokens;
    case "output": return group.outputTokens;
    case "sessions": return group.sessions;
    case "requests": return group.observations;
  }
};

export function UsageBreakdownBlock({
  scope,
  groupBy = "provider",
  metric = "cost",
}: {
  scope: UsageAnalyticsScope;
  groupBy?: Exclude<UsageAnalyticsGroupBy, "none">;
  metric?: "cost" | "tokens" | "output" | "sessions" | "requests";
}) {
  const serverMetric: UsageAnalyticsMetric = metric === "cost"
    ? "recordedCost"
    : metric === "output"
      ? "outputTokens"
      : metric === "sessions"
        ? "sessions"
        : metric === "requests"
          ? "turns"
          : "totalTokens";
  const query = useMemo(
    () => queryFor(scope, serverMetric, groupBy, "sum", 8),
    [groupBy, scope, serverMetric],
  );
  const state = useUsageAnalytics(query);
  const groups = state.data?.groups ?? [];
  const values = groups.map((group) => breakdownMetric(group, metric));
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(0, ...values);
  const format = (value: number) => metric === "cost"
    ? money(value)
    : metric === "tokens" || metric === "output"
      ? fmtTokens(value)
      : number(value, 0);

  return (
    <Block title="Usage breakdown" meta={`${metric} by ${groupBy}`}>
      <AnalyticsState loading={state.loading} error={state.error} empty={groups.length === 0}>
        <div className="usage-breakdown-list">
          {groups.map((group, index) => {
            const value = values[index] ?? 0;
            return (
              <div className="usage-breakdown-row" key={group.id}>
                <span title={group.id}>{group.id}</span>
                <div className="usage-breakdown-track">
                  <i style={{ width: `${max > 0 ? value / max * 100 : 0}%` }} />
                </div>
                <strong>{format(value)}</strong>
                <small>{total > 0 ? percent(value / total) : "—"}</small>
              </div>
            );
          })}
        </div>
      </AnalyticsState>
    </Block>
  );
}

export function UsageReliabilityBlock({ scope }: { scope: UsageAnalyticsScope }) {
  const query = useMemo(
    () => queryFor(scope, "successRate", "provider", "average", 8),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  return (
    <Block title="Reliability" meta={data ? `${percent(data.summary.successRate, 1)} successful` : "Completed turns"}>
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        {data && (
          <div className="usage-reliability-grid">
            <div><span>Success</span><strong>{percent(data.summary.successRate, 1)}</strong></div>
            <div><span>Failed</span><strong>{percent(data.summary.errorRate, 1)}</strong></div>
            <div><span>Interrupted</span><strong>{percent(data.summary.abortedRate, 1)}</strong></div>
            <div><span>Turns</span><strong>{number(data.summary.observations, 0)}</strong></div>
          </div>
        )}
      </AnalyticsState>
    </Block>
  );
}

export function UsageCacheEfficiencyBlock({ scope }: { scope: UsageAnalyticsScope }) {
  const query = useMemo(
    () => queryFor(scope, "cachePercent", "provider", "average", 8),
    [scope],
  );
  const state = useUsageAnalytics(query);
  const data = state.data;
  const change = data?.summary.cachePercent !== null
    && data?.previousSummary.cachePercent !== null
    && data
    ? data.summary.cachePercent - data.previousSummary.cachePercent
    : null;
  return (
    <Block title="Cache efficiency" meta={data ? <>{percent(data.summary.cachePercent)} <Trend value={change} /></> : "Prompt cache usage"}>
      <AnalyticsState loading={state.loading} error={state.error} empty={!data || data.summary.observations === 0}>
        {data && (
          <div className="usage-reliability-grid">
            <div><span>Hit rate</span><strong>{percent(data.summary.cachePercent)}</strong></div>
            <div><span>Cache read</span><strong>{fmtTokens(data.summary.cacheReadTokens)}</strong></div>
            <div><span>Input uncached</span><strong>{fmtTokens(data.summary.inputTokens)}</strong></div>
            <div><span>Cache write</span><strong>{fmtTokens(data.summary.cacheWriteTokens)}</strong></div>
          </div>
        )}
      </AnalyticsState>
    </Block>
  );
}

const quotaReset = (resetsAt: number, now = Date.now()): string => {
  const diff = resetsAt - now;
  if (diff <= 0) return "now";
  if (diff < 48 * 60 * 60_000) {
    const hours = Math.floor(diff / (60 * 60_000));
    const minutes = Math.floor((diff % (60 * 60_000)) / 60_000);
    if (hours <= 0) return `${Math.max(1, minutes)}m`;
    return minutes >= 15 && hours < 12 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (diff < 8 * 24 * 60 * 60_000) {
    const days = Math.floor(diff / (24 * 60 * 60_000));
    const hours = Math.floor((diff % (24 * 60 * 60_000)) / (60 * 60_000));
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" })
    .format(new Date(resetsAt));
};

export function UsageQuotasBlock({
  showAllWindows = false,
  warningThreshold = .8,
}: {
  showAllWindows?: boolean;
  warningThreshold?: number;
}) {
  const { snapshots, loading, error } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visibleSnapshots = useMemo(
    () => snapshots.filter((snapshot) => !prefs.hiddenProviders.includes(snapshot.providerId)),
    [prefs.hiddenProviders, snapshots],
  );
  const rows = useMemo(() => visibleSnapshots
    .flatMap((snapshot) => snapshot.windows.map((window) => ({
      providerId: snapshot.providerId,
      window,
      stale: snapshot.stale,
      ratio: window.limit > 0 ? Math.max(0, window.used / window.limit) : 0,
    })))
    .sort((left, right) => right.ratio - left.ratio || (left.window.resetsAt ?? Number.POSITIVE_INFINITY) - (right.window.resetsAt ?? Number.POSITIVE_INFINITY)), [visibleSnapshots]);
  const visible = showAllWindows
    ? rows
    : rows.filter((row, index, all) =>
        all.findIndex((candidate) => candidate.providerId === row.providerId) === index);
  return (
    <Block title="Provider quotas" meta={rows.some((row) => row.ratio >= warningThreshold) ? "Needs attention" : "Current limits"}>
      <AnalyticsState loading={loading} error={error} empty={rows.length === 0}>
        <div className="usage-quota-compact-list">
          {visible.slice(0, showAllWindows ? 12 : 8).map((row) => (
            <div className="usage-quota-compact-row" key={`${row.providerId}:${row.window.id}`}>
              <ProviderLogo providerID={row.providerId} className="usage-analytics-provider-logo" />
              <span className="usage-quota-name">
                <strong>{row.providerId}</strong>
                {showAllWindows && <small>{row.window.label}</small>}
              </span>
              <div className="usage-quota-track">
                <i style={{ width: `${Math.min(100, row.ratio * 100)}%` }} />
              </div>
              <strong className={row.ratio >= warningThreshold ? "warn" : undefined}>
                {percent(row.ratio)}
              </strong>
              <span className="usage-quota-reset">{row.window.resetsAt === undefined ? "—" : quotaReset(row.window.resetsAt)}</span>
            </div>
          ))}
        </div>
      </AnalyticsState>
    </Block>
  );
}

export type UsageAnalyticsWidgetKind =
  | "summary"
  | "quotas"
  | "throughput"
  | "ttft"
  | "spend-trend"
  | "performance"
  | "what-changed"
  | "subscription-value"
  | "model-efficiency"
  | "breakdown"
  | "reliability"
  | "cache-efficiency";

export function rangeFromPreset(
  preset: unknown,
  now = Date.now(),
): UsageAnalyticsRange {
  const durationMs = preset === "1h"
    ? 60 * 60_000
    : preset === "24h"
      ? 24 * 60 * 60_000
      : preset === "30d"
        ? 30 * 24 * 60 * 60_000
        : preset === "90d"
          ? 90 * 24 * 60 * 60_000
          : 7 * 24 * 60 * 60_000;
  return { from: now - durationMs, to: now };
}

export const scopeFromWidget = (
  config: Readonly<Record<string, unknown>>,
  projectId: string | null,
): UsageAnalyticsScope => ({
  range: rangeFromPreset(config.range),
  ...(config.projectScope === "current" && projectId ? { projectId } : {}),
  ...(typeof config.providerId === "string" && config.providerId ? { providerId: config.providerId } : {}),
});

export function UsageAnalyticsWidgetView({
  kind,
  scope,
  config,
}: {
  kind: UsageAnalyticsWidgetKind;
  scope: UsageAnalyticsScope;
  config: Readonly<Record<string, unknown>>;
}) {
  const groupBy = config.groupBy === "model" || config.groupBy === "harness" || config.groupBy === "project"
    ? config.groupBy
    : "provider";
  const aggregation = config.aggregation === "average" || config.aggregation === "p95"
    ? config.aggregation
    : "p50";
  switch (kind) {
    case "summary":
      return <UsageSummaryBlock scope={scope} metrics={Array.isArray(config.metrics) ? config.metrics as UsageMetricId[] : undefined} />;
    case "quotas":
      return <UsageQuotasBlock showAllWindows={config.showAllWindows === true} />;
    case "throughput":
      return <UsageThroughputBlock scope={scope} groupBy={groupBy} aggregation={aggregation} />;
    case "ttft":
      return <UsageTtftBlock scope={scope} groupBy={groupBy} aggregation={aggregation} />;
    case "spend-trend":
      return <UsageSpendTrendBlock scope={scope} groupBy={groupBy} />;
    case "performance":
      return <UsagePerformanceBlock scope={scope} />;
    case "what-changed":
      return <UsageWhatChangedBlock scope={scope} />;
    case "subscription-value":
      return <UsageSubscriptionValueBlock providerId={typeof config.providerId === "string" ? config.providerId : undefined} projectId={scope.projectId} />;
    case "model-efficiency":
      return <UsageModelEfficiencyBlock scope={scope} />;
    case "breakdown":
      return <UsageBreakdownBlock
        scope={scope}
        groupBy={groupBy}
        metric={config.metric === "tokens" || config.metric === "output" || config.metric === "sessions" || config.metric === "requests"
          ? config.metric
          : "cost"}
      />;
    case "reliability":
      return <UsageReliabilityBlock scope={scope} />;
    case "cache-efficiency":
      return <UsageCacheEfficiencyBlock scope={scope} />;
  }
}
