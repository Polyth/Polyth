import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { fmtCost, fmtTokens } from "../format.ts";
import { setOverlay, useStore } from "../store.ts";
import { setProviderHidden, useUsagePrefs } from "../usagePrefs.ts";
import ProviderLogo from "../components/ProviderLogo.tsx";
import { fmtQuota, paceText, useQuotaSnapshots } from "./quotaUi.tsx";
import {
  buildUsageDashboardData,
  type UsageChartMetric,
  type UsageChartSeries,
  type UsageProviderSummary,
  type UsageRangeDays,
  type UsageTrend,
} from "./dashboardData.ts";

type DashboardView = "overview" | "providers";
type GlyphName =
  | "arrow"
  | "calendar"
  | "chevron"
  | "close"
  | "coin"
  | "gear"
  | "menu"
  | "plus"
  | "refresh"
  | "request"
  | "spark"
  | "tokens"
  | "usage";

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

function Glyph({ name }: { name: GlyphName }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "usage") return <svg {...common}><path d="M4 19V9m6 10V5m6 14v-7m4 7H2" /></svg>;
  if (name === "tokens") return <svg {...common}><path d="m12 3 8 4.4-8 4.4-8-4.4L12 3Z" /><path d="m4 12 8 4.4 8-4.4M4 16.5l8 4.4 8-4.4" /></svg>;
  if (name === "request") return <svg {...common}><path d="M5 7h14M5 12h9M5 17h6" /><path d="m17 14 3 3-3 3" /></svg>;
  if (name === "coin") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M15.5 8.8c-.6-.8-1.7-1.3-3.1-1.3-1.7 0-3 .8-3 2 0 3.1 6.2 1.3 6.2 4.7 0 1.3-1.3 2.3-3.3 2.3-1.5 0-2.8-.6-3.5-1.5M12.2 5.5v13" /></svg>;
  if (name === "calendar") return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4m8-4v4M3 10h18" /></svg>;
  if (name === "refresh") return <svg {...common}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 8a7 7 0 0 1 11.7-1.8L20 8M4 16l2.2 1.8A7 7 0 0 0 17.9 16" /></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === "gear") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.8-1.8l.9-1.9L15 4l-1.9.9a7 7 0 0 0-1.9-.8L10.5 2h-3l-.7 2.1a7 7 0 0 0-1.8.8L3 4 1 6.1 1.9 8a7 7 0 0 0-.8 1.8L-1 10.5v3l2.1.7a7 7 0 0 0 .8 1.8L1 17.9 3 20l2-.9a7 7 0 0 0 1.8.8l.7 2.1h3l.7-2.1a7 7 0 0 0 1.9-.8l1.9.9 2.1-2.1-.9-1.9a7 7 0 0 0 .8-1.8l2-.7Z" transform="translate(2.5) scale(.8)" /></svg>;
  if (name === "menu") return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  if (name === "chevron") return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
  if (name === "arrow") return <svg {...common}><path d="M12 19V5m-5 5 5-5 5 5" /></svg>;
  return <svg {...common}><path d="m12 3 1.7 5.3H19l-4.3 3.2 1.7 5.2-4.4-3.2-4.4 3.2 1.7-5.2L5 8.3h5.3L12 3Z" /></svg>;
}

function TrendBadge({ trend, compact = false }: { trend: UsageTrend | null; compact?: boolean }) {
  if (!trend) return <span className={`usage-trend usage-trend-none ${compact ? "compact" : ""}`}>{compact ? "—" : "No prior data"}</span>;
  const rounded = Math.round(Math.abs(trend.percent));
  return (
    <span className={`usage-trend usage-trend-${trend.direction} ${compact ? "compact" : ""}`}>
      {trend.direction !== "flat" && <span className="usage-trend-arrow"><Glyph name="arrow" /></span>}
      {trend.direction === "flat" ? "0%" : `${rounded}%`}
      {!compact && <span> vs previous period</span>}
    </span>
  );
}

function StatCard({
  label,
  value,
  trend,
  icon,
  tone,
  note,
}: {
  label: string;
  value: string;
  trend: UsageTrend | null;
  icon: GlyphName;
  tone: string;
  note?: string;
}) {
  return (
    <article className="usage-stat-card" style={cssVar("--stat-tone", tone)}>
      <div className="usage-stat-card-top">
        <span>{label}</span>
        <span className="usage-stat-icon"><Glyph name={icon} /></span>
      </div>
      <strong>{value}</strong>
      <div className="usage-stat-foot">
        <TrendBadge trend={trend} />
        {note && <span className="usage-stat-note">{note}</span>}
      </div>
    </article>
  );
}

const formatMoney = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);

const formatRange = (start: number, end: number): string => {
  const date = (value: number) => new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(new Date(start).getFullYear() !== new Date(end).getFullYear() ? { year: "numeric" } : {}),
  }).format(value);
  return `${date(start)} – ${date(end)}, ${new Date(end).getFullYear()}`;
};

function UsageSidebar({
  providers,
  view,
  open,
  onView,
  onClose,
  onAddProvider,
}: {
  providers: UsageProviderSummary[];
  view: DashboardView;
  open: boolean;
  onView: (view: DashboardView) => void;
  onClose: () => void;
  onAddProvider: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`usage-drawer-backdrop ${open ? "open" : ""}`}
        aria-label="Close usage navigation"
        onClick={onClose}
      />
      <aside className={`usage-dashboard-sidebar ${open ? "open" : ""}`} aria-label="Usage navigation">
        <div className="usage-sidebar-brand">
          <span><Glyph name="spark" /></span>
          <strong>LLM Usage</strong>
          <button type="button" className="usage-mobile-close" aria-label="Close menu" onClick={onClose}>
            <Glyph name="close" />
          </button>
        </div>
        <nav className="usage-sidebar-nav">
          <button
            type="button"
            className={view === "overview" ? "active" : ""}
            aria-current={view === "overview" ? "page" : undefined}
            onClick={() => onView("overview")}
          >
            <Glyph name="usage" /> Overview
          </button>
          <button
            type="button"
            className={view === "providers" ? "active" : ""}
            aria-current={view === "providers" ? "page" : undefined}
            onClick={() => onView("providers")}
          >
            <Glyph name="tokens" /> Providers
          </button>
        </nav>
        <div className="usage-sidebar-section">
          <div className="usage-sidebar-label">
            <span>Active providers</span>
            <span>{providers.filter((provider) => !provider.stale).length}</span>
          </div>
          <div className="usage-sidebar-providers">
            {providers.slice(0, 5).map((provider) => (
              <button type="button" key={provider.id} onClick={() => onView("providers")}>
                <span className={`usage-status-dot ${provider.stale ? "inactive" : ""}`} />
                <span>
                  <strong>{provider.label}</strong>
                  <small>{provider.remainingPercent === null ? "Usage connected" : `${provider.remainingPercent}% remaining`}</small>
                </span>
                <ProviderLogo
                  providerID={provider.id}
                  providerName={provider.label}
                  className="usage-provider-mark usage-provider-mark-small"
                />
              </button>
            ))}
            {providers.length === 0 && (
              <div className="usage-sidebar-empty">Providers appear after a model is used or a quota source connects.</div>
            )}
          </div>
        </div>
        <button type="button" className="usage-add-provider-card" onClick={onAddProvider}>
          <span><Glyph name="plus" /></span>
          <strong>Add Provider</strong>
          <small>Connect another LLM account</small>
        </button>
        <button
          type="button"
          className="usage-sidebar-settings"
          onClick={() => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "general" }))}
        >
          <Glyph name="gear" /> Settings
        </button>
      </aside>
    </>
  );
}

function UsageHeader({
  view,
  rangeDays,
  rangeStart,
  rangeEnd,
  rangeOpen,
  refreshing,
  onMenu,
  onRangeOpen,
  onRange,
  onRefresh,
}: {
  view: DashboardView;
  rangeDays: UsageRangeDays;
  rangeStart: number;
  rangeEnd: number;
  rangeOpen: boolean;
  refreshing: boolean;
  onMenu: () => void;
  onRangeOpen: () => void;
  onRange: (days: UsageRangeDays) => void;
  onRefresh: () => void;
}) {
  return (
    <header className="usage-dashboard-header">
      <div className="usage-title-row">
        <button type="button" className="usage-menu-button" aria-label="Open usage navigation" onClick={onMenu}>
          <Glyph name="menu" />
        </button>
        <div>
          <h1>{view === "overview" ? "Usage Overview" : "Providers"}</h1>
          <p>{view === "overview"
            ? "Monitor your LLM usage and costs across all providers."
            : "Review connected providers, quota windows, and account health."}</p>
        </div>
      </div>
      <div className="usage-header-actions">
        <div className="usage-date-picker">
          <button
            type="button"
            className="usage-date-control"
            aria-expanded={rangeOpen}
            onClick={onRangeOpen}
          >
            <Glyph name="calendar" />
            <span>{formatRange(rangeStart, rangeEnd)}</span>
            <span className="usage-date-chevron">⌄</span>
          </button>
          {rangeOpen && (
            <div className="usage-range-menu" role="menu">
              {([7, 30, 90] as const).map((days) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={rangeDays === days}
                  className={rangeDays === days ? "active" : ""}
                  key={days}
                  onClick={() => onRange(days)}
                >
                  Last {days} days
                  {rangeDays === days && <span>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`usage-refresh-button ${refreshing ? "refreshing" : ""}`}
          aria-label="Refresh provider usage"
          onClick={onRefresh}
        >
          <Glyph name="refresh" />
        </button>
        <button type="button" className="usage-dashboard-close" aria-label="Close usage dashboard" onClick={() => setOverlay(null)}>
          <Glyph name="close" />
        </button>
      </div>
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
            <linearGradient key={item.providerId} id={`usage-gradient-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesAccent(index)} stopOpacity=".32" />
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
              <text
                className="usage-chart-y-label"
                x={left - 9}
                y={y + 3}
                textAnchor="end"
              >
                {formatAxis(value)}
              </text>
            </g>
          );
        })}
        {series.map((item, index) => {
          const accent = seriesAccent(index);
          const line = item.values.map((value, pointIndex) =>
            `${pointIndex === 0 ? "M" : "L"} ${pointX(pointIndex)} ${pointY(value)}`).join(" ");
          const area = `${line} L ${pointX(labels.length - 1)} ${top + chartHeight} L ${pointX(0)} ${top + chartHeight} Z`;
          return (
            <g key={item.providerId}>
              <path d={area} fill={`url(#usage-gradient-${index})`} />
              <path className="usage-chart-line" d={line} stroke={accent} />
              {item.values.map((value, pointIndex) => value > 0 && (
                <circle
                  key={pointIndex}
                  className="usage-chart-point"
                  cx={pointX(pointIndex)}
                  cy={pointY(value)}
                  r="3"
                  fill={accent}
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
          <span><Glyph name="usage" /></span>
          <strong>No usage in this period</strong>
          <small>Activity appears as sessions record tokens and cost.</small>
        </div>
      )}
    </div>
  );
}

function UsageOverTime({
  data,
}: {
  data: ReturnType<typeof buildUsageDashboardData>;
}) {
  const [metric, setMetric] = useState<UsageChartMetric>("tokens");
  return (
    <article className="usage-dashboard-card usage-time-card">
      <div className="usage-card-heading">
        <div>
          <h2>Usage Over Time</h2>
          <p>Session totals grouped by last activity</p>
        </div>
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
      </div>
      <AreaChart labels={data.chart.labels} series={data.chart[metric]} metric={metric} />
      <div className="usage-chart-legend">
        {data.chart[metric].map((item, index) => (
          <span key={item.providerId}>
            <ProviderLogo
              providerID={item.providerId}
              providerName={item.label}
              className="usage-legend-logo"
            />
            <i style={{ background: seriesAccent(index) }} />
            {item.label}
          </span>
        ))}
      </div>
    </article>
  );
}

function ProviderSpendDonut({
  providers,
  onViewProviders,
}: {
  providers: UsageProviderSummary[];
  onViewProviders: () => void;
}) {
  const top = providers.filter((provider) => provider.cost > 0).slice(0, 5);
  const total = top.reduce((sum, provider) => sum + provider.cost, 0);
  let offset = 0;
  const arcs = top.map((provider, index) => {
    const share = total > 0 ? provider.cost / total : 0;
    const start = offset;
    offset += share * 100;
    return { provider, share, offset: start, accent: seriesAccent(index) };
  });
  return (
    <article className="usage-dashboard-card usage-spend-card">
      <div className="usage-card-heading">
        <div>
          <h2>Top Providers by Spend</h2>
          <p>Cost distribution for this period</p>
        </div>
        <button type="button" className="usage-card-more" aria-label="View all providers" onClick={onViewProviders}>•••</button>
      </div>
      <div className="usage-spend-content">
        <div className="usage-spend-donut" role="img" aria-label={`Provider spend totaling ${formatMoney(total)}`}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle className="usage-spend-track" cx="60" cy="60" r="45" pathLength="100" />
            {arcs.map(({ provider, share, offset: arcOffset, accent }) => (
              <circle
                className="usage-spend-arc"
                key={provider.id}
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
          {arcs.map(({ provider, share, accent }) => (
            <div key={provider.id}>
              <ProviderLogo
                providerID={provider.id}
                providerName={provider.label}
                className="usage-legend-logo"
              />
              <i style={{ background: accent }} />
              <span>{provider.label}</span>
              <strong>{formatMoney(provider.cost)}</strong>
              <small>{Math.round(share * 100)}%</small>
            </div>
          ))}
          {arcs.length === 0 && (
            <div className="usage-spend-empty">
              <strong>No spend recorded</strong>
              <span>Cost appears when supported by the active model.</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function ProviderTable({ providers }: { providers: UsageProviderSummary[] }) {
  return (
    <article className="usage-dashboard-card usage-providers-card">
      <div className="usage-card-heading">
        <div>
          <h2>Providers</h2>
          <p>Usage, cost, and quota health</p>
        </div>
        <span className="usage-live-badge"><i /> Live data</span>
      </div>
      <div className="usage-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Spend</th>
              <th>Tokens</th>
              <th>Requests</th>
              <th>Remaining / Limit</th>
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
                <td data-label="Requests"><strong>{provider.sessions.toLocaleString()}</strong><TrendBadge trend={provider.trends.sessions} compact /></td>
                <td data-label="Remaining / Limit">
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
                <td data-label="Status"><span className={`usage-status-pill ${provider.stale ? "stale" : ""}`}><i />{provider.stale ? "Stale" : "Active"}</span></td>
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

function QuickActions({
  onAddProvider,
  onManageLimits,
}: {
  onAddProvider: () => void;
  onManageLimits: () => void;
}) {
  const actions: Array<{ title: string; text: string; icon: GlyphName; tone: string; run: () => void }> = [
    { title: "Add Provider", text: "Connect a new LLM account", icon: "plus", tone: "#22C879", run: onAddProvider },
    { title: "Manage Limits", text: "Review quota windows and health", icon: "tokens", tone: "#7C5CFC", run: onManageLimits },
  ];
  return (
    <article className="usage-dashboard-card usage-quick-card">
      <div className="usage-card-heading"><div><h2>Quick Actions</h2><p>Manage usage sources</p></div></div>
      <div className="usage-quick-list">
        {actions.map((action) => (
          <button type="button" key={action.title} onClick={action.run} style={cssVar("--action-tone", action.tone)}>
            <span className="usage-quick-icon"><Glyph name={action.icon} /></span>
            <span><strong>{action.title}</strong><small>{action.text}</small></span>
            <span className="usage-quick-chevron"><Glyph name="chevron" /></span>
          </button>
        ))}
      </div>
      <div className="usage-quick-note"><span>i</span> Quotas refresh automatically every minute.</div>
    </article>
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
    <div className="usage-provider-view">
      <div className="usage-provider-view-intro">
        <div><span>Provider health</span><strong>{providers.filter((provider) => !provider.stale).length} active</strong></div>
        <div><span>Quota sources</span><strong>{providers.filter((provider) => provider.snapshot).length} connected</strong></div>
        <button type="button" onClick={onAddProvider}><Glyph name="plus" /> Add provider</button>
      </div>
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
                  <h2>{provider.label}</h2>
                  <p>{provider.snapshot?.accountLabel ?? provider.id}</p>
                </div>
                <span className={`usage-status-pill ${provider.stale ? "stale" : ""}`}><i />{provider.stale ? "Stale" : "Active"}</span>
              </header>
              <div className="usage-provider-detail-stats">
                <div><span>Spend</span><strong>{formatMoney(provider.cost)}</strong></div>
                <div><span>Tokens</span><strong>{fmtTokens(provider.tokens)}</strong></div>
                <div><span>Requests</span><strong>{provider.sessions}</strong></div>
              </div>
              <div className="usage-provider-windows">
                {provider.snapshot?.windows.map((window) => {
                  const used = window.limit > 0 ? Math.min(1, window.used / window.limit) : 0;
                  const pace = provider.snapshot?.pace[window.id] ?? null;
                  return (
                    <div key={window.id} className="usage-provider-window">
                      <div><span>{window.label}</span><strong>{fmtQuota(window.used, window.unit)} <small>/ {fmtQuota(window.limit, window.unit)}</small></strong></div>
                      <span className="usage-provider-window-track"><i className={used >= .8 ? "warning" : ""} style={{ width: `${used * 100}%` }} /></span>
                      <p>{pace ? paceText(pace, window) : window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : "Live quota usage"}</p>
                    </div>
                  );
                })}
                {!provider.snapshot?.windows.length && (
                  <div className="usage-provider-no-quota">
                    <Glyph name="spark" />
                    <span><strong>No quota feed</strong><small>Session usage is available; provider limits are not exposed.</small></span>
                  </div>
                )}
              </div>
              <footer>
                <button type="button" onClick={() => setProviderHidden(preferenceId, !hidden)}>{hidden ? "Show in widgets" : "Hide from widgets"}</button>
                {provider.snapshot && <button type="button" onClick={() => onRefresh(provider.snapshot!.providerId)}><Glyph name="refresh" /> Refresh</button>}
              </footer>
            </article>
          );
        })}
        {providers.length === 0 && (
          <article className="usage-provider-connect-empty">
            <span><Glyph name="plus" /></span>
            <h2>Connect your first provider</h2>
            <p>Providers are discovered from OpenCode and Claude Code credentials. Secret values stay on the server.</p>
            <button type="button" onClick={onAddProvider}>Open provider settings</button>
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
  const [rangeDays, setRangeDays] = useState<UsageRangeDays>(7);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const data = useMemo(
    () => buildUsageDashboardData(projectSessions, snapshots, rangeDays),
    [projectSessions, rangeDays, snapshots],
  );
  const visibleProviders = data.providers.filter(
    (provider) => !prefs.hiddenProviders.includes(providerPreferenceId(provider)),
  );

  const changeView = (next: DashboardView) => {
    setView(next);
    setDrawerOpen(false);
  };
  const addProvider = () => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "models" }));
  const refreshAll = () => {
    setRefreshing(true);
    if (snapshots.length === 0) reload();
    for (const snapshot of snapshots) refresh(snapshot.providerId);
    window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <div className="usage-dashboard">
      <UsageSidebar
        providers={visibleProviders}
        view={view}
        open={drawerOpen}
        onView={changeView}
        onClose={() => setDrawerOpen(false)}
        onAddProvider={addProvider}
      />
      <main className="usage-dashboard-main">
        <UsageHeader
          view={view}
          rangeDays={rangeDays}
          rangeStart={data.rangeStart}
          rangeEnd={data.rangeEnd}
          rangeOpen={rangeOpen}
          refreshing={refreshing}
          onMenu={() => setDrawerOpen(true)}
          onRangeOpen={() => setRangeOpen((open) => !open)}
          onRange={(days) => { setRangeDays(days); setRangeOpen(false); }}
          onRefresh={refreshAll}
        />
        {view === "overview" ? (
          <div className="usage-dashboard-content">
            <section className="usage-stat-grid" aria-label="Usage summary">
              <StatCard label="Total Spend" value={formatMoney(data.totals.cost)} trend={data.trends.cost} icon="usage" tone="#22C879" />
              <StatCard label="Total Tokens" value={fmtTokens(data.totals.tokens)} trend={data.trends.tokens} icon="tokens" tone="#8A6DFF" />
              <StatCard label="Requests" value={data.totals.sessions.toLocaleString()} trend={data.trends.sessions} icon="request" tone="#4CA8FF" note="session proxy" />
              <StatCard
                label="Avg. Cost / 1K Tokens"
                value={data.totals.tokens > 0 ? fmtCost(data.totals.averageCostPerThousand) : "$0.0000"}
                trend={data.trends.averageCostPerThousand}
                icon="coin"
                tone="#E7B84B"
              />
            </section>
            <section className="usage-chart-grid">
              <UsageOverTime data={data} />
              <ProviderSpendDonut providers={visibleProviders} onViewProviders={() => changeView("providers")} />
            </section>
            <section className="usage-bottom-grid">
              <ProviderTable providers={visibleProviders} />
              <QuickActions onAddProvider={addProvider} onManageLimits={() => changeView("providers")} />
            </section>
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
      </main>
    </div>
  );
}
