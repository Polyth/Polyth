import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Chart from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import type { QuotaWindowDto } from "@polyth/session/web-api";
import { fmtTokens } from "../../../../apps/web/src/format.ts";
import { formatNumber, getLocale } from "../../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../../apps/web/src/store.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import {
  orderUsageBlocks,
  setUsageDashboardPrefs,
  useUsagePrefs,
  type UsageBreakdownDimension,
  type UsageProviderCostProfile,
} from "../usagePrefs.ts";
import {
  buildUsageDashboardData,
  type UsageChartMetric,
  type UsageConsumerSummary,
  type UsageDateRange,
  type UsageDimension,
  type UsageProviderSummary,
  type UsageRangeDays,
} from "./dashboardData.ts";
import { fmtQuota, useQuotaSnapshots } from "./quotaUi.tsx";
import {
  Button,
  ChevronRightIcon,
  IconButton,
  Popover,
  RefreshIcon,
  SettingsIcon,
  TabPanel,
  Tabs,
  TextInput,
} from "../../../../apps/web/src/components/ui/index.ts";

const money = (value: number, approximate = false): string => {
  const formatted = new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return approximate ? `≈${formatted}` : formatted;
};

const compactNumber = (value: number): string =>
  new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(value);

const percent = (value: number): string => `${Math.round(value)}%`;

const relativeDuration = (ms: number): string => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return remainingMinutes >= 15 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
};

export const formatQuotaReset = (resetsAt: number, now = Date.now()): string =>
  `resets ${relativeDuration(resetsAt - now)}`;

const fullResetTitle = (resetsAt: number): string =>
  new Date(resetsAt).toLocaleString(getLocale());

const rangeDate = (value: string, endOfDay = false): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getTime() + (endOfDay ? 24 * 60 * 60_000 - 1 : 0);
};

const dateOnly = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const resolvedRange = (
  rangeMode: "preset" | "custom",
  rangeDays: UsageRangeDays,
  customRange: { start: string; end: string } | null,
): UsageRangeDays | UsageDateRange => {
  if (rangeMode !== "custom" || !customRange) return rangeDays;
  const start = rangeDate(customRange.start);
  const end = rangeDate(customRange.end, true);
  if (start === null || end === null || start > end) return rangeDays;
  return { start, end: Math.min(Date.now(), end) };
};

const quotaFraction = (window: QuotaWindowDto): number =>
  window.limit > 0 ? Math.min(1, Math.max(0, window.used / window.limit)) : 0;

const quotaTone = (fraction: number): "normal" | "warn" | "danger" =>
  fraction >= 1 ? "danger" : fraction >= .8 ? "warn" : "normal";

const conciseQuotaLabel = (window: QuotaWindowDto): string => {
  const direct = /\b(\d+\s*(?:h|d|w|mo))\b/i.exec(window.label)?.[1]
    ?? /\b(\d+\s*(?:h|d|w|mo))\b/i.exec(window.id)?.[1];
  return direct?.replace(/\s+/g, "") ?? window.label;
};

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="usage-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function QuotaRow({ window }: { window: QuotaWindowDto }) {
  const fraction = quotaFraction(window);
  return (
    <div className="usage-quota-row">
      <div className="usage-quota-row-head">
        <span title={window.label}>{conciseQuotaLabel(window)}</span>
        <span>
          {Math.round(fraction * 100)}%
          {window.resetsAt !== undefined && (
            <small title={fullResetTitle(window.resetsAt)}> · {formatQuotaReset(window.resetsAt)}</small>
          )}
        </span>
      </div>
      <div
        className="usage-quota-track"
        role="progressbar"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <i className={quotaTone(fraction)} style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

function BudgetRow({ spent, budget }: { spent: number; budget: number }) {
  const fraction = budget > 0 ? Math.min(1, Math.max(0, spent / budget)) : 0;
  return (
    <div className="usage-quota-row">
      <div className="usage-quota-row-head">
        <span>Month budget</span>
        <span>{money(spent)} / {money(budget)}</span>
      </div>
      <div
        className="usage-quota-track"
        role="progressbar"
        aria-label="Monthly API budget"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <i className={quotaTone(fraction)} style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

const profileFor = (
  provider: UsageProviderSummary,
  profiles: Readonly<Record<string, UsageProviderCostProfile>>,
): UsageProviderCostProfile =>
  profiles[provider.id] ?? { billing: "api", monthlyCost: null, monthlyBudget: null };

function CompositionBars({
  title,
  items,
  metric,
}: {
  title: string;
  items: readonly UsageConsumerSummary[];
  metric: UsageChartMetric;
}) {
  const top = items.slice(0, 5);
  const total = top.reduce((sum, item) =>
    sum + (metric === "cost" ? item.cost : metric === "sessions" ? item.sessions : item.tokens), 0);
  if (top.length === 0 || total <= 0) return null;
  return (
    <div className="usage-detail-composition">
      <h4>{title}</h4>
      {top.map((item) => {
        const value = metric === "cost" ? item.cost : metric === "sessions" ? item.sessions : item.tokens;
        return (
          <div className="usage-distribution-row" key={item.id}>
            <span title={item.label}>{item.label}</span>
            <div className="usage-distribution-track"><i style={{ width: `${value / total * 100}%` }} /></div>
            <strong>{metric === "cost" ? money(value) : metric === "sessions" ? compactNumber(value) : fmtTokens(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function ProviderCard({
  provider,
  profile,
  cardMetrics,
  showApiEquivalent,
  showValueMultiplier,
  showQuotaDetails,
  metric,
}: {
  provider: UsageProviderSummary;
  profile: UsageProviderCostProfile;
  cardMetrics: readonly string[];
  showApiEquivalent: boolean;
  showValueMultiplier: boolean;
  showQuotaDetails: boolean;
  metric: UsageChartMetric;
}) {
  const [expanded, setExpanded] = useState(false);
  const snapshot = provider.snapshot;
  const quotaWindows = snapshot?.windows ?? [];
  const sortedQuotaWindows = [...quotaWindows].sort((a, b) => quotaFraction(b) - quotaFraction(a));
  const collapsedWindows = sortedQuotaWindows.slice(0, 2);
  const budgetPercent = profile.billing === "api" && profile.monthlyBudget && profile.monthlyBudget > 0
    ? Math.round(Math.min(1, provider.monthCost / profile.monthlyBudget) * 100)
    : null;
  const headlinePercent = provider.quotaUsedPercent ?? budgetPercent;
  const primaryReset = provider.quotaWindow?.resetsAt;
  const status = provider.stale ? "Stale" : snapshot ? "Fresh" : "Session data";
  const statusState = provider.stale ? "stale" : snapshot ? "fresh" : "session";
  const costLabel = profile.billing === "subscription"
    ? showApiEquivalent ? "API equiv." : "Subscription"
    : "Spent";
  const costValue = profile.billing === "subscription"
    ? showApiEquivalent
      ? money(provider.cost, true)
      : profile.monthlyCost === null ? "—" : `${money(profile.monthlyCost)}/mo`
    : money(provider.cost);
  const valueMultiplier = profile.billing === "subscription"
    && profile.monthlyCost !== null
    && profile.monthlyCost > 0
    && provider.monthCost > 0
      ? provider.monthCost / profile.monthlyCost
      : null;

  const primaryMetrics = [
    cardMetrics.includes("cost") ? { label: costLabel, value: costValue } : null,
    cardMetrics.includes("tokens") ? { label: "Tokens", value: fmtTokens(provider.tokens) } : null,
    cardMetrics.includes("sessions") ? { label: "Sessions", value: compactNumber(provider.sessions) } : null,
  ].filter((item): item is { label: string; value: string } => item !== null);

  const secondaryMetrics = [
    cardMetrics.includes("cache") && provider.cacheHitPercent !== null
      ? { label: "Cache", value: percent(provider.cacheHitPercent) }
      : null,
    // Historical TTFT/tok/s/error aggregates are intentionally absent until
    // they are persisted by the telemetry layer. Never synthesize them here.
  ].filter((item): item is { label: string; value: string } => item !== null);

  return (
    <article className={`usage-provider-card ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="usage-provider-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ProviderLogo
          providerID={provider.id}
          providerName={provider.label}
          className="usage-provider-card-logo"
        />
        <span className="usage-provider-identity">
          <strong>{provider.label}</strong>
          <span>{snapshot?.accountLabel || (profile.billing === "subscription" ? "Subscription" : "API")}</span>
          <small>
            {profile.billing === "subscription" ? "Subscription" : "API"}
            <i className={statusState} aria-hidden="true" />
            <span className={statusState}>{status}</span>
          </small>
        </span>
        <span className="usage-provider-headline">
          {headlinePercent !== null && <strong>{headlinePercent}%</strong>}
          {profile.billing === "api" && profile.monthlyBudget && profile.monthlyBudget > 0
            ? <small>{money(provider.monthCost)} / {money(profile.monthlyBudget)}</small>
            : primaryReset !== undefined
              ? <small title={fullResetTitle(primaryReset)}>{formatQuotaReset(primaryReset)}</small>
              : null}
        </span>
        <ChevronRightIcon className="usage-provider-chevron" aria-hidden="true" />
      </button>

      {primaryMetrics.length > 0 && (
        <div className="usage-provider-metrics primary">
          {primaryMetrics.map((item) => <Metric key={item.label} {...item} />)}
        </div>
      )}
      {secondaryMetrics.length > 0 && (
        <div className="usage-provider-metrics secondary">
          {secondaryMetrics.map((item) => <Metric key={item.label} {...item} />)}
        </div>
      )}

      {showQuotaDetails && (quotaWindows.length > 0 || (profile.billing === "api" && profile.monthlyBudget)) && (
        <div className="usage-provider-quotas">
          {(expanded ? sortedQuotaWindows : collapsedWindows).map((window) => (
            <QuotaRow key={window.id} window={window} />
          ))}
          {profile.billing === "api" && profile.monthlyBudget !== null && profile.monthlyBudget > 0 && (
            <BudgetRow spent={provider.monthCost} budget={profile.monthlyBudget} />
          )}
        </div>
      )}

      {expanded && (
        <div className="usage-provider-details">
          <section className="usage-detail-section">
            <h4>Efficiency</h4>
            <div className="usage-detail-grid">
              <Metric
                label="Avg tokens / session"
                value={provider.sessions > 0 ? fmtTokens(provider.tokens / provider.sessions) : "—"}
              />
              <Metric
                label="Avg cost / session"
                value={provider.sessions > 0 ? money(provider.cost / provider.sessions) : "—"}
              />
              <Metric
                label="Cost / 1M tokens"
                value={provider.tokens > 0 ? money(provider.cost / provider.tokens * 1_000_000) : "—"}
              />
              {profile.billing === "subscription" && showValueMultiplier && valueMultiplier !== null && (
                <Metric label="Value this month" value={`${valueMultiplier.toFixed(1)}×`} hint="API equiv. / plan" />
              )}
            </div>
          </section>

          <section className="usage-detail-section">
            <h4>Token composition</h4>
            <div className="usage-detail-grid">
              <Metric label="Input" value={fmtTokens(provider.tokenBreakdown.input)} />
              <Metric label="Output" value={fmtTokens(provider.tokenBreakdown.output)} />
              {provider.tokenBreakdown.reasoning > 0 && (
                <Metric label="Reasoning" value={fmtTokens(provider.tokenBreakdown.reasoning)} />
              )}
              {provider.tokenBreakdown.cacheRead > 0 && (
                <Metric label="Cache read" value={fmtTokens(provider.tokenBreakdown.cacheRead)} />
              )}
              {provider.tokenBreakdown.cacheWrite > 0 && (
                <Metric label="Cache write" value={fmtTokens(provider.tokenBreakdown.cacheWrite)} />
              )}
            </div>
          </section>

          <CompositionBars title="Top models" items={provider.composition.models} metric={metric} />
          <CompositionBars title="By harness" items={provider.composition.harnesses} metric={metric} />
          {provider.composition.projects.length > 1 && (
            <CompositionBars title="By project" items={provider.composition.projects} metric={metric} />
          )}
        </div>
      )}
    </article>
  );
}

const palette = (): string[] => {
  if (typeof document === "undefined") return ["#777"];
  const style = getComputedStyle(document.documentElement);
  return ["--accent", "--purple", "--blue", "--green", "--amber", "--text-dim"]
    .map((name) => style.getPropertyValue(name).trim())
    .filter(Boolean);
};

function UsageTimeChart({
  labels,
  series,
  metric,
  style,
  showLegend,
}: {
  labels: readonly string[];
  series: readonly { id: string; label: string; values: number[] }[];
  metric: UsageChartMetric;
  style: "bar" | "line";
  showLegend: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const colors = palette();
    const visible = series.slice(0, 6);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
      || document.documentElement.dataset.reduceAnimations === "true";
    const chart = new Chart(canvas, {
      type: style,
      data: {
        labels: [...labels],
        datasets: visible.map((item, index) => ({
          label: item.label,
          data: item.values,
          borderColor: colors[index % colors.length],
          backgroundColor: colors[index % colors.length],
          borderWidth: style === "line" ? 2 : 0,
          pointRadius: 0,
          tension: style === "line" ? .25 : 0,
          borderRadius: style === "bar" ? 3 : 0,
          maxBarThickness: 28,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 180 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: showLegend, position: "bottom", labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const value = Number(ctx.raw ?? 0);
                const formatted = metric === "cost" ? money(value) : metric === "tokens" ? fmtTokens(value) : formatNumber(value);
                return `${ctx.dataset.label}: ${formatted}`;
              },
            },
          },
        },
        scales: {
          x: { stacked: style === "bar", grid: { display: false }, ticks: { maxTicksLimit: 8 } },
          y: {
            stacked: style === "bar",
            beginAtZero: true,
            grid: { color: "rgba(127,127,127,.12)" },
            ticks: {
              callback: (value) => metric === "cost"
                ? money(Number(value))
                : metric === "tokens" ? fmtTokens(Number(value)) : compactNumber(Number(value)),
            },
          },
        },
      },
    } as ChartConfiguration);
    return () => chart.destroy();
  }, [labels, metric, series, showLegend, style]);

  return <canvas ref={canvasRef} aria-label="Usage over time chart" role="img" />;
}

const dimensionLabel = (dimension: UsageDimension): string =>
  dimension === "provider" ? "Provider" : dimension === "model" ? "Model" : dimension === "harness" ? "Harness" : "Project";

function Segmented<T extends string>({
  value,
  values,
  onChange,
  label,
}: {
  value: T;
  values: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="usage-segmented" role="group" aria-label={label}>
      {values.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Overview({
  data,
  prefs,
}: {
  data: ReturnType<typeof buildUsageDashboardData>;
  prefs: ReturnType<typeof useUsagePrefs>;
}) {
  const metric = prefs.dashboard.chartMetric;
  const grouping = prefs.dashboard.chartGrouping;
  const distributionGrouping = prefs.dashboard.distributionGrouping;
  const series = data.chart.byDimension[grouping][metric];
  const consumers = data.consumers[distributionGrouping];
  const consumerValues = consumers.map((item) =>
    metric === "cost" ? item.cost : metric === "sessions" ? item.sessions : item.tokens);
  const total = consumerValues.reduce((sum, value) => sum + value, 0);
  const max = Math.max(0, ...consumerValues);
  const rangeLabel = prefs.dashboard.rangeMode === "custom" && prefs.dashboard.customRange
    ? `${prefs.dashboard.customRange.start} – ${prefs.dashboard.customRange.end}`
    : `${prefs.dashboard.rangeDays} days`;

  return (
    <div className="usage-overview">
      <div className="usage-summary-strip">
        <Metric label="Spend" value={money(data.totals.cost)} />
        <Metric label="Tokens" value={fmtTokens(data.totals.tokens)} />
        <Metric label="Sessions" value={compactNumber(data.totals.sessions)} />
        {data.totals.cacheHitPercent !== null && (
          <Metric label="Cache" value={percent(data.totals.cacheHitPercent)} />
        )}
      </div>

      {!prefs.hiddenBlocks.includes("usage-trend") && (
        <section className="usage-analytic-card">
          <header>
            <div>
              <h3>Usage over time</h3>
              <p>{rangeLabel}</p>
            </div>
            <div className="usage-chart-controls">
              <Segmented
                label="Usage metric"
                value={metric}
                values={[
                  { value: "cost", label: "Cost" },
                  { value: "tokens", label: "Tokens" },
                  { value: "sessions", label: "Sessions" },
                ]}
                onChange={(chartMetric) => setUsageDashboardPrefs({ chartMetric })}
              />
              <Segmented
                label="Usage grouping"
                value={grouping}
                values={[
                  { value: "provider", label: "Provider" },
                  { value: "model", label: "Model" },
                  { value: "harness", label: "Harness" },
                  { value: "project", label: "Project" },
                ]}
                onChange={(chartGrouping) => setUsageDashboardPrefs({ chartGrouping })}
              />
            </div>
          </header>
          <div className="usage-time-chart">
            {series.length > 0
              ? <UsageTimeChart
                  labels={data.chart.labels}
                  series={series}
                  metric={metric}
                  style={prefs.dashboard.chartStyle}
                  showLegend={prefs.dashboard.showChartLegend}
                />
              : <p className="usage-chart-empty">No usage in this range.</p>}
          </div>
        </section>
      )}

      {!prefs.hiddenBlocks.includes("distribution") && (
        <section className="usage-analytic-card usage-distribution">
          <header>
            <div>
              <h3>Top consumers</h3>
              <p>Where {metric === "sessions" ? "sessions" : metric} are going.</p>
            </div>
            <Segmented
              label="Top consumers grouping"
              value={distributionGrouping}
              values={[
                { value: "model", label: "Model" },
                { value: "provider", label: "Provider" },
                { value: "harness", label: "Harness" },
                { value: "project", label: "Project" },
              ]}
              onChange={(next) => setUsageDashboardPrefs({ distributionGrouping: next })}
            />
          </header>
          <div className="usage-distribution-list">
            {consumers.slice(0, 7).map((item, index) => {
              const value = consumerValues[index] ?? 0;
              const share = total > 0 ? value / total * 100 : 0;
              return (
                <div className="usage-distribution-row" key={item.id}>
                  <span title={item.label}>{item.label}</span>
                  <div className="usage-distribution-track">
                    <i style={{ width: `${max > 0 ? value / max * 100 : 0}%` }} />
                  </div>
                  <strong>{Math.round(share)}%</strong>
                </div>
              );
            })}
            {consumers.length === 0 && <p className="usage-chart-empty">No usage in this range.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function CustomRangePopover({
  anchorRef,
  open,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
}) {
  const prefs = useUsagePrefs();
  const fallbackEnd = Date.now();
  const fallbackStart = fallbackEnd - (prefs.dashboard.rangeDays - 1) * 24 * 60 * 60_000;
  const [start, setStart] = useState(prefs.dashboard.customRange?.start ?? dateOnly(fallbackStart));
  const [end, setEnd] = useState(prefs.dashboard.customRange?.end ?? dateOnly(fallbackEnd));
  const valid = rangeDate(start) !== null && rangeDate(end) !== null && start <= end;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} align="end">
      <div className="usage-custom-range-popover">
        <label>
          <span>From</span>
          <TextInput type="date" value={start} onChange={(event) => setStart(event.currentTarget.value)} />
        </label>
        <label>
          <span>To</span>
          <TextInput type="date" value={end} onChange={(event) => setEnd(event.currentTarget.value)} />
        </label>
        <Button
          size="sm"
          variant="primary"
          disabled={!valid}
          onClick={() => {
            if (!valid) return;
            setUsageDashboardPrefs({ rangeMode: "custom", customRange: { start, end } });
            onClose();
          }}
        >
          Apply
        </Button>
      </div>
    </Popover>
  );
}

const providerSort = (
  providers: readonly UsageProviderSummary[],
  sort: string,
  manualOrder: readonly string[],
): UsageProviderSummary[] => {
  if (sort === "manual") return orderUsageBlocks(providers, manualOrder, (provider) => provider.id);
  return [...providers].sort((a, b) => {
    if (sort === "name") return a.label.localeCompare(b.label);
    if (sort === "spend") return b.cost - a.cost || b.tokens - a.tokens;
    if (sort === "usage") return b.tokens - a.tokens || b.sessions - a.sessions;
    const aq = a.quotaUsedPercent ?? -1;
    const bq = b.quotaUsedPercent ?? -1;
    return bq - aq || b.cost - a.cost || b.tokens - a.tokens;
  });
};

export function UsageDashboard(): ReactNode {
  const viewTabsId = useId();
  const sessions = useStore((state) => state.sessions);
  const projectRegistry = useStore((state) => state.projectRegistry);
  const {
    snapshots,
    reload,
    refreshAll: refreshQuotaFeeds,
    loading: quotaLoading,
    error: quotaError,
  } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const [refreshing, setRefreshing] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const customAnchorRef = useRef<HTMLButtonElement>(null);

  const projectLabels = useMemo(
    () => Object.fromEntries(projectRegistry.projects.map((project) => [project.id, project.name])),
    [projectRegistry.projects],
  );
  const range = resolvedRange(
    prefs.dashboard.rangeMode,
    prefs.dashboard.rangeDays,
    prefs.dashboard.customRange,
  );
  const data = useMemo(
    () => buildUsageDashboardData(sessions, snapshots, range, Date.now(), projectLabels),
    [projectLabels, range, sessions, snapshots],
  );
  const visibleProviders = providerSort(
    data.providers.filter((provider) => !prefs.hiddenProviders.includes(provider.id)),
    prefs.dashboard.providerSort,
    prefs.dashboard.providerOrder,
  );

  const refreshAll = async (): Promise<void> => {
    if (refreshing || quotaLoading) return;
    setRefreshing(true);
    try {
      await refreshQuotaFeeds();
    } finally {
      setRefreshing(false);
    }
  };
  const quotaBusy = quotaLoading || refreshing;
  const openUsageSettings = () =>
    window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "usage" }));

  const selectPreset = (days: UsageRangeDays): void =>
    setUsageDashboardPrefs({ rangeDays: days, rangeMode: "preset" });

  return (
    <div className={`usage-dashboard usage-density-${prefs.dashboard.layout}`}>
      <div className="usage-dashboard-toolbar">
        <Tabs
          idBase={viewTabsId}
          className="usage-view-tabs"
          value={prefs.dashboard.view}
          onChange={(value) => setUsageDashboardPrefs({
            view: value === "overview" ? "overview" : "providers",
          })}
          tabs={[
            { id: "providers", label: "Providers" },
            { id: "overview", label: "Overview" },
          ]}
        />
        <div className="usage-toolbar-spacer" />
        <div className="usage-range-switch" aria-label="Usage range">
          {([7, 30, 90] as const).map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={prefs.dashboard.rangeMode === "preset" && prefs.dashboard.rangeDays === days}
              onClick={() => selectPreset(days)}
            >
              {days}d
            </button>
          ))}
          <button
            ref={customAnchorRef}
            type="button"
            aria-pressed={prefs.dashboard.rangeMode === "custom"}
            onClick={() => setCustomOpen((value) => !value)}
          >
            Custom
          </button>
        </div>
        <div className="usage-toolbar-actions">
          <IconButton icon={SettingsIcon} label="Usage settings" title="Usage settings" onClick={openUsageSettings} />
          <IconButton
            icon={RefreshIcon}
            className={quotaBusy ? "refreshing" : undefined}
            label={quotaBusy ? "Refreshing quota feeds" : "Refresh quota feeds"}
            title={quotaBusy ? "Refreshing quota feeds" : "Refresh quota feeds"}
            disabled={quotaBusy}
            onClick={() => void refreshAll()}
          />
        </div>
      </div>

      <CustomRangePopover anchorRef={customAnchorRef} open={customOpen} onClose={() => setCustomOpen(false)} />

      {quotaError && (
        <div className="usage-quota-alert" role="alert">
          <span><strong>Quota feeds unavailable.</strong> Session usage remains available.</span>
          <Button size="sm" busy={quotaBusy} onClick={() => void reload()}>Retry</Button>
        </div>
      )}

      <TabPanel idBase={viewTabsId} tabId="providers" active={prefs.dashboard.view === "providers"}>
        <div className="usage-dashboard-content" data-usage-view="providers">
          <div className="usage-provider-list">
            {visibleProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                profile={profileFor(provider, prefs.providerCosts)}
                cardMetrics={prefs.dashboard.cardMetrics}
                showApiEquivalent={prefs.dashboard.showApiEquivalent}
                showValueMultiplier={prefs.dashboard.showValueMultiplier}
                showQuotaDetails={prefs.dashboard.showQuotaDetails}
                metric={prefs.dashboard.chartMetric}
              />
            ))}
            {visibleProviders.length === 0 && (
              <div className="usage-empty">
                <strong>No visible providers</strong>
                <span>Usage providers appear after session activity or a quota feed. Check Usage settings if providers are hidden.</span>
              </div>
            )}
          </div>
        </div>
      </TabPanel>

      <TabPanel idBase={viewTabsId} tabId="overview" active={prefs.dashboard.view === "overview"}>
        <div className="usage-dashboard-content" data-usage-view="overview">
          <Overview data={data} prefs={prefs} />
        </div>
      </TabPanel>
    </div>
  );
}
