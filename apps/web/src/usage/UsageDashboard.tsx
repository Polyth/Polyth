import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { fmtCost, fmtTokens } from "../format.ts";
import { Icon } from "../icons.tsx";
import { useStore } from "../store.ts";
import { setProviderHidden, useUsagePrefs } from "../usagePrefs.ts";
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

type DashboardView = "overview" | "providers";
type DashboardLayout = "expanded" | "compact";
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

const formatMoney = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);

const formatRange = (start: number, end: number): string => {
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
};

const aggregateSeries = (series: readonly UsageChartSeries[], points: number): number[] =>
  Array.from({ length: points }, (_, point) =>
    series.reduce((total, item) => total + (item.values[point] ?? 0), 0));

function TrendBadge({ trend, compact = false }: { trend: UsageTrend | null; compact?: boolean }) {
  if (!trend) {
    return <span className={`usage-trend usage-trend-none${compact ? " compact" : ""}`}>{compact ? "—" : "No prior data"}</span>;
  }
  const rounded = Math.round(Math.abs(trend.percent));
  const direction = trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→";
  return (
    <span className={`usage-trend usage-trend-${trend.direction}${compact ? " compact" : ""}`}>
      <span aria-hidden="true">{direction}</span>
      {trend.direction === "flat" ? "0%" : `${rounded}%`}
      {!compact && <span> from previous</span>}
    </span>
  );
}

function MiniSparkline({ values, tone }: { values: readonly number[]; tone: string }) {
  const width = 112;
  const height = 32;
  const maximum = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? 0 : index / (values.length - 1) * width;
    const y = height - value / maximum * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg
      className="usage-stat-sparkline"
      style={cssVar("--spark-tone", tone)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points || `0,${height} ${width},${height}`} />
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
      <MiniSparkline values={series} tone={tone} />
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

function AreaChart({
  labels,
  series,
  metric,
}: {
  labels: string[];
  series: UsageChartSeries[];
  metric: UsageChartMetric;
}) {
  const width = 720;
  const height = 236;
  const top = 12;
  const bottom = 32;
  const left = 54;
  const right = 8;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const allValues = series.flatMap((item) => item.values);
  const maximum = Math.max(1, ...allValues);
  const pointX = (index: number) => labels.length <= 1
    ? left
    : left + index / (labels.length - 1) * chartWidth;
  const pointY = (value: number) => top + chartHeight - value / maximum * chartHeight;
  const populated = allValues.some((value) => value > 0);
  const formatAxis = (value: number) => metric === "cost"
    ? `$${value < 1 ? value.toFixed(2) : Math.round(value)}`
    : metric === "tokens"
      ? fmtTokens(Math.round(value))
      : String(Math.round(value));

  return (
    <div className="usage-area-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} usage over time`}>
        <defs>
          {series.map((item, index) => (
            <linearGradient key={item.providerId} id={`usage-${metric}-gradient-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesAccent(index)} stopOpacity=".26" />
              <stop offset="100%" stopColor={seriesAccent(index)} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
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
        {series.map((item, index) => {
          const line = item.values.map((value, pointIndex) =>
            `${pointIndex === 0 ? "M" : "L"} ${pointX(pointIndex)} ${pointY(value)}`).join(" ");
          const area = `${line} L ${pointX(labels.length - 1)} ${top + chartHeight} L ${pointX(0)} ${top + chartHeight} Z`;
          return (
            <g key={item.providerId}>
              <path d={area} fill={`url(#usage-${metric}-gradient-${index})`} />
              <path className="usage-chart-line" d={line} stroke={seriesAccent(index)} />
              {item.values.map((value, pointIndex) => value > 0 && (
                <circle
                  key={pointIndex}
                  className="usage-chart-point"
                  cx={pointX(pointIndex)}
                  cy={pointY(value)}
                  r="3"
                  fill={seriesAccent(index)}
                >
                  <title>{`${item.label}: ${formatAxis(value)} on ${labels[pointIndex]}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {labels.map((label, index) => {
          const every = Math.max(1, Math.ceil(labels.length / 6));
          if (index % every !== 0 && index !== labels.length - 1) return null;
          return (
            <text
              className="usage-chart-x-label"
              key={`${label}-${index}`}
              x={pointX(index)}
              y={height - 5}
              textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}
            >
              {label}
            </text>
          );
        })}
      </svg>
      {!populated && (
        <div className="usage-chart-empty">
          <span><Icon.usage /></span>
          <strong>No usage in this period</strong>
          <small>Charts fill in as sessions record tokens and cost.</small>
        </div>
      )}
    </div>
  );
}

function UsageOverTime({ data }: { data: ReturnType<typeof buildUsageDashboardData> }) {
  const [metric, setMetric] = useState<UsageChartMetric>("tokens");
  return (
    <article className="usage-dashboard-card usage-time-card">
      <SectionHeading
        title="Usage over time"
        description="Session activity, grouped by provider"
        aside={(
          <div className="usage-metric-toggle" aria-label="Chart metric">
            {(["tokens", "cost", "requests"] as const).map((item) => (
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
      <AreaChart labels={data.chart.labels} series={data.chart[metric]} metric={metric} />
      <div className="usage-chart-legend">
        {data.chart[metric].map((item, index) => (
          <span key={item.providerId}>
            <i style={{ background: seriesAccent(index) }} />
            <ProviderLogo providerID={item.providerId} providerName={item.label} className="usage-legend-logo" />
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
}: {
  providers: UsageProviderSummary[];
  onViewProviders: () => void;
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
              <strong>No spend recorded</strong>
              <span>Cost appears when the active model reports it.</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function ModelBreakdown({ models }: { models: UsageModelSummary[] }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const shown = models.slice(0, 6);
  const maximum = Math.max(1, ...shown.map((model) => model[metric]));
  return (
    <article className="usage-dashboard-card usage-model-card">
      <SectionHeading
        title="Model breakdown"
        description="Highest-use models in this period"
        aside={(
          <div className="usage-metric-toggle" aria-label="Model breakdown metric">
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
            <strong>No model activity yet</strong>
            <span>Models appear after a session runs in this workspace.</span>
          </div>
        )}
      </div>
    </article>
  );
}

function CostPulse({ data }: { data: ReturnType<typeof buildUsageDashboardData> }) {
  const dailyPace = data.totals.cost / data.rangeDays;
  const monthlyPace = dailyPace * 30;
  const averageSession = data.totals.sessions > 0 ? data.totals.cost / data.totals.sessions : 0;
  return (
    <article className="usage-dashboard-card usage-cost-card">
      <SectionHeading title="Cost pulse" description="Spend pace for the selected range" />
      <div className="usage-cost-total">
        <span>Recorded spend</span>
        <strong>{formatMoney(data.totals.cost)}</strong>
        <TrendBadge trend={data.trends.cost} />
      </div>
      <div className="usage-cost-grid">
        <div><span>Daily pace</span><strong>{formatMoney(dailyPace)}</strong></div>
        <div><span>30-day pace</span><strong>{formatMoney(monthlyPace)}</strong></div>
        <div><span>Per session</span><strong>{formatMoney(averageSession)}</strong></div>
        <div><span>Per 1K tokens</span><strong>{fmtCost(data.totals.averageCostPerThousand)}</strong></div>
      </div>
      <p>Projection uses the selected period’s daily average; it is not a provider invoice.</p>
    </article>
  );
}

function ProviderTable({ providers }: { providers: UsageProviderSummary[] }) {
  return (
    <article className="usage-dashboard-card usage-providers-card">
      <SectionHeading
        title="Provider activity"
        description="Session totals and current quota health"
        aside={<span className="usage-live-badge"><i /> Session log + quota feeds</span>}
      />
      <div className="usage-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Spend</th>
              <th>Tokens</th>
              <th>Sessions</th>
              <th>Remaining / limit</th>
              <th>Status</th>
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
                      <span className="usage-limit-track">
                        <i
                          className={provider.remainingPercent < 20 ? "critical" : provider.remainingPercent < 40 ? "warning" : ""}
                          style={{ width: `${provider.remainingPercent}%` }}
                        />
                      </span>
                    </div>
                  )}
                </td>
                <td data-label="Status">
                  <span className={`usage-status-pill ${provider.stale ? "stale" : ""}`}><i />{provider.stale ? "Stale" : "Active"}</span>
                </td>
              </tr>
            ))}
            {providers.length === 0 && (
              <tr className="usage-provider-empty-row">
                <td colSpan={6}>No provider activity in this period.</td>
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
        <span>{hiddenCount > 0 ? `${hiddenCount} provider${hiddenCount === 1 ? " is" : "s are"} hidden from summary widgets.` : "All discovered providers are included in summary widgets."}</span>
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
}: {
  providers: UsageProviderSummary[];
  hiddenProviders: string[];
  onAddProvider: () => void;
  onRefresh: (providerId: string) => void;
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
                  <p>{provider.snapshot?.accountLabel ?? provider.id}</p>
                </div>
                <span className={`usage-status-pill ${provider.stale ? "stale" : ""}`}><i />{provider.stale ? "Stale" : "Active"}</span>
              </header>
              <div className="usage-provider-detail-stats">
                <div><span>Spend</span><strong>{formatMoney(provider.cost)}</strong></div>
                <div><span>Tokens</span><strong>{fmtTokens(provider.tokens)}</strong></div>
                <div><span>Sessions</span><strong>{provider.sessions}</strong></div>
              </div>
              <div className="usage-provider-windows">
                {provider.snapshot?.windows.map((quota) => {
                  const used = quota.limit > 0 ? Math.min(1, quota.used / quota.limit) : 0;
                  const pace = provider.snapshot?.pace[quota.id] ?? null;
                  return (
                    <div key={quota.id} className="usage-provider-window">
                      <div>
                        <span>{quota.label}</span>
                        <strong>{fmtQuota(quota.used, quota.unit)} <small>/ {fmtQuota(quota.limit, quota.unit)}</small></strong>
                      </div>
                      <span className="usage-provider-window-track">
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
                <button type="button" className="small-btn" onClick={() => setProviderHidden(preferenceId, !hidden)}>
                  {hidden ? "Show in summaries" : "Hide from summaries"}
                </button>
                {provider.snapshot && (
                  <button type="button" className="small-btn" onClick={() => onRefresh(provider.snapshot!.providerId)}>
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
  const { snapshots, reload, refresh } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const [view, setView] = useState<DashboardView>("overview");
  const [layout, setLayout] = useState<DashboardLayout>("expanded");
  const [rangeDays, setRangeDays] = useState<UsageRangeDays>(7);
  const [refreshing, setRefreshing] = useState(false);
  const data = useMemo(
    () => buildUsageDashboardData(projectSessions, snapshots, rangeDays),
    [projectSessions, rangeDays, snapshots],
  );
  const visibleProviders = data.providers.filter(
    (provider) => !prefs.hiddenProviders.includes(providerPreferenceId(provider)),
  );
  const tokenSeries = aggregateSeries(data.chart.tokens, data.chart.labels.length);
  const costSeries = aggregateSeries(data.chart.cost, data.chart.labels.length);
  const sessionSeries = aggregateSeries(data.chart.requests, data.chart.labels.length);
  const averageSeries = costSeries.map((cost, index) => {
    const tokens = tokenSeries[index] ?? 0;
    return tokens > 0 ? cost / tokens * 1_000 : 0;
  });
  const freshFeeds = snapshots.filter((snapshot) => !snapshot.stale).length;
  const staleFeeds = snapshots.length - freshFeeds;
  const averageSessionCost = data.totals.sessions > 0 ? data.totals.cost / data.totals.sessions : 0;
  const addProvider = () => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "models" }));
  const refreshAll = () => {
    setRefreshing(true);
    if (snapshots.length === 0) reload();
    for (const snapshot of snapshots) refresh(snapshot.providerId);
    window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <div className={`usage-dashboard usage-layout-${layout}`} data-settings-item="usage.dashboard">
      <section className="usage-dashboard-hero">
        <div className="usage-hero-mark"><Icon.usage /></div>
        <div>
          <span className="usage-eyebrow">Workspace telemetry</span>
          <h2>Understand the work behind every token.</h2>
          <p>Session totals come from Polyth’s event history. Provider limits are refreshed from connected quota feeds.</p>
        </div>
        <div className="usage-hero-status">
          <span className={staleFeeds > 0 ? "warning" : ""}><i />{freshFeeds} fresh feed{freshFeeds === 1 ? "" : "s"}</span>
          <small>{formatRange(data.rangeStart, data.rangeEnd)}</small>
        </div>
      </section>

      <div className="usage-dashboard-toolbar">
        <div className="usage-view-tabs" role="tablist" aria-label="Usage view">
          <button type="button" role="tab" aria-selected={view === "overview"} className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
            <Icon.widgets /> Overview
          </button>
          <button type="button" role="tab" aria-selected={view === "providers"} className={view === "providers" ? "active" : ""} onClick={() => setView("providers")}>
            <Icon.list /> Providers
          </button>
        </div>
        <span className="usage-toolbar-spacer" />
        <div className="usage-range-control" role="radiogroup" aria-label="Usage range">
          {([7, 30, 90] as const).map((days) => (
            <button
              type="button"
              role="radio"
              aria-checked={rangeDays === days}
              className={rangeDays === days ? "active" : ""}
              key={days}
              onClick={() => setRangeDays(days)}
            >
              {days}d
            </button>
          ))}
        </div>
        <div className="usage-layout-control" aria-label="Dashboard density">
          <button type="button" className={layout === "expanded" ? "active" : ""} aria-pressed={layout === "expanded"} onClick={() => setLayout("expanded")} title="Expanded widgets">
            <Icon.widgets /><span>Expanded</span>
          </button>
          <button type="button" className={layout === "compact" ? "active" : ""} aria-pressed={layout === "compact"} onClick={() => setLayout("compact")} title="Compact widgets">
            <Icon.list /><span>Compact</span>
          </button>
        </div>
        <button
          type="button"
          className={`usage-refresh-button${refreshing ? " refreshing" : ""}`}
          aria-label="Refresh provider usage"
          onClick={refreshAll}
        >
          <Icon.refresh />
        </button>
      </div>

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
              detail={`${visibleProviders.length} provider${visibleProviders.length === 1 ? "" : "s"}`}
              series={sessionSeries}
            />
            <StatCard
              label="Cost / 1K tokens"
              value={data.totals.tokens > 0 ? fmtCost(data.totals.averageCostPerThousand) : "$0.0000"}
              trend={data.trends.averageCostPerThousand}
              icon="compare"
              tone="var(--amber)"
              detail={`${rangeDays}-day average`}
              series={averageSeries}
            />
          </section>

          <section className="usage-primary-grid">
            <UsageOverTime data={data} />
            <CostPulse data={data} />
          </section>

          <section className="usage-breakdown-grid">
            <ProviderSpendDonut providers={visibleProviders} onViewProviders={() => setView("providers")} />
            <ModelBreakdown models={data.models.filter((model) =>
              visibleProviders.some((provider) => provider.id === model.providerId))} />
          </section>

          <ProviderTable providers={visibleProviders} />
          <UsageActionStrip
            hiddenCount={data.providers.length - visibleProviders.length}
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
          />
        </div>
      )}
    </div>
  );
}
