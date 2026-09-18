import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import Chart from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import { fmtTokens } from "../../../../apps/web/src/format.ts";
import { getLocale, tr } from "../../../../apps/web/src/i18n/index.ts";
import { Icon } from "../../../../apps/web/src/icons.tsx";
import { useStore } from "../../../../apps/web/src/store.ts";
import {
  moveUsageBlock,
  orderPinnedUsageBlocks,
  orderUsageBlocks,
  setBlockHidden,
  setProviderHidden,
  setProviderPinned,
  setUsageDashboardPrefs,
  useUsagePrefs,
} from "../usagePrefs.ts";
import ProviderLogo from "../../../models/widgets/ProviderLogo.tsx";
import { fmtQuota, useQuotaSnapshots } from "./quotaUi.tsx";
import {
  AddIcon,
  Button,
  ChevronRightIcon,
  DragHandleIcon,
  EditIcon,
  EmptyState,
  HideIcon,
  ShowIcon,
  IconButton,
  PinIcon,
  RefreshIcon,
  SettingsIcon,
  TabPanel,
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
  provider.id;

interface SortableBlock {
  id: string;
  label: string;
  content: ReactNode;
  className?: string;
  hidden?: boolean;
}

export function SortableBlocks({
  blocks,
  order,
  onChange,
  className,
  pinnedIds = [],
  editing = false,
  onHiddenChange,
}: {
  blocks: SortableBlock[];
  order: string[];
  onChange: (order: string[]) => void;
  className: string;
  pinnedIds?: readonly string[];
  editing?: boolean;
  onHiddenChange?: (id: string, hidden: boolean) => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rectsRef = useRef<Map<string, DOMRect> | null>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPending = useRef<{ id: string; x: number; y: number; pointerId: number } | null>(null);
  const sorted = pinnedIds.length > 0
    ? orderPinnedUsageBlocks(blocks, order, pinnedIds, (block) => block.id)
    : orderUsageBlocks(blocks, order, (block) => block.id);
  const ids = sorted.map((block) => block.id);
  const move = (id: string, to: string | number) => {
    snapshotRects();
    const next = moveUsageBlock(ids, id, to);
    onChange(pinnedIds.length > 0
      ? orderPinnedUsageBlocks(next, next, pinnedIds, (item) => item)
      : next);
  };
  const clearTouch = () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
    touchTimer.current = null;
    touchPending.current = null;
    setDragged(null);
  };
  useEffect(() => () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
  }, []);
  // FLIP: snapshot positions before React reorders, then animate each card
  // from its old slot to the new one (iOS-style smooth reorder).
  useLayoutEffect(() => {
    const rects = rectsRef.current;
    rectsRef.current = null;
    if (!rects) return;
    const root = containerRef.current;
    if (!root) return;
    for (const child of root.children) {
      const id = (child as HTMLElement).dataset.usageBlock;
      const previous = id ? rects.get(id) : undefined;
      if (!previous) continue;
      const delta = previous.top - child.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      if (typeof child.animate !== "function" || typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) continue;
      child.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  });
  const snapshotRects = () => {
    const root = containerRef.current;
    if (!root) return;
    rectsRef.current = new Map([...root.children].map((child) => {
      const element = child as HTMLElement;
      return [element.dataset.usageBlock ?? "", element.getBoundingClientRect()];
    }));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string) => {
    if (!editing || event.pointerType !== "touch" || (event.target as Element).closest("button,a,input,select,textarea")) return;
    touchPending.current = { id, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    const target = event.currentTarget;
    touchTimer.current = setTimeout(() => {
      target.setPointerCapture(event.pointerId);
      setDragged(id);
    }, 280);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!editing) return;
    const pending = touchPending.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!dragged && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) {
      clearTouch();
      return;
    }
    if (!dragged) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-usage-block]");
    if (target?.dataset.usageBlock && target.dataset.usageBlock !== dragged) move(dragged, target.dataset.usageBlock);
  };
  return (
    <div className={className} ref={containerRef}>
      {sorted.filter((block) => editing || !block.hidden).map((block) => (
        <div
          className={`usage-sortable-item${block.className ? ` ${block.className}` : ""}${dragged === block.id ? " dragging" : ""}${editing && block.hidden ? " usage-block-hidden" : ""}`}
          key={block.id}
          data-usage-block={block.id}
          draggable={editing}
          tabIndex={editing ? 0 : undefined}
          role={editing ? "group" : undefined}
          aria-label={editing ? block.label : undefined}
          aria-roledescription={editing ? tr("usage.usagedashboard.sortableDashboardBlock") : undefined}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if ((event.target as Element).closest("button,a,input,select,textarea")) return;
            if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            move(block.id, event.key === "ArrowUp" ? -1 : 1);
          }}
          onDragStart={(event) => {
            if ((event.target as Element).closest("button,a,input,select,textarea")) {
              event.preventDefault();
              return;
            }
            snapshotRects();
            setDragged(block.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", block.id);
          }}
          onDragEnd={() => setDragged(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (dragged) move(dragged, block.id);
            setDragged(null);
          }}
          onPointerDown={(event) => onPointerDown(event, block.id)}
          onPointerMove={onPointerMove}
          onPointerUp={clearTouch}
          onPointerCancel={clearTouch}
        >
          {editing && (
            <div className="usage-block-edit-bar">
              <span className="usage-block-grip" aria-hidden="true"><DragHandleIcon /></span>
              <IconButton
                icon={block.hidden ? ShowIcon : HideIcon}
                size="sm"
                pressed={block.hidden}
                label={block.hidden
                  ? tr("usage.usagedashboard.showValueInBreakdowns", { label: block.label })
                  : tr("usage.usagedashboard.hideValueInBreakdowns", { label: block.label })}
                onClick={() => {
                  snapshotRects();
                  onHiddenChange?.(block.id, !block.hidden);
                }}
              />
            </div>
          )}
          {block.content}
        </div>
      ))}
    </div>
  );
}

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

export const formatQuotaReset = (resetsAt: number): string =>
  tr("usage.usagedashboard.resetsValue", {
    value: new Date(resetsAt).toLocaleString(getLocale()),
  });

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

const chartPalette = (element: Element): string[] => {
  const style = getComputedStyle(element);
  return ["--accent", "--green", "--blue", "--purple", "--amber"].map(
    (token) => style.getPropertyValue(token).trim() || style.getPropertyValue("--text").trim(),
  );
};

function UsageSeriesChart({
  labels,
  series,
  metric,
  chartStyle,
}: {
  labels: string[];
  series: UsageChartSeries[];
  metric: UsageChartMetric;
  chartStyle: "bar" | "line";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const style = getComputedStyle(canvas);
    const colors = chartPalette(canvas);
    const textColor = style.getPropertyValue("--muted").trim();
    const gridColor = style.getPropertyValue("--border-soft").trim();
    const reduceMotion = typeof matchMedia === "function"
      && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const formatAxis = (value: number) => metric === "cost"
      ? formatChartMoney(value)
      : metric === "tokens"
        ? fmtTokens(Math.round(value))
        : String(Math.round(value));
    const config = {
      type: chartStyle,
      data: {
        labels,
        datasets: series.map((item, index) => ({
          label: item.label,
          data: item.values,
          backgroundColor: colors[index % colors.length],
          borderColor: colors[index % colors.length],
          borderWidth: chartStyle === "line" ? 2 : 0,
          borderRadius: chartStyle === "bar" ? 4 : undefined,
          pointRadius: chartStyle === "line" ? 1.5 : 0,
          pointHoverRadius: chartStyle === "line" ? 4 : 0,
          tension: chartStyle === "line" ? .32 : 0,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduceMotion ? false : { duration: 220 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) =>
                `${context.dataset.label ?? ""}: ${formatAxis(context.parsed.y ?? 0)}`,
            },
          },
        },
        scales: {
          x: {
            stacked: chartStyle === "bar",
            border: { display: false },
            grid: { display: false },
            ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
          },
          y: {
            stacked: chartStyle === "bar",
            beginAtZero: true,
            border: { display: false },
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              maxTicksLimit: 5,
              callback: (value: string | number) => formatAxis(Number(value)),
            },
          },
        },
      },
    } as ChartConfiguration;
    const chart = new Chart(canvas, config);
    return () => chart.destroy();
  }, [chartStyle, labels, metric, series]);

  return <canvas ref={canvasRef} aria-hidden="true" />;
}

function CohortChart({
  labels,
  series,
  metric,
  chartStyle,
  emptyTitle,
  emptyText,
}: {
  labels: string[];
  series: UsageChartSeries[];
  metric: UsageChartMetric;
  chartStyle: "bar" | "line";
  emptyTitle: string;
  emptyText: string;
}) {
  const populated = series.some((item) => item.values.some((value) => value > 0));
  const metricLabel = metric === "cost"
    ? tr("usage.usagedashboard.cost")
    : metric === "tokens"
      ? tr("usage.usagedashboard.tokens")
      : tr("usage.usagedashboard.sessions");
  const formatAxis = (value: number) => metric === "cost"
    ? formatChartMoney(value)
    : metric === "tokens"
      ? fmtTokens(Math.round(value))
      : String(Math.round(value));

  return (
    <div className="usage-cohort-chart">
      {populated && (
        <UsageSeriesChart
          labels={labels}
          series={series}
          metric={metric}
          chartStyle={chartStyle}
        />
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
  metric,
  chartStyle,
  showLegend,
  onMetricChange,
}: {
  data: ReturnType<typeof buildUsageDashboardData>;
  visibleProviderIds: ReadonlySet<string>;
  hiddenCount: number;
  metric: UsageChartMetric;
  chartStyle: "bar" | "line";
  showLegend: boolean;
  onMetricChange: (metric: UsageChartMetric) => void;
}) {
  const visibleSeries = data.chart[metric].filter((item) => visibleProviderIds.has(item.providerId));
  const series = collapseChartSeries(visibleSeries);
  const hiddenActivity = hiddenCount > 0 && data.chart[metric].some(
    (item) => !visibleProviderIds.has(item.providerId) && item.values.some((value) => value > 0),
  );
  return (
    <article className="usage-dashboard-card usage-time-card">
      <SectionHeading
        title={tr("usage.usagedashboard.usageOverTime")}
        description={tr("usage.usagedashboard.sessionTotalsGroupedByLastActivity")}
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
            onChange={(value) => onMetricChange(value as UsageChartMetric)}
          />
        )}
      />
      <CohortChart
        labels={data.chart.labels}
        series={series}
        metric={metric}
        chartStyle={chartStyle}
        emptyTitle={hiddenActivity ? tr("usage.usagedashboard.allActivityIsHidden") : tr("usage.usagedashboard.noSessionsLastActiveIn")}
        emptyText={hiddenActivity
          ? tr("usage.usagedashboard.showAProviderToIncludeIts")
          : tr("usage.usagedashboard.cohortsFillInAsSessions")}
      />
      <p className="usage-chart-method">
        {tr("usage.usagedashboard.eachSessionAppearsOnceInBucket")}
      </p>
      {showLegend && (
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
      )}
    </article>
  );
}

interface SpendEntry {
  id: string;
  label: string;
  cost: number;
  providerId?: string;
}

function UsageDoughnutChart({ entries }: { entries: SpendEntry[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || entries.length === 0) return;
    const colors = chartPalette(canvas);
    const reduceMotion = typeof matchMedia === "function"
      && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const config = {
      type: "doughnut",
      data: {
        labels: entries.map((entry) => entry.label),
        datasets: [{
          data: entries.map((entry) => entry.cost),
          backgroundColor: entries.map((_, index) => colors[index % colors.length]),
          borderWidth: 0,
          hoverOffset: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "72%",
        animation: reduceMotion ? false : { duration: 220 },
        plugins: { legend: { display: false } },
      },
    } as ChartConfiguration;
    const chart = new Chart(canvas, config);
    return () => chart.destroy();
  }, [entries]);

  return <canvas ref={canvasRef} aria-hidden="true" />;
}

function ProviderSpendDonut({
  providers,
  onViewProviders,
  hiddenSpend,
  showLegend,
}: {
  providers: UsageProviderSummary[];
  onViewProviders: () => void;
  hiddenSpend: boolean;
  showLegend: boolean;
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
      <div className={`usage-spend-content${showLegend ? "" : " no-legend"}`}>
        <div className="usage-spend-donut" role="img" aria-label={tr("usage.usagedashboard.providerSpendTotalingValue", { total: formatMoney(total) })}>
          {featured.length > 0 && <UsageDoughnutChart entries={featured} />}
          <div><span>{tr("usage.usagedashboard.totalSpend")}</span><strong>{formatMoney(total)}</strong></div>
        </div>
        {showLegend && (
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
              <div className="usage-inline-empty" role="status">
                <strong>{hiddenSpend ? tr("usage.usagedashboard.allSpendIsHidden") : tr("usage.usagedashboard.noSpendRecorded")}</strong>
                <span>{hiddenSpend
                  ? tr("usage.usagedashboard.showAProviderToIncludeSpend")
                  : tr("usage.usagedashboard.costAppearsWhenTheActive")}</span>
              </div>
            )}
          </div>
        )}
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
  pinnedProviders,
  order,
  onOrderChange,
  onAddProvider,
  onRefresh,
  quotaBusy,
}: {
  providers: UsageProviderSummary[];
  hiddenProviders: string[];
  pinnedProviders: string[];
  order: string[];
  onOrderChange: (order: string[]) => void;
  onAddProvider: () => void;
  onRefresh: (providerId: string) => void | Promise<void>;
  quotaBusy: boolean;
}) {
  const prefs = useUsagePrefs();
  return (
    <div className="usage-provider-view">
      {providers.length > 0 ? <SortableBlocks
        className="usage-provider-detail-grid"
        order={order}
        pinnedIds={pinnedProviders}
        onChange={onOrderChange}
        blocks={[...providers.map((provider, index) => {
          const preferenceId = providerPreferenceId(provider);
          const hidden = hiddenProviders.includes(preferenceId);
          const pinned = pinnedProviders.includes(preferenceId);
          const costProfile = prefs.providerCosts[preferenceId] ?? { billing: "api" as const, monthlyCost: null };
          return {
            id: provider.id,
            label: provider.label,
            content: (
            <article className={`usage-provider-detail-card${pinned ? " pinned" : ""}`} key={provider.id} style={cssVar("--provider-accent", seriesAccent(index))}>
              <header>
                <ProviderLogo
                  providerID={provider.id}
                  providerName={provider.label}
                  className="usage-provider-mark usage-provider-mark-large"
                />
                <div className="usage-provider-title">
                  <h3>{provider.label}</h3>
                  <p title={provider.snapshot?.accountLabel ?? provider.id}>{provider.snapshot?.accountLabel ?? provider.id}</p>
                </div>
                <div className="usage-provider-badges">
                  <span className={`usage-billing-pill ${costProfile.billing}`}>
                    {costProfile.billing === "subscription" ? "Subscription" : "API usage"}
                  </span>
                  <ProviderStatus provider={provider} />
                </div>
                <IconButton
                  icon={PinIcon}
                  size="sm"
                  className="usage-provider-pin"
                  pressed={pinned}
                  label={pinned
                    ? tr("usage.usagedashboard.unpinValue", { value: provider.label })
                    : tr("usage.usagedashboard.pinValueToTop", { value: provider.label })}
                  onClick={() => setProviderPinned(preferenceId, !pinned)}
                />
              </header>
              {provider.stale && provider.snapshot?.error?.message && (
                <div className="usage-provider-error" role="status">
                  <Icon.usage />
                  <span>{provider.snapshot.error.message}</span>
                </div>
              )}
              <div className={`usage-provider-detail-stats${costProfile.billing === "subscription" ? " has-plan" : ""}`}>
                <div><span>{costProfile.billing === "subscription" ? "Spent" : tr("usage.usagedashboard.spend")}</span><strong>{formatMoney(provider.cost)}</strong></div>
                <div><span>{tr("usage.usagedashboard.tokens")}</span><strong>{fmtTokens(provider.tokens)}</strong></div>
                <div><span>{tr("usage.usagedashboard.sessions")}</span><strong>{provider.sessions.toLocaleString(getLocale())}</strong></div>
                {costProfile.billing === "subscription" && (
                  <div className="usage-provider-plan-stat">
                    <span>Plan</span>
                    <strong>{costProfile.monthlyCost === null ? "Set price" : `${formatMoney(costProfile.monthlyCost)}/mo`}</strong>
                  </div>
                )}
              </div>
              <div className="usage-provider-windows">
                {provider.snapshot?.windows.map((quota) => {
                  const used = quota.limit > 0 ? Math.min(1, quota.used / quota.limit) : 0;
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
                      <p>{quota.resetsAt !== undefined ? formatQuotaReset(quota.resetsAt) : tr("usage.usagedashboard.liveQuotaUsage")}</p>
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
            ),
          };
        }), {
          id: "provider-summary",
          label: tr("usage.usagedashboard.providerActivity"),
          className: "usage-provider-summary-block",
          content: (
            <section className="usage-provider-view-intro">
              <div><span>{tr("usage.usagedashboard.discovered")}</span><strong>{providers.length}</strong></div>
              <div><span>{tr("usage.usagedashboard.freshFeeds")}</span><strong>{providers.filter((provider) => provider.snapshot && !provider.stale).length}</strong></div>
              <div><span>{tr("usage.usagedashboard.visible")}</span><strong>{providers.filter((provider) => !hiddenProviders.includes(providerPreferenceId(provider))).length}</strong></div>
              <Button size="sm" variant="primary" iconStart={AddIcon} onClick={onAddProvider}>{tr("usage.usagedashboard.addProvider")}</Button>
            </section>
          ),
        }]}
      /> : (
        <EmptyState
          variant="panel"
          title={tr("usage.usagedashboard.connectYourFirstProvider")}
          description={tr("usage.usagedashboard.polythDiscoversQuotaSources")}
          actionLabel={tr("usage.usagedashboard.openProviderSettings")}
          onAction={onAddProvider}
        />
      )}
    </div>
  );
}

export function UsageDashboard(): ReactNode {
  const viewTabsId = useId();
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
  const { view, layout, rangeDays, chartStyle, chartMetric, showChartLegend } = prefs.dashboard;
  const setView = (next: "overview" | "providers") =>
    setUsageDashboardPrefs({ view: next });
  const setLayout = (next: "expanded" | "compact") =>
    setUsageDashboardPrefs({ layout: next });
  const setRangeDays = (next: UsageRangeDays) =>
    setUsageDashboardPrefs({ rangeDays: next });
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const data = useMemo(
    () => buildUsageDashboardData(projectSessions, snapshots, rangeDays),
    [projectSessions, rangeDays, snapshots],
  );
  const visibleProviders = data.providers.filter(
    (provider) => !prefs.hiddenProviders.includes(providerPreferenceId(provider)),
  );
  const orderedVisibleProviders = orderPinnedUsageBlocks(
    visibleProviders,
    prefs.dashboard.providerOrder,
    prefs.pinnedProviders,
    (provider) => providerPreferenceId(provider),
  );
  const visibleProviderIds = new Set(visibleProviders.map((provider) => provider.id));
  const hiddenCount = data.providers.length - visibleProviders.length;
  const allProvidersHidden = data.providers.length > 0 && visibleProviders.length === 0;
  const tokenSeries = aggregateSeries(data.chart.tokens, data.chart.labels.length);
  const costSeries = aggregateSeries(data.chart.cost, data.chart.labels.length);
  const sessionSeries = aggregateSeries(data.chart.sessions, data.chart.labels.length);
  const averageSessionCost = data.totals.sessions > 0 ? data.totals.cost / data.totals.sessions : 0;
  const addProvider = () => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "models" }));
  const openUsageSettings = () => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "usage" }));
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
  const overviewBlocks: SortableBlock[] = [
    { id: "spend", label: tr("usage.usagedashboard.spend"), className: "usage-block-stat", content: <StatCard label={tr("usage.usagedashboard.spend")} value={formatMoney(data.totals.cost)} trend={data.trends.cost} icon="usage" tone="var(--accent)" detail={tr("usage.usagedashboard.valuePerSession2", { value: formatMoney(averageSessionCost) })} series={costSeries} /> },
    { id: "tokens", label: tr("usage.usagedashboard.tokens"), className: "usage-block-stat", content: <StatCard label={tr("usage.usagedashboard.tokens")} value={fmtTokens(data.totals.tokens)} trend={data.trends.tokens} icon="context" tone="var(--purple)" detail={data.models.length === 1 ? tr("usage.usagedashboard.oneModel") : tr("usage.usagedashboard.valueModels", { count: data.models.length })} series={tokenSeries} /> },
    { id: "sessions", label: tr("usage.usagedashboard.sessions"), className: "usage-block-stat", content: <StatCard label={tr("usage.usagedashboard.sessions")} value={data.totals.sessions.toLocaleString(getLocale())} trend={data.trends.sessions} icon="events" tone="var(--blue)" detail={visibleProviders.length === 1 ? tr("usage.usagedashboard.oneProviderShown") : tr("usage.usagedashboard.valueProvidersShown", { count: visibleProviders.length })} series={sessionSeries} /> },
    { id: "cache", label: tr("usage.usagedashboard.cacheHit"), className: "usage-block-stat", content: <StatCard label={tr("usage.usagedashboard.cacheHit")} value={`${Math.round(data.totals.cacheHitPercent)}%`} trend={null} icon="compare" tone="var(--green)" detail={tr("usage.usagedashboard.valueCached", { value: fmtTokens(data.totals.cacheRead) })} series={[]} /> },
    {
      id: "cohorts",
      label: tr("usage.usagedashboard.sessionCohortsByLatestTurn"),
      className: "usage-block-wide",
      content: <SessionCohorts
        data={data}
        visibleProviderIds={visibleProviderIds}
        hiddenCount={hiddenCount}
        metric={chartMetric}
        chartStyle={chartStyle}
        showLegend={showChartLegend}
        onMetricChange={(metric) => setUsageDashboardPrefs({ chartMetric: metric })}
      />,
    },
    {
      id: "cost-context",
      label: tr("usage.usagedashboard.costContext"),
      className: "usage-block-narrow",
      content: <CostPulse data={data} />,
    },
    {
      id: "provider-spend",
      label: tr("usage.usagedashboard.costByProvider"),
      className: "usage-block-half",
      content: <ProviderSpendDonut
        providers={visibleProviders}
        hiddenSpend={data.providers.some((provider) => !visibleProviderIds.has(provider.id) && provider.cost > 0)}
        showLegend={showChartLegend}
        onViewProviders={() => setView("providers")}
      />,
    },
    {
      id: "models",
      label: tr("usage.usagedashboard.modelBreakdown"),
      className: "usage-block-half",
      content: <ModelBreakdown models={data.models.filter((model) => visibleProviderIds.has(model.providerId))} hiddenActivity={data.models.some((model) => !visibleProviderIds.has(model.providerId))} />,
    },
    {
      id: "provider-activity",
      label: tr("usage.usagedashboard.providerActivity"),
      className: "usage-block-full",
      content: <ProviderTable providers={orderedVisibleProviders} allProvidersHidden={allProvidersHidden} />,
    },
    {
      id: "actions",
      label: tr("usage.usagedashboard.shapeThisDashboard"),
      className: "usage-block-full",
      content: <UsageActionStrip hiddenCount={hiddenCount} onProviders={() => setView("providers")} onAddProvider={addProvider} />,
    },
  ].map((block) => ({
    ...block,
    hidden: prefs.hiddenBlocks.includes(block.id),
  }));
  const hiddenBlockCount = overviewBlocks.filter((block) => block.hidden).length;

  return (
    <div
      className={`usage-dashboard usage-layout-${layout}`}
      data-layout={layout}
      aria-busy={quotaBusy}
    >
      <div className="usage-dashboard-toolbar">
        <Tabs
          className="usage-view-tabs"
          size="sm"
          idBase={viewTabsId}
          label={tr("usage.usagedashboard.usageView")}
          value={view}
          tabs={[
            { id: "overview", label: <><Icon.widgets /> {tr("usage.usagedashboard.overview")}</> },
            { id: "providers", label: <><Icon.list /> {tr("usage.usagedashboard.providers")}</> },
          ]}
          onChange={(value) => setView(value as typeof view)}
        />
        <span className="usage-toolbar-spacer" />
        <div className="usage-toolbar-controls">
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
            icon={EditIcon}
            className="usage-edit-toggle"
            pressed={editing}
            label={editing ? tr("usage.usagedashboard.editLayoutDone") : tr("usage.usagedashboard.editLayout")}
            title={editing ? tr("usage.usagedashboard.editLayoutDone") : tr("usage.usagedashboard.editLayoutHint")}
            onClick={() => setEditing((current) => !current)}
          />
          <IconButton
            icon={SettingsIcon}
            label="Usage settings"
            title="Usage settings"
            onClick={openUsageSettings}
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
      </div>

      {quotaError && (
        <div className="usage-quota-alert" role="alert">
          <Icon.usage />
          <span><strong>{tr("usage.usagedashboard.quotaFeedsCouldNotBe")}</strong> {tr("usage.usagedashboard.sessionTotalsRemainAvailable")} {quotaError}</span>
          <Button size="sm" busy={quotaBusy} onClick={() => void reload()}>{tr("common.retry")}</Button>
        </div>
      )}

      {editing && hiddenBlockCount > 0 && (
        <div className="usage-hidden-strip" role="note">
          <HideIcon />
          <span>{tr("usage.usagedashboard.hiddenBlocksValue", { count: hiddenBlockCount })}</span>
        </div>
      )}

      <TabPanel idBase={viewTabsId} tabId="overview" active={view === "overview"}>
        <div className="usage-dashboard-content" data-usage-view="overview">
          <SortableBlocks
            className="usage-overview-blocks"
            blocks={overviewBlocks}
            order={prefs.dashboard.overviewOrder}
            onChange={(overviewOrder) => setUsageDashboardPrefs({ overviewOrder })}
            editing={editing}
            onHiddenChange={(id, hidden) => setBlockHidden(id, hidden)}
          />
        </div>
      </TabPanel>
      <TabPanel idBase={viewTabsId} tabId="providers" active={view === "providers"}>
        <div className="usage-dashboard-content" data-usage-view="providers">
          <ProviderDetails
            providers={data.providers}
            hiddenProviders={prefs.hiddenProviders}
            pinnedProviders={prefs.pinnedProviders}
            order={prefs.dashboard.providerOrder}
            onOrderChange={(providerOrder) => setUsageDashboardPrefs({ providerOrder })}
            onAddProvider={addProvider}
            onRefresh={refresh}
            quotaBusy={quotaBusy}
          />
        </div>
      </TabPanel>
    </div>
  );
}
