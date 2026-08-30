import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fmtTokens } from "../../../../apps/web/src/format.ts";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { Icon } from "../../../../apps/web/src/icons.tsx";
import { useStore } from "../../../../apps/web/src/store.ts";
import {
  setProviderHidden,
  setUsageDashboardPrefs,
  useUsagePrefs,
} from "../usagePrefs.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import { fmtQuota, paceText, useQuotaSnapshots } from "./quotaUi.tsx";
import {
  AddIcon,
  Button,
  ChevronRightIcon,
  EmptyState,
  IconButton,
  RefreshIcon,
  Tabs,
} from "../../../../apps/web/src/components/ui/index.ts";
import {
  buildUsageDashboardData,
  type UsageChartMetric,
  type UsageChartSeries,
  type UsageModelSummary,
  type UsageProviderSummary,
  type UsageRangeDays,
  type UsageTrend,
} from "./dashboardData.ts";

type IconName = keyof typeof Icon;

const SERIES_ACCENTS = [
  "var(--accent)",
  "var(--green)",
  "var(--blue)",
  "var(--purple)",
  "var(--amber)",
] as const;

const cssVar = (name: string, value: string): CSSProperties =>
  ({ [name]: value }) as CSSProperties;

const seriesAccent = (index = 0): string =>
  SERIES_ACCENTS[index % SERIES_ACCENTS.length]!;

const providerPreferenceId = (provider: UsageProviderSummary): string =>
  provider.snapshot?.providerId ?? provider.id;

const formatMoney = (value: number): string => {
  if (value > 0 && value < .0001) return "<$0.0001";
  return new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
};

const formatRate = (value: number): string =>
  value > 0 && value < .0001 ? "<$0.0001" : `$${value.toFixed(4)}`;

const formatChartMoney = (value: number): string => {
  if (value === 0) return "$0";
  const fractionDigits = value < .001 ? 5 : value < 1 ? 4 : 2;
  return new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value);
};

const aggregateSeries = (series: readonly UsageChartSeries[], points: number): number[] =>
  Array.from({ length: points }, (_, point) =>
    series.reduce((total, item) => total + (item.values[point] ?? 0), 0));

const collapseChartSeries = (
  series: readonly UsageChartSeries[],
  maximumSeries = SERIES_ACCENTS.length,
): UsageChartSeries[] => {
  if (series.length <= maximumSeries) return [...series];
  const featured = series.slice(0, maximumSeries - 1);
  const remainder = series.slice(maximumSeries - 1);
  return [
    ...featured,
    {
      providerId: "__other__",
      label: tr("usage.usagedashboard.otherValue", { count: remainder.length }),
      values: aggregateSeries(remainder, series[0]?.values.length ?? 0),
    },
  ];
};

function TrendBadge({ trend, compact = false }: { trend: UsageTrend | null; compact?: boolean }) {
  if (!trend) {
    return (
      <span className={`usage-trend usage-trend-none${compact ? " compact" : ""}`}>
        <span className="sr-only">{tr("usage.usagedashboard.noPriorData")}</span>
        <span aria-hidden="true">{compact ? "—" : tr("usage.usagedashboard.noPriorData")}</span>
      </span>
    );
  }
  const rounded = Math.round(Math.abs(trend.percent));
  const direction = trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→";
  const accessibleLabel = trend.direction === "flat"
    ? tr("usage.usagedashboard.noChangeFromThePreviousRange")
    : trend.direction === "up"
      ? tr("usage.usagedashboard.valuePercentIncreaseFromThe", { percent: rounded })
      : tr("usage.usagedashboard.valuePercentDecreaseFromThe", { percent: rounded });
  return (
    <span className={`usage-trend usage-trend-${trend.direction}${compact ? " compact" : ""}`}>
      <span className="sr-only">{accessibleLabel}</span>
      <span aria-hidden="true">
        {direction} {trend.direction === "flat" ? "0%" : `${rounded}%`}
        {!compact && ` ${tr("usage.usagedashboard.vsPriorRange")}`}
      </span>
    </span>
  );
}

function MiniCohortBars({ values, tone }: { values: readonly number[]; tone: string }) {
  const width = 112;
  const height = 32;
  const maximum = Math.max(1, ...values);
  const slotWidth = values.length > 0 ? width / values.length : width;
  const barWidth = Math.max(2, slotWidth * .58);
  return (
    <svg
      className="usage-stat-cohorts"
      style={cssVar("--spark-tone", tone)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {values.map((value, index) => {
        const barHeight = value / maximum * (height - 3);
        return (
          <rect
            key={index}
            x={index * slotWidth + (slotWidth - barWidth) / 2}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx="1"
          />
        );
      })}
    </svg>
  );
}

function StatCard({
  label,
  value,
  trend,
  icon,
  tone,
  detail,
  series,
}: {
  label: string;
  value: string;
  trend: UsageTrend | null;
  icon: IconName;
  tone: string;
  detail: string;
  series: readonly number[];
}) {
  const Glyph = Icon[icon];
  return (
    <article className="usage-stat-card" style={cssVar("--stat-tone", tone)}>
      <div className="usage-stat-card-top">
        <span className="usage-stat-icon"><Glyph /></span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <div className="usage-stat-foot">
        <TrendBadge trend={trend} />
        <span>{detail}</span>
      </div>
      <MiniCohortBars values={series} tone={tone} />
    </article>
  );
}

function SectionHeading({
  title,
  description,
  aside,
}: {
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <header className="usage-card-heading">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {aside}
    </header>
  );
}

function CohortChart({
  labels,
  series,
  metric,
  emptyTitle,
  emptyText,
}: {
  labels: string[];
  series: UsageChartSeries[];
  metric: UsageChartMetric;
  emptyTitle: string;
  emptyText: string;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartSize, setChartSize] = useState({ width: 720, height: 236 });
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const updateSize = () => {
      const bounds = element.getBoundingClientRect();
      const next = {
        width: Math.max(280, Math.round(bounds.width)),
        height: Math.max(170, Math.round(bounds.height)),
      };
      setChartSize((current) =>
        current.width === next.width && current.height === next.height ? current : next);
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { width, height } = chartSize;
  const top = 12;
  const bottom = 32;
  const left = 54;
  const right = 8;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const allValues = series.flatMap((item) => item.values);
  const bucketTotals = aggregateSeries(series, labels.length);
  const maximum = Math.max(1, ...bucketTotals);
  const bucketWidth = labels.length > 0 ? chartWidth / labels.length : chartWidth;
  const barWidth = Math.min(42, Math.max(10, bucketWidth * .62));
  const barX = (index: number) => left + bucketWidth * index + (bucketWidth - barWidth) / 2;
  const pointY = (value: number) => top + chartHeight - value / maximum * chartHeight;
  const populated = allValues.some((value) => value > 0);
  const metricLabel = metric === "cost" ? tr("usage.usagedashboard.cost") : metric === "tokens" ? tr("usage.usagedashboard.tokens") : tr("usage.usagedashboard.sessions");
  const formatAxis = (value: number) => metric === "cost"
    ? formatChartMoney(value)
    : metric === "tokens"
      ? fmtTokens(Math.round(value))
      : String(Math.round(value));
  const maximumLabelCount = Math.min(6, Math.max(2, Math.floor(chartWidth / 88)));
  const renderedLabelCount = Math.min(labels.length, maximumLabelCount);
  const visibleLabelIndexes = new Set(
    renderedLabelCount <= 1
      ? [0]
      : Array.from(
          { length: renderedLabelCount },
          (_, index) => Math.round(index * (labels.length - 1) / (renderedLabelCount - 1)),
        ),
  );

  return (
    <div className="usage-cohort-chart" ref={chartRef}>
      {populated && (
        <svg viewBox={`0 0 ${width} ${height}`} role="img">
          <title>{tr("usage.usagedashboard.valueFromFullSessionTotals", { metric: metricLabel })}</title>
          <desc>
            {tr("usage.usagedashboard.eachSessionAppearsOnceInThe", { metric: metricLabel.toLowerCase() })}
          </desc>
          {[0, .25, .5, .75, 1].map((fraction) => {
            const y = top + chartHeight * fraction;
            const value = maximum * (1 - fraction);
            return (
              <g key={fraction}>
                <line className="usage-chart-gridline" x1={left} x2={width - right} y1={y} y2={y} />
                <text className="usage-chart-y-label" x={left - 9} y={y + 3} textAnchor="end">
                  {formatAxis(value)}
                </text>
              </g>
            );
          })}
          {labels.map((label, pointIndex) => {
            let stackedValue = 0;
            return series.map((item, seriesIndex) => {
              const value = item.values[pointIndex] ?? 0;
              const bottomValue = stackedValue;
              stackedValue += value;
              if (value <= 0) return null;
              const y = pointY(stackedValue);
              return (
                <rect
                  key={`${item.providerId}-${pointIndex}`}
                  className="usage-chart-bar"
                  x={barX(pointIndex)}
                  y={y}
                  width={barWidth}
                  height={Math.max(1, pointY(bottomValue) - y)}
                  rx="2"
                  fill={seriesAccent(seriesIndex)}
                >
                  <title>{tr("usage.usagedashboard.valueValueFromSessionsWith", { label: item.label, value: formatAxis(value), bucket: label })}</title>
                </rect>
              );
            });
          })}
          {labels.map((label, index) => {
            if (!visibleLabelIndexes.has(index)) return null;
            const first = index === 0;
            const last = index === labels.length - 1;
            return (
              <text
                className="usage-chart-x-label"
                key={`${label}-${index}`}
                x={first ? left : last ? width - right : barX(index) + barWidth / 2}
                y={height - 5}
                textAnchor={first ? "start" : last ? "end" : "middle"}
              >
                {label}
              </text>
            );
          })}
        </svg>
      )}
      {populated && (
        <table className="sr-only">
          <caption>{tr("usage.usagedashboard.valueFromFullSessionTotalsBy", { metric: metricLabel })}</caption>
          <thead>
            <tr>
              <th scope="col">{tr("usage.usagedashboard.provider")}</th>
              {labels.map((label, index) => <th scope="col" key={`${label}-${index}`}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {series.map((item) => (
              <tr key={item.providerId}>
                <th scope="row">{item.label}</th>
                {item.values.map((value, index) => (
                  <td key={index}>{formatAxis(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!populated && (
        <div className="usage-chart-empty" role="status">
          <span><Icon.usage /></span>
          <strong>{emptyTitle}</strong>
          <small>{emptyText}</small>
        </div>
      )}
    </div>
  );
}

function SessionCohorts({
  data,
  visibleProviderIds,
  hiddenCount,
}: {
  data: ReturnType<typeof buildUsageDashboardData>;
  visibleProviderIds: ReadonlySet<string>;
  hiddenCount: number;
}) {
  const [metric, setMetric] = useState<UsageChartMetric>("tokens");
  const visibleSeries = data.chart[metric].filter((item) => visibleProviderIds.has(item.providerId));
  const series = collapseChartSeries(visibleSeries);
  const hiddenActivity = hiddenCount > 0 && data.chart[metric].some(
    (item) => !visibleProviderIds.has(item.providerId) && item.values.some((value) => value > 0),
  );
  return (
    <article className="usage-dashboard-card usage-time-card">
      <SectionHeading
        title={tr("usage.usagedashboard.sessionCohortsByLatestTurn")}
        description={tr("usage.usagedashboard.valueEqualRollingBucketsValue", { count: data.chart.labels.length, hours: Math.round(data.chart.bucketHours) })}
        aside={(
          <Tabs
            className="usage-metric-toggle"
            size="sm"
            label={tr("usage.usagedashboard.chartMetric")}
            value={metric}
            tabs={(["tokens", "cost", "sessions"] as const).map((item) => ({
              id: item,
              label: item === "tokens" ? tr("usage.usagedashboard.tokens") : item === "cost" ? tr("usage.usagedashboard.cost") : tr("usage.usagedashboard.sessions"),
            }))}
            onChange={(value) => setMetric(value as UsageChartMetric)}
          />
        )}
      />
      <CohortChart
        labels={data.chart.labels}
        series={series}
        metric={metric}
        emptyTitle={hiddenActivity ? tr("usage.usagedashboard.allActivityIsHidden") : tr("usage.usagedashboard.noSessionsLastActiveIn")}
        emptyText={hiddenActivity
          ? tr("usage.usagedashboard.showAProviderToIncludeIts")
          : tr("usage.usagedashboard.cohortsFillInAsSessions")}
      />
      <p className="usage-chart-method">
        {tr("usage.usagedashboard.eachSessionAppearsOnceInBucket")}
      </p>
      <div className="usage-chart-legend">
        {series.map((item, index) => (
          <span key={item.providerId}>
            <i style={{ background: seriesAccent(index) }} />
            {item.providerId === "__other__"
              ? <span className="usage-other-provider" aria-hidden="true">+</span>
              : <ProviderLogo providerID={item.providerId} providerName={item.label} className="usage-legend-logo" />}
            {item.label}
          </span>
        ))}
      </div>
    </article>
  );
}

interface SpendEntry {
  id: string;
  label: string;
  cost: number;
  providerId?: string;
}

function ProviderSpendDonut({
  providers,
  onViewProviders,
  hiddenSpend,
}: {
  providers: UsageProviderSummary[];
  onViewProviders: () => void;
  hiddenSpend: boolean;
}) {
  const withSpend = providers.filter((provider) => provider.cost > 0);
  const total = withSpend.reduce((sum, provider) => sum + provider.cost, 0);
  const featured: SpendEntry[] = withSpend.slice(0, 4).map((provider) => ({
    id: provider.id,
    label: provider.label,
    cost: provider.cost,
    providerId: provider.id,
  }));
  const otherCost = withSpend.slice(4).reduce((sum, provider) => sum + provider.cost, 0);
  if (otherCost > 0) featured.push({ id: "other", label: tr("usage.usagedashboard.other"), cost: otherCost });
  let offset = 0;
  const arcs = featured.map((entry, index) => {
    const share = total > 0 ? entry.cost / total : 0;
    const start = offset;
    offset += share * 100;
    return { entry, share, offset: start, accent: seriesAccent(index) };
  });

  return (
    <article className="usage-dashboard-card usage-spend-card">
      <SectionHeading
        title={tr("usage.usagedashboard.costByProvider")}
        description={tr("usage.usagedashboard.whereWorkspaceSpendIsGoing")}
        aside={<IconButton icon={ChevronRightIcon} label={tr("usage.usagedashboard.viewProviderDetails")} onClick={onViewProviders} />}
      />
      <div className="usage-spend-content">
        <div className="usage-spend-donut" role="img" aria-label={tr("usage.usagedashboard.providerSpendTotalingValue", { total: formatMoney(total) })}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle className="usage-spend-track" cx="60" cy="60" r="45" pathLength="100" />
            {arcs.map(({ entry, share, offset: arcOffset, accent }) => (
              <circle
                className="usage-spend-arc"
                key={entry.id}
                cx="60"
                cy="60"
                r="45"
                pathLength="100"
                stroke={accent}
                strokeDasharray={`${share * 100} ${100 - share * 100}`}
                strokeDashoffset={-arcOffset}
              />
            ))}
          </svg>
          <div><span>{tr("usage.usagedashboard.totalSpend")}</span><strong>{formatMoney(total)}</strong></div>
        </div>
        <div className="usage-spend-legend">
          {arcs.map(({ entry, share, accent }) => (
            <div key={entry.id}>
              {entry.providerId
                ? <ProviderLogo providerID={entry.providerId} providerName={entry.label} className="usage-legend-logo" />
                : <span className="usage-other-provider" aria-hidden="true">+</span>}
              <i style={{ background: accent }} />
              <span>{entry.label}</span>
              <strong>{formatMoney(entry.cost)}</strong>
              <small>{Math.round(share * 100)}%</small>
            </div>
          ))}
          {arcs.length === 0 && (
            <EmptyState
              variant="compact"
              title={hiddenSpend ? tr("usage.usagedashboard.allSpendIsHidden") : tr("usage.usagedashboard.noSpendRecorded")}
              description={hiddenSpend
                ? tr("usage.usagedashboard.showAProviderToIncludeSpend")
                : tr("usage.usagedashboard.costAppearsWhenTheActive")}
            />
          )}
        </div>
      </div>
    </article>
  );
}

function ModelBreakdown({
  models,
  hiddenActivity,
}: {
  models: UsageModelSummary[];
  hiddenActivity: boolean;
}) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const shown = models.slice(0, 6);
  const maximum = Math.max(1, ...shown.map((model) => model[metric]));
  return (
    <article className="usage-dashboard-card usage-model-card">
      <SectionHeading
        title={tr("usage.usagedashboard.modelBreakdown")}
        description={tr("usage.usagedashboard.highestUseModelsAmongSessions")}
        aside={(
          <Tabs
            className="usage-metric-toggle"
            size="sm"
            label={tr("usage.usagedashboard.modelBreakdownMetric")}
            value={metric}
            tabs={(["tokens", "cost"] as const).map((item) => ({
              id: item,
              label: item === "tokens" ? tr("usage.usagedashboard.tokens") : tr("usage.usagedashboard.cost"),
            }))}
            onChange={(value) => setMetric(value as typeof metric)}
          />
        )}
      />
      <div className="usage-model-list">
        {shown.map((model, index) => (
          <div className="usage-model-row" key={model.id}>
            <ProviderLogo providerID={model.providerId} providerName={model.providerLabel} className="usage-model-logo" />
            <span className="usage-model-copy">
              <strong title={model.label}>{model.label}</strong>
              <small>{model.providerLabel} · {model.sessions === 1 ? tr("usage.usagedashboard.oneSession") : tr("usage.usagedashboard.valueSessions", { count: model.sessions })}</small>
            </span>
            <span className="usage-model-value">{metric === "tokens" ? fmtTokens(model.tokens) : formatMoney(model.cost)}</span>
            <span className="usage-model-track">
              <i style={{ width: `${model[metric] / maximum * 100}%`, background: seriesAccent(index) }} />
            </span>
          </div>
        ))}
        {shown.length === 0 && (
          <EmptyState
            variant="compact"
            title={hiddenActivity ? tr("usage.usagedashboard.allModelActivityIsHidden") : tr("usage.usagedashboard.noModelActivityYet")}
            description={hiddenActivity
              ? tr("usage.usagedashboard.showAProviderToIncludeModels")
              : tr("usage.usagedashboard.modelsAppearAfterASession")}
          />
        )}
      </div>
    </article>
  );
}

function CostPulse({ data }: { data: ReturnType<typeof buildUsageDashboardData> }) {
  const averageSession = data.totals.sessions > 0 ? data.totals.cost / data.totals.sessions : 0;
  return (
    <article className="usage-dashboard-card usage-cost-card">
      <SectionHeading title={tr("usage.usagedashboard.costContext")} description={tr("usage.usagedashboard.recordedTotalsForSessionsActive")} />
      <div className="usage-cost-total">
        <span>{tr("usage.usagedashboard.fullRecordedSessionSpend")}</span>
        <strong>{formatMoney(data.totals.cost)}</strong>
        <TrendBadge trend={data.trends.cost} />
      </div>
      <div className="usage-cost-grid">
        <div><span>{tr("usage.usagedashboard.sessionsCounted")}</span><strong>{data.totals.sessions.toLocaleString(getLocale())}</strong></div>
        <div><span>{tr("usage.usagedashboard.selectedRange")}</span><strong>{tr("usage.usagedashboard.valueDays", { count: data.rangeDays })}</strong></div>
        <div><span>{tr("usage.usagedashboard.perSession")}</span><strong>{formatMoney(averageSession)}</strong></div>
        <div><span>{tr("usage.usagedashboard.per1kTokens")}</span><strong>{formatRate(data.totals.averageCostPerThousand)}</strong></div>
      </div>
      <p>{tr("usage.usagedashboard.sessionsAreSelectedByLatest")}</p>
    </article>
  );
}

function ProviderStatus({ provider }: { provider: UsageProviderSummary }) {
  const state = !provider.snapshot ? "session-only" : provider.stale ? "stale" : "fresh";
  const label = state === "session-only" ? tr("usage.usagedashboard.sessionOnly") : state === "stale" ? tr("usage.usagedashboard.stale") : tr("usage.usagedashboard.fresh");
  const error = state === "stale" ? provider.snapshot?.error?.message : undefined;
  return (
    <span
      className={`usage-status-pill ${state}`}
      title={error}
    >
      <i aria-hidden="true" />{label}
      {error && <span className="sr-only"> {tr("usage.usagedashboard.quotaFeedValue", { error: error })}</span>}
    </span>
  );
}

function ProviderTable({
  providers,
  allProvidersHidden,
}: {
  providers: UsageProviderSummary[];
  allProvidersHidden: boolean;
}) {
  return (
    <article className="usage-dashboard-card usage-providers-card">
      <SectionHeading
        title={tr("usage.usagedashboard.providerActivity")}
        description={tr("usage.usagedashboard.sessionTotalsAndQuotaFeed")}
        aside={<span className="usage-source-badge">{tr("usage.usagedashboard.projectScoped")}</span>}
      />
      <div className="usage-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{tr("usage.usagedashboard.provider")}</th>
              <th scope="col">{tr("usage.usagedashboard.spend")}</th>
              <th scope="col">{tr("usage.usagedashboard.tokens")}</th>
              <th scope="col">{tr("usage.usagedashboard.sessions")}</th>
              <th scope="col">{tr("usage.usagedashboard.remainingLimit")}</th>
              <th scope="col">{tr("usage.usagedashboard.status")}</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td data-label={tr("usage.usagedashboard.provider")}>
                  <span className="usage-provider-cell">
                    <ProviderLogo
                      providerID={provider.id}
                      providerName={provider.label}
                      className="usage-provider-mark usage-provider-mark-regular"
                    />
                    <span><strong>{provider.label}</strong><small>{provider.id}</small></span>
                  </span>
                </td>
                <td data-label={tr("usage.usagedashboard.spend")}><strong>{formatMoney(provider.cost)}</strong><TrendBadge trend={provider.trends.cost} compact /></td>
                <td data-label={tr("usage.usagedashboard.tokens")}><strong>{fmtTokens(provider.tokens)}</strong><TrendBadge trend={provider.trends.tokens} compact /></td>
                <td data-label={tr("usage.usagedashboard.sessions")}><strong>{provider.sessions.toLocaleString(getLocale())}</strong><TrendBadge trend={provider.trends.sessions} compact /></td>
                <td data-label={tr("usage.usagedashboard.remainingLimit")}>
                  {provider.remainingPercent === null ? (
                    <span className="usage-limit-unavailable">{tr("usage.usagedashboard.notAvailable")}</span>
                  ) : (
                    <div className="usage-limit-cell">
                      <div><span>{provider.remainingPercent}%</span><small>{provider.quotaWindow?.label}</small></div>
                      <span
                        className="usage-limit-track"
                        role="progressbar"
                        aria-label={tr("usage.usagedashboard.valueQuotaRemaining", { label: provider.label })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={provider.remainingPercent}
                      >
                        <i
                          className={provider.remainingPercent < 20 ? "critical" : provider.remainingPercent < 40 ? "warning" : ""}
                          style={{ width: `${provider.remainingPercent}%` }}
                        />
                      </span>
                    </div>
                  )}
                </td>
                <td data-label={tr("usage.usagedashboard.status")}>
                  <ProviderStatus provider={provider} />
                </td>
              </tr>
            ))}
            {providers.length === 0 && (
              <tr className="usage-provider-empty-row">
                <td colSpan={6}>{allProvidersHidden
                  ? tr("usage.usagedashboard.allProvidersAreHiddenFrom")
                  : tr("usage.usagedashboard.noSessionsLastActiveInThis")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function UsageActionStrip({
  hiddenCount,
  onProviders,
  onAddProvider,
}: {
  hiddenCount: number;
  onProviders: () => void;
  onAddProvider: () => void;
}) {
  return (
    <section className="usage-action-strip">
      <span className="usage-action-icon"><Icon.sliders /></span>
      <div>
        <strong>{tr("usage.usagedashboard.shapeThisDashboard")}</strong>
        <span>{hiddenCount > 0
          ? (hiddenCount === 1 ? tr("usage.usagedashboard.oneProviderIsHiddenFrom") : tr("usage.usagedashboard.valueProvidersAreHiddenFrom", { count: hiddenCount }))
          : tr("usage.usagedashboard.allDiscoveredProvidersAreIncluded")}</span>
      </div>
      <Button size="sm" onClick={onProviders}>{tr("usage.usagedashboard.providerVisibility")}</Button>
      <Button size="sm" iconStart={AddIcon} onClick={onAddProvider}>{tr("usage.usagedashboard.addProvider")}</Button>
    </section>
  );
}

function ProviderDetails({
  providers,
  hiddenProviders,
  onAddProvider,
  onRefresh,
  quotaBusy,
}: {
  providers: UsageProviderSummary[];
  hiddenProviders: string[];
  onAddProvider: () => void;
  onRefresh: (providerId: string) => void | Promise<void>;
  quotaBusy: boolean;
}) {
  return (
    <div className="usage-provider-view" data-settings-item="usage.providers">
      <div className="usage-provider-detail-grid">
        {providers.map((provider, index) => {
          const preferenceId = providerPreferenceId(provider);
          const hidden = hiddenProviders.includes(preferenceId);
          return (
            <article className="usage-provider-detail-card" key={provider.id} style={cssVar("--provider-accent", seriesAccent(index))}>
              <header>
                <ProviderLogo
                  providerID={provider.id}
                  providerName={provider.label}
                  className="usage-provider-mark usage-provider-mark-large"
                />
                <div>
                  <h3>{provider.label}</h3>
                  <p title={provider.snapshot?.accountLabel ?? provider.id}>{provider.snapshot?.accountLabel ?? provider.id}</p>
                </div>
                <ProviderStatus provider={provider} />
              </header>
              {provider.stale && provider.snapshot?.error?.message && (
                <div className="usage-provider-error" role="status">
                  <Icon.usage />
                  <span>{provider.snapshot.error.message}</span>
                </div>
              )}
              <div className="usage-provider-detail-stats">
                <div><span>{tr("usage.usagedashboard.spend")}</span><strong>{formatMoney(provider.cost)}</strong></div>
                <div><span>{tr("usage.usagedashboard.tokens")}</span><strong>{fmtTokens(provider.tokens)}</strong></div>
                <div><span>{tr("usage.usagedashboard.sessions")}</span><strong>{provider.sessions.toLocaleString(getLocale())}</strong></div>
              </div>
              <div className="usage-provider-windows">
                {provider.snapshot?.windows.map((quota) => {
                  const used = quota.limit > 0 ? Math.min(1, quota.used / quota.limit) : 0;
                  const pace = provider.snapshot?.pace[quota.id] ?? null;
                  return (
                    <div key={quota.id} className="usage-provider-window">
                      <div>
                        <span title={quota.label}>{quota.label}</span>
                        <strong>{fmtQuota(quota.used, quota.unit)} <small>/ {fmtQuota(quota.limit, quota.unit)}</small></strong>
                      </div>
                      <span
                        className="usage-provider-window-track"
                        role="progressbar"
                        aria-label={tr("usage.usagedashboard.valueValueUsed", { label: provider.label, window: quota.label })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(used * 100)}
                      >
                        <i className={used >= .8 ? "warning" : ""} style={{ width: `${used * 100}%` }} />
                      </span>
                      <p>{pace ? paceText(pace, quota) : quota.resetsAt ? tr("usage.usagedashboard.resetsValue", { date: new Date(quota.resetsAt).toLocaleString(getLocale()) }) : tr("usage.usagedashboard.liveQuotaUsage")}</p>
                    </div>
                  );
                })}
                {!provider.snapshot?.windows.length && (
                  <div className="usage-provider-no-quota">
                    <Icon.usage />
                    <span><strong>{tr("usage.usagedashboard.noQuotaFeed")}</strong><small>{tr("usage.usagedashboard.sessionTotalsAreAvailableThis")}</small></span>
                  </div>
                )}
              </div>
              <footer>
                <Button
                  size="sm"
                  aria-label={hidden ? tr("usage.usagedashboard.showValueInBreakdowns", { label: provider.label }) : tr("usage.usagedashboard.hideValueInBreakdowns", { label: provider.label })}
                  onClick={() => setProviderHidden(preferenceId, !hidden)}
                >
                  {hidden ? tr("usage.usagedashboard.showInBreakdowns") : tr("usage.usagedashboard.hideFromBreakdowns")}
                </Button>
                {provider.snapshot && (
                  <Button
                    size="sm"
                    iconStart={RefreshIcon}
                    busy={quotaBusy}
                    aria-label={tr("usage.usagedashboard.refreshValueQuotaFeed", { label: provider.label })}
                    onClick={() => void onRefresh(provider.snapshot!.providerId)}
                  >
                    {tr("common.refresh")}
                  </Button>
                )}
              </footer>
            </article>
          );
        })}
        {providers.length === 0 && (
          <EmptyState
            variant="panel"
            title={tr("usage.usagedashboard.connectYourFirstProvider")}
            description={tr("usage.usagedashboard.polythDiscoversQuotaSources")}
            actionLabel={tr("usage.usagedashboard.openProviderSettings")}
            onAction={onAddProvider}
          />
        )}
      </div>
      <section className="usage-provider-view-intro">
        <div><span>{tr("usage.usagedashboard.discovered")}</span><strong>{providers.length}</strong></div>
        <div><span>{tr("usage.usagedashboard.freshFeeds")}</span><strong>{providers.filter((provider) => provider.snapshot && !provider.stale).length}</strong></div>
        <div><span>{tr("usage.usagedashboard.visible")}</span><strong>{providers.filter((provider) => !hiddenProviders.includes(providerPreferenceId(provider))).length}</strong></div>
        <Button size="sm" variant="primary" iconStart={AddIcon} onClick={onAddProvider}>{tr("usage.usagedashboard.addProvider")}</Button>
      </section>
    </div>
  );
}

export function UsageDashboard(): ReactNode {
  const sessions = useStore((state) => state.sessions);
  const projectId = useStore((state) => state.activeProjectId);
  const projectSessions = sessions.filter((session) => session.projectId === projectId);
  const {
    snapshots,
    reload,
    refresh,
    refreshAll: refreshQuotaFeeds,
    loading: quotaLoading,
    error: quotaError,
  } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const { view, layout, rangeDays } = prefs.dashboard;
  const dashboardRef = useRef<HTMLDivElement>(null);
  const setView = (next: "overview" | "providers") =>
    setUsageDashboardPrefs({ view: next });
  const setLayout = (next: "expanded" | "compact") =>
    setUsageDashboardPrefs({ layout: next });
  const setRangeDays = (next: UsageRangeDays) =>
    setUsageDashboardPrefs({ rangeDays: next });
  useEffect(() => {
    const pane = dashboardRef.current?.closest<HTMLElement>(".settings-pane-body");
    if (pane) pane.scrollTop = 0;
  }, [view]);
  const [refreshing, setRefreshing] = useState(false);
  const data = useMemo(
    () => buildUsageDashboardData(projectSessions, snapshots, rangeDays),
    [projectSessions, rangeDays, snapshots],
  );
  const visibleProviders = data.providers.filter(
    (provider) => !prefs.hiddenProviders.includes(providerPreferenceId(provider)),
  );
  const visibleProviderIds = new Set(visibleProviders.map((provider) => provider.id));
  const hiddenCount = data.providers.length - visibleProviders.length;
  const allProvidersHidden = data.providers.length > 0 && visibleProviders.length === 0;
  const tokenSeries = aggregateSeries(data.chart.tokens, data.chart.labels.length);
  const costSeries = aggregateSeries(data.chart.cost, data.chart.labels.length);
  const sessionSeries = aggregateSeries(data.chart.sessions, data.chart.labels.length);
  const averageSeries = costSeries.map((cost, index) => {
    const tokens = tokenSeries[index] ?? 0;
    return tokens > 0 ? cost / tokens * 1_000 : 0;
  });
  const averageSessionCost = data.totals.sessions > 0 ? data.totals.cost / data.totals.sessions : 0;
  const addProvider = () => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "models" }));
  const refreshAll = async () => {
    if (refreshing || quotaLoading) return;
    setRefreshing(true);
    try {
      await refreshQuotaFeeds();
    } finally {
      setRefreshing(false);
    }
  };
  const quotaBusy = quotaLoading || refreshing;

  return (
    <div
      className={`usage-dashboard usage-layout-${layout}`}
      data-settings-item="usage.dashboard"
      aria-busy={quotaBusy}
      ref={dashboardRef}
    >
      <div className="usage-dashboard-toolbar">
        <Tabs
          className="usage-view-tabs"
          size="sm"
          label={tr("usage.usagedashboard.usageView")}
          value={view}
          tabs={[
            { id: "overview", label: <><Icon.widgets /> {tr("usage.usagedashboard.overview")}</> },
            { id: "providers", label: <><Icon.list /> {tr("usage.usagedashboard.providers")}</> },
          ]}
          onChange={(value) => setView(value as typeof view)}
        />
        <span className="usage-toolbar-spacer" />
        <Tabs
          className="usage-range-control"
          size="sm"
          label={tr("usage.usagedashboard.usageRange")}
          value={String(rangeDays)}
          tabs={([7, 30, 90] as const).map((days) => ({ id: String(days), label: `${days}d` }))}
          onChange={(value) => setRangeDays(Number(value) as UsageRangeDays)}
        />
        <Tabs
          className="usage-layout-control"
          size="sm"
          label={tr("usage.usagedashboard.dashboardDensity")}
          value={layout}
          tabs={[
            { id: "expanded", label: <><Icon.widgets /><span>{tr("usage.usagedashboard.expanded")}</span></> },
            { id: "compact", label: <><Icon.list /><span>{tr("usage.usagedashboard.compact")}</span></> },
          ]}
          onChange={(value) => setLayout(value as typeof layout)}
        />
        <IconButton
          icon={RefreshIcon}
          className={quotaBusy ? "refreshing" : undefined}
          label={quotaBusy ? tr("usage.usagedashboard.refreshingProviderQuotaFeeds") : tr("usage.usagedashboard.refreshProviderQuotaFeeds")}
          title={quotaBusy ? tr("usage.usagedashboard.refreshingProviderQuotaFeeds") : tr("usage.usagedashboard.refreshProviderQuotaFeeds")}
          disabled={quotaBusy}
          onClick={() => void refreshAll()}
        />
      </div>

      {quotaError && (
        <div className="usage-quota-alert" role="alert">
          <Icon.usage />
          <span><strong>{tr("usage.usagedashboard.quotaFeedsCouldNotBe")}</strong> {tr("usage.usagedashboard.sessionTotalsRemainAvailable")} {quotaError}</span>
          <Button size="sm" busy={quotaBusy} onClick={() => void reload()}>{tr("common.retry")}</Button>
        </div>
      )}

      {view === "overview" ? (
        <div className="usage-dashboard-content">
          <section className="usage-stat-grid" aria-label={tr("usage.usagedashboard.usageSummary")}>
            <StatCard
              label={tr("usage.usagedashboard.spend")}
              value={formatMoney(data.totals.cost)}
              trend={data.trends.cost}
              icon="usage"
              tone="var(--accent)"
              detail={tr("usage.usagedashboard.valuePerSession2", { value: formatMoney(averageSessionCost) })}
              series={costSeries}
            />
            <StatCard
              label={tr("usage.usagedashboard.tokens")}
              value={fmtTokens(data.totals.tokens)}
              trend={data.trends.tokens}
              icon="context"
              tone="var(--purple)"
              detail={data.models.length === 1 ? tr("usage.usagedashboard.oneModel") : tr("usage.usagedashboard.valueModels", { count: data.models.length })}
              series={tokenSeries}
            />
            <StatCard
              label={tr("usage.usagedashboard.sessions")}
              value={data.totals.sessions.toLocaleString(getLocale())}
              trend={data.trends.sessions}
              icon="events"
              tone="var(--blue)"
              detail={visibleProviders.length === 1 ? tr("usage.usagedashboard.oneProviderShown") : tr("usage.usagedashboard.valueProvidersShown", { count: visibleProviders.length })}
              series={sessionSeries}
            />
            <StatCard
              label={tr("usage.usagedashboard.cost1kTokens")}
              value={data.totals.tokens > 0 ? formatRate(data.totals.averageCostPerThousand) : "$0.0000"}
              trend={data.trends.averageCostPerThousand}
              icon="compare"
              tone="var(--amber)"
              detail={tr("usage.usagedashboard.valueDayCohortRatio", { days: rangeDays })}
              series={averageSeries}
            />
          </section>

          <section className="usage-primary-grid">
            <SessionCohorts data={data} visibleProviderIds={visibleProviderIds} hiddenCount={hiddenCount} />
            <CostPulse data={data} />
          </section>

          <section className="usage-breakdown-grid">
            <ProviderSpendDonut
              providers={visibleProviders}
              hiddenSpend={data.providers.some((provider) =>
                !visibleProviderIds.has(provider.id) && provider.cost > 0)}
              onViewProviders={() => setView("providers")}
            />
            <ModelBreakdown
              models={data.models.filter((model) => visibleProviderIds.has(model.providerId))}
              hiddenActivity={data.models.some((model) => !visibleProviderIds.has(model.providerId))}
            />
          </section>

          <ProviderTable providers={visibleProviders} allProvidersHidden={allProvidersHidden} />
          <UsageActionStrip
            hiddenCount={hiddenCount}
            onProviders={() => setView("providers")}
            onAddProvider={addProvider}
          />
        </div>
      ) : (
        <div className="usage-dashboard-content">
          <ProviderDetails
            providers={data.providers}
            hiddenProviders={prefs.hiddenProviders}
            onAddProvider={addProvider}
            onRefresh={refresh}
            quotaBusy={quotaBusy}
          />
        </div>
      )}
    </div>
  );
}
