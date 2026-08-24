import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fmtTokens } from "../format.ts";
import { Icon } from "../icons.tsx";
import { useStore } from "../store.ts";
import {
  setProviderHidden,
  setUsageDashboardPrefs,
  useUsagePrefs,
} from "../usagePrefs.ts";
import ProviderLogo from "../components/ProviderLogo.tsx";
import { fmtQuota, paceText, useQuotaSnapshots } from "./quotaUi.tsx";
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
  return new Intl.NumberFormat("en-US", {
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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value);
};

const formatRange = (start: number, end: number): string => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const short = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const dated = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  return sameYear
    ? `${short.format(start)} – ${short.format(end)}, ${endDate.getFullYear()}`
    : `${dated.format(start)} – ${dated.format(end)}`;
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
      label: `Other (${remainder.length})`,
      values: aggregateSeries(remainder, series[0]?.values.length ?? 0),
    },
  ];
};

function TrendBadge({ trend, compact = false }: { trend: UsageTrend | null; compact?: boolean }) {
  if (!trend) {
    return (
      <span
        className={`usage-trend usage-trend-none${compact ? " compact" : ""}`}
        aria-label="No prior data"
      >
        <span aria-hidden="true">{compact ? "—" : "No prior data"}</span>
      </span>
    );
  }
  const rounded = Math.round(Math.abs(trend.percent));
  const direction = trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→";
  const accessibleLabel = trend.direction === "flat"
    ? "No change from the previous range"
    : `${rounded} percent ${trend.direction === "up" ? "increase" : "decrease"} from the previous range`;
  return (
    <span
      className={`usage-trend usage-trend-${trend.direction}${compact ? " compact" : ""}`}
      aria-label={accessibleLabel}
    >
      <span aria-hidden="true">
        {direction} {trend.direction === "flat" ? "0%" : `${rounded}%`}
        {!compact && " vs prior range"}
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
  const metricLabel = metric === "cost" ? "Cost" : metric === "tokens" ? "Tokens" : "Sessions";
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
          <title>{`${metricLabel} from full session totals by latest-turn cohort`}</title>
          <desc>
            {`Each session appears once, in the date bucket containing its latest turn. The ${metricLabel.toLowerCase()} values are cumulative session totals, not usage generated during that bucket. Detailed values follow the chart.`}
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
                  <title>{`${item.label}: ${formatAxis(value)} from sessions with a latest turn in ${label}`}</title>
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
          <caption>{`${metricLabel} from full session totals by latest-turn cohort and provider`}</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
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
        title="Session cohorts by latest turn"
        description={`${data.chart.labels.length} equal rolling buckets · ${Math.round(data.chart.bucketHours)} hours each`}
        aside={(
          <div className="usage-metric-toggle" role="group" aria-label="Chart metric">
            {(["tokens", "cost", "sessions"] as const).map((item) => (
              <button
                type="button"
                className={metric === item ? "active" : ""}
                aria-pressed={metric === item}
                key={item}
                onClick={() => setMetric(item)}
              >
                {item[0]!.toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        )}
      />
      <CohortChart
        labels={data.chart.labels}
        series={series}
        metric={metric}
        emptyTitle={hiddenActivity ? "All activity is hidden" : "No sessions last active in this range"}
        emptyText={hiddenActivity
          ? "Show a provider to include its activity in breakdowns."
          : "Cohorts fill in as sessions record tokens and cost."}
      />
      <p className="usage-chart-method">
        Each session appears once in the bucket containing its latest turn. Token and cost
        values are that session’s complete recorded totals—not usage generated during the bucket.
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
  if (otherCost > 0) featured.push({ id: "other", label: "Other", cost: otherCost });
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
        title="Cost by provider"
        description="Where workspace spend is going"
        aside={<button type="button" className="usage-icon-button" aria-label="View provider details" onClick={onViewProviders}><Icon.chevronRight /></button>}
      />
      <div className="usage-spend-content">
        <div className="usage-spend-donut" role="img" aria-label={`Provider spend totaling ${formatMoney(total)}`}>
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
          <div><span>Total spend</span><strong>{formatMoney(total)}</strong></div>
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
            <div className="usage-card-empty">
              <strong>{hiddenSpend ? "All spend is hidden" : "No spend recorded"}</strong>
              <span>{hiddenSpend
                ? "Show a provider to include its spend in breakdowns."
                : "Cost appears when the active model reports it."}</span>
            </div>
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
        title="Model breakdown"
        description="Highest-use models among sessions last active in range"
        aside={(
          <div className="usage-metric-toggle" role="group" aria-label="Model breakdown metric">
            {(["tokens", "cost"] as const).map((item) => (
              <button
                type="button"
                className={metric === item ? "active" : ""}
                aria-pressed={metric === item}
                key={item}
                onClick={() => setMetric(item)}
              >
                {item === "tokens" ? "Tokens" : "Cost"}
              </button>
            ))}
          </div>
        )}
      />
      <div className="usage-model-list">
        {shown.map((model, index) => (
          <div className="usage-model-row" key={model.id}>
            <ProviderLogo providerID={model.providerId} providerName={model.providerLabel} className="usage-model-logo" />
            <span className="usage-model-copy">
              <strong title={model.label}>{model.label}</strong>
              <small>{model.providerLabel} · {model.sessions} session{model.sessions === 1 ? "" : "s"}</small>
            </span>
            <span className="usage-model-value">{metric === "tokens" ? fmtTokens(model.tokens) : formatMoney(model.cost)}</span>
            <span className="usage-model-track">
              <i style={{ width: `${model[metric] / maximum * 100}%`, background: seriesAccent(index) }} />
            </span>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="usage-card-empty">
            <strong>{hiddenActivity ? "All model activity is hidden" : "No model activity yet"}</strong>
            <span>{hiddenActivity
              ? "Show a provider to include its models in breakdowns."
              : "Models appear after a session runs in this workspace."}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function CostPulse({ data }: { data: ReturnType<typeof buildUsageDashboardData> }) {
  const averageSession = data.totals.sessions > 0 ? data.totals.cost / data.totals.sessions : 0;
  return (
    <article className="usage-dashboard-card usage-cost-card">
      <SectionHeading title="Cost context" description="Recorded totals for sessions active in range" />
      <div className="usage-cost-total">
        <span>Full recorded session spend</span>
        <strong>{formatMoney(data.totals.cost)}</strong>
        <TrendBadge trend={data.trends.cost} />
      </div>
      <div className="usage-cost-grid">
        <div><span>Sessions counted</span><strong>{data.totals.sessions.toLocaleString()}</strong></div>
        <div><span>Selected range</span><strong>{data.rangeDays} days</strong></div>
        <div><span>Per session</span><strong>{formatMoney(averageSession)}</strong></div>
        <div><span>Per 1K tokens</span><strong>{formatRate(data.totals.averageCostPerThousand)}</strong></div>
      </div>
      <p>Sessions are selected by latest turn. Values are their full recorded totals, not daily billing or a provider invoice.</p>
    </article>
  );
}

function ProviderStatus({ provider }: { provider: UsageProviderSummary }) {
  const state = !provider.snapshot ? "session-only" : provider.stale ? "stale" : "fresh";
  const label = state === "session-only" ? "Session only" : state === "stale" ? "Stale" : "Fresh";
  return (
    <span
      className={`usage-status-pill ${state}`}
      title={state === "stale" ? provider.snapshot?.error?.message : undefined}
      aria-label={state === "stale" && provider.snapshot?.error?.message
        ? `Stale quota feed: ${provider.snapshot.error.message}`
        : label}
    >
      <i />{label}
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
        title="Provider activity"
        description="Session totals and quota feed health"
        aside={<span className="usage-source-badge">Project scoped</span>}
      />
      <div className="usage-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Spend</th>
              <th scope="col">Tokens</th>
              <th scope="col">Sessions</th>
              <th scope="col">Remaining / limit</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td data-label="Provider">
                  <span className="usage-provider-cell">
                    <ProviderLogo
                      providerID={provider.id}
                      providerName={provider.label}
                      className="usage-provider-mark usage-provider-mark-regular"
                    />
                    <span><strong>{provider.label}</strong><small>{provider.id}</small></span>
                  </span>
                </td>
                <td data-label="Spend"><strong>{formatMoney(provider.cost)}</strong><TrendBadge trend={provider.trends.cost} compact /></td>
                <td data-label="Tokens"><strong>{fmtTokens(provider.tokens)}</strong><TrendBadge trend={provider.trends.tokens} compact /></td>
                <td data-label="Sessions"><strong>{provider.sessions.toLocaleString()}</strong><TrendBadge trend={provider.trends.sessions} compact /></td>
                <td data-label="Remaining / limit">
                  {provider.remainingPercent === null ? (
                    <span className="usage-limit-unavailable">Not available</span>
                  ) : (
                    <div className="usage-limit-cell">
                      <div><span>{provider.remainingPercent}%</span><small>{provider.quotaWindow?.label}</small></div>
                      <span
                        className="usage-limit-track"
                        role="progressbar"
                        aria-label={`${provider.label} quota remaining`}
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
                <td data-label="Status">
                  <ProviderStatus provider={provider} />
                </td>
              </tr>
            ))}
            {providers.length === 0 && (
              <tr className="usage-provider-empty-row">
                <td colSpan={6}>{allProvidersHidden
                  ? "All providers are hidden from breakdowns."
                  : "No sessions last active in this range."}</td>
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
        <strong>Shape this dashboard</strong>
        <span>{hiddenCount > 0
          ? `${hiddenCount} provider${hiddenCount === 1 ? " is" : "s are"} hidden from provider breakdowns. Workspace totals still include all activity.`
          : "All discovered providers are included in provider breakdowns."}</span>
      </div>
      <button type="button" className="small-btn" onClick={onProviders}>Provider visibility</button>
      <button type="button" className="small-btn" onClick={onAddProvider}><Icon.plus /> Add provider</button>
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
      <section className="usage-provider-view-intro">
        <div><span>Discovered</span><strong>{providers.length}</strong></div>
        <div><span>Fresh feeds</span><strong>{providers.filter((provider) => provider.snapshot && !provider.stale).length}</strong></div>
        <div><span>Visible</span><strong>{providers.filter((provider) => !hiddenProviders.includes(providerPreferenceId(provider))).length}</strong></div>
        <button type="button" className="small-btn" onClick={onAddProvider}><Icon.plus /> Add provider</button>
      </section>
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
                <div><span>Spend</span><strong>{formatMoney(provider.cost)}</strong></div>
                <div><span>Tokens</span><strong>{fmtTokens(provider.tokens)}</strong></div>
                <div><span>Sessions</span><strong>{provider.sessions.toLocaleString()}</strong></div>
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
                        aria-label={`${provider.label} ${quota.label} used`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(used * 100)}
                      >
                        <i className={used >= .8 ? "warning" : ""} style={{ width: `${used * 100}%` }} />
                      </span>
                      <p>{pace ? paceText(pace, quota) : quota.resetsAt ? `Resets ${new Date(quota.resetsAt).toLocaleString()}` : "Live quota usage"}</p>
                    </div>
                  );
                })}
                {!provider.snapshot?.windows.length && (
                  <div className="usage-provider-no-quota">
                    <Icon.usage />
                    <span><strong>No quota feed</strong><small>Session totals are available; this provider does not expose limits.</small></span>
                  </div>
                )}
              </div>
              <footer>
                <button
                  type="button"
                  className="small-btn"
                  aria-label={`${hidden ? "Show" : "Hide"} ${provider.label} in breakdowns`}
                  onClick={() => setProviderHidden(preferenceId, !hidden)}
                >
                  {hidden ? "Show in breakdowns" : "Hide from breakdowns"}
                </button>
                {provider.snapshot && (
                  <button
                    type="button"
                    className="small-btn"
                    disabled={quotaBusy}
                    aria-label={`Refresh ${provider.label} quota feed`}
                    onClick={() => void onRefresh(provider.snapshot!.providerId)}
                  >
                    <Icon.refresh /> Refresh
                  </button>
                )}
              </footer>
            </article>
          );
        })}
        {providers.length === 0 && (
          <article className="usage-provider-connect-empty">
            <span><Icon.plus /></span>
            <h3>Connect your first provider</h3>
            <p>Polyth discovers quota sources from configured model providers. Credential values stay on the server.</p>
            <button type="button" className="small-btn" onClick={onAddProvider}>Open provider settings</button>
          </article>
        )}
      </div>
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
  const setView = (next: "overview" | "providers") =>
    setUsageDashboardPrefs({ view: next });
  const setLayout = (next: "expanded" | "compact") =>
    setUsageDashboardPrefs({ layout: next });
  const setRangeDays = (next: UsageRangeDays) =>
    setUsageDashboardPrefs({ rangeDays: next });
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
  const freshFeeds = snapshots.filter((snapshot) => !snapshot.stale).length;
  const staleFeeds = snapshots.length - freshFeeds;
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
    >
      <section className="usage-dashboard-hero">
        <div className="usage-hero-mark"><Icon.usage /></div>
        <div>
          <span className="usage-eyebrow">Workspace telemetry</span>
          <h2>Understand the sessions behind every token.</h2>
          <p>Ranges use each session’s latest turn and include its full recorded totals. Provider limits come from connected quota feeds.</p>
        </div>
        <div className="usage-hero-status" aria-live="polite">
          {quotaLoading ? (
            <span className="loading"><Icon.refresh /> Loading quota feeds</span>
          ) : quotaError ? (
            <span className="error"><i /> Quota feeds unavailable</span>
          ) : snapshots.length === 0 ? (
            <span className="neutral"><i /> Session data only</span>
          ) : (
            <span className={staleFeeds > 0 ? "warning" : ""}>
              <i />{staleFeeds > 0
                ? `${freshFeeds}/${snapshots.length} feeds fresh`
                : `${freshFeeds} fresh feed${freshFeeds === 1 ? "" : "s"}`}
            </span>
          )}
          <small>{formatRange(data.rangeStart, data.rangeEnd)}</small>
        </div>
      </section>

      <div className="usage-dashboard-toolbar">
        <div className="usage-view-tabs" role="group" aria-label="Usage view">
          <button type="button" aria-pressed={view === "overview"} className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
            <Icon.widgets /> Overview
          </button>
          <button type="button" aria-pressed={view === "providers"} className={view === "providers" ? "active" : ""} onClick={() => setView("providers")}>
            <Icon.list /> Providers
          </button>
        </div>
        <span className="usage-toolbar-spacer" />
        <div className="usage-range-control" role="group" aria-label="Usage range">
          {([7, 30, 90] as const).map((days) => (
            <button
              type="button"
              aria-pressed={rangeDays === days}
              aria-label={`${days} day range`}
              className={rangeDays === days ? "active" : ""}
              key={days}
              onClick={() => setRangeDays(days)}
            >
              {days}d
            </button>
          ))}
        </div>
        <div className="usage-layout-control" role="group" aria-label="Dashboard density">
          <button type="button" className={layout === "expanded" ? "active" : ""} aria-label="Expanded widgets" aria-pressed={layout === "expanded"} onClick={() => setLayout("expanded")} title="Expanded widgets">
            <Icon.widgets /><span>Expanded</span>
          </button>
          <button type="button" className={layout === "compact" ? "active" : ""} aria-label="Compact widgets" aria-pressed={layout === "compact"} onClick={() => setLayout("compact")} title="Compact widgets">
            <Icon.list /><span>Compact</span>
          </button>
        </div>
        <button
          type="button"
          className={`usage-refresh-button${quotaBusy ? " refreshing" : ""}`}
          aria-label={quotaBusy ? "Refreshing provider quota feeds" : "Refresh provider quota feeds"}
          title={quotaBusy ? "Refreshing provider quota feeds" : "Refresh provider quota feeds"}
          disabled={quotaBusy}
          onClick={() => void refreshAll()}
        >
          <Icon.refresh />
        </button>
      </div>

      {quotaError && (
        <div className="usage-quota-alert" role="alert">
          <Icon.usage />
          <span><strong>Quota feeds could not be loaded.</strong> Session totals remain available. {quotaError}</span>
          <button type="button" className="small-btn" disabled={quotaBusy} onClick={() => void reload()}>Retry</button>
        </div>
      )}

      {view === "overview" ? (
        <div className="usage-dashboard-content">
          <section className="usage-stat-grid" aria-label="Usage summary">
            <StatCard
              label="Spend"
              value={formatMoney(data.totals.cost)}
              trend={data.trends.cost}
              icon="usage"
              tone="var(--accent)"
              detail={`${formatMoney(averageSessionCost)} / session`}
              series={costSeries}
            />
            <StatCard
              label="Tokens"
              value={fmtTokens(data.totals.tokens)}
              trend={data.trends.tokens}
              icon="context"
              tone="var(--purple)"
              detail={`${data.models.length} model${data.models.length === 1 ? "" : "s"}`}
              series={tokenSeries}
            />
            <StatCard
              label="Sessions"
              value={data.totals.sessions.toLocaleString()}
              trend={data.trends.sessions}
              icon="events"
              tone="var(--blue)"
              detail={`${visibleProviders.length} provider${visibleProviders.length === 1 ? "" : "s"} shown`}
              series={sessionSeries}
            />
            <StatCard
              label="Cost / 1K tokens"
              value={data.totals.tokens > 0 ? formatRate(data.totals.averageCostPerThousand) : "$0.0000"}
              trend={data.trends.averageCostPerThousand}
              icon="compare"
              tone="var(--amber)"
              detail={`${rangeDays}-day cohort ratio`}
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
