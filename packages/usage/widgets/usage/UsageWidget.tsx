import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { SessionProjection } from "@polyth/contracts";
import type { WidgetRenderContext, WidgetSettingsContext } from "@polyth/web-sdk";
import { fmtCost, fmtMs, fmtTokens } from "../../../../apps/web/src/format.ts";
import { formatNumber, tr } from "../../../../apps/web/src/i18n/index.ts";
import { Button, Checkbox, EmptyState, Select } from "../../../../apps/web/src/components/ui/index.ts";
import { useSessionCache } from "../cacheUsage.ts";
import type { SessionContextDisplay } from "../contextUsage.ts";
import type { UsageAggregate, UsageStatsQuery, UsageStatsReport } from "../../src/analytics/contracts.ts";
import { cacheBurnDisplay, type CacheTone, type CacheWarmthDisplay } from "./cacheWarmth.ts";
import { formatBucketRange, formatBucketTick } from "./dashboardFormat.ts";
import { Figure } from "./Figure.tsx";
import { useMoreBelow } from "./scrollFade.ts";
import { useUsageStats } from "./usageStatsClient.ts";
import { usageWidgetBars, usageWidgetCompact, usageWidgetPreferences, type UsageWidgetScope } from "./widgetPresentation.ts";

const known = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: number | null | undefined, complete = true) =>
  known(value) ? `${complete ? "" : "≥"}${formatNumber(value)}` : "—";
const tokens = (value: number | null | undefined, complete = true) =>
  known(value) ? `${complete ? "" : "≥"}${fmtTokens(Math.round(value))}` : "—";
/**
 * Cost at a glance: cents below a thousand dollars, compact above (`$12.5K`).
 * Sub-cent totals keep enough digits not to read as zero. The exact amount
 * stays in the value's tooltip.
 */
const glanceCost = (value: number): string => value >= 1_000
  ? formatNumber(value, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 })
  : formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 4 : 2 });
const money = (value: number | null | undefined, complete = true) =>
  known(value) ? `${complete ? "" : "≥"}${glanceCost(value)}` : "—";
const rate = (value: number | null | undefined) => known(value)
  ? tr("usage.tokensPerSecond", { value: formatNumber(value, { maximumFractionDigits: 1 }) }) : "—";

/** A project's part of the scope's total in `[0, 1]`; unknown when either side is. */
const projectShare = (value: number | null | undefined, total: number | null | undefined): number | null =>
  known(value) && known(total) && total > 0 ? Math.min(1, value / total) : null;

const OPTIONAL_METRICS: ReadonlySet<string> = new Set(["response", "whole-turn", "ttft", "steps"]);

/**
 * Where a value sits on the ledger. The session card groups its supporting
 * values under quiet headings; Project and Global have one short row of totals.
 * `lead` values are the hero and the cache chip.
 */
type MetricGroup = "lead" | "spend" | "cache" | "timing" | "totals";

const GROUP_LABEL = {
  spend: "usage.spend",
  cache: "usage.cache",
  timing: "usage.timing",
} as const satisfies Partial<Record<MetricGroup, string>>;

interface Metric { id: string; label: string; value: string; group: MetricGroup; detail?: string; tone?: CacheTone; exact?: string }

function widgetMetrics(metrics: UsageAggregate | null, context?: SessionContextDisplay, warmth?: CacheWarmthDisplay): Metric[] {
  const session = !!context;
  return [
    ...(context ? [{ id: "context", label: tr("usage.context"), group: "lead" as const, value: context.value, ...(context.detail ? { detail: context.detail } : {}) }] : []),
    // The live countdown is the card's one actionable value: it sits beside the hero.
    ...(warmth ? [{ id: "cache-ttl", label: tr("usage.cacheWarmth"), group: "lead" as const, value: warmth.value, ...(warmth.tone ? { tone: warmth.tone } : {}) }] : []),
    ...(metrics ? [
      { id: "tokens", label: tr("usage.tokens"), group: session ? "spend" as const : "totals" as const, value: tokens(metrics.tokens.total, metrics.tokens.totalComplete) },
      {
        id: "cost", label: tr("usage.cost"), group: session ? "spend" as const : "totals" as const,
        value: money(metrics.cost, metrics.costComplete), ...(known(metrics.cost) ? { exact: fmtCost(metrics.cost) } : {}),
      },
      ...(session ? [{ id: "steps", label: tr("usage.steps"), group: "spend" as const, value: count(metrics.steps) }] : []),
      { id: "cache", label: tr("usage.cacheHit"), group: session ? "cache" as const : "totals" as const, value: known(metrics.cacheHitPercent) ? `${formatNumber(Math.round(metrics.cacheHitPercent))}%` : "—" },
    ] : []),
    // What the countdown protects: the cached prefix and how long it lives,
    // or, once expired, that the next turn writes it again.
    ...(warmth ? [{
      id: "cached", label: tr("usage.cached"), group: "cache" as const, value: warmth.cached,
      detail: warmth.state === "expired" ? tr("usage.cacheRewriteNextShort") : warmth.lifetime,
    }] : []),
    ...(metrics && session && metrics.cacheBurn ? [{ id: "cache-burn", label: tr("usage.cacheBurn"), group: "cache" as const, ...cacheBurnDisplay(metrics.cacheBurn) }] : []),
    ...(metrics ? session ? [
      { id: "response", label: tr("usage.response"), group: "timing" as const, value: rate(metrics.rates?.responseTokPerSec) },
      { id: "whole-turn", label: tr("usage.wholeTurn"), group: "timing" as const, value: rate(metrics.rates?.wholeTurnTokPerSec) },
      { id: "ttft", label: tr("usage.avgTtft"), group: "timing" as const, value: known(metrics.timing?.ttftMs) ? fmtMs(metrics.timing.ttftMs) : "—" },
    ] : [
      { id: "sessions", label: tr("usage.sessions"), group: "totals" as const, value: count(metrics.sessions) },
      { id: "turns", label: tr("usage.turns"), group: "totals" as const, value: count(metrics.turns, metrics.turnsComplete) },
    ] : []),
  ];
}

const valueTitle = (metric: Metric): string | undefined => metric.value === "—"
  ? tr("usage.widgetUnknown")
  : [metric.exact, metric.value.startsWith("≥") ? tr("usage.widgetIncomplete") : undefined].filter(Boolean).join(" · ") || undefined;

function MetricValue({ metric }: { metric: Metric }) {
  return <div data-usage-metric={metric.id} {...(metric.tone ? { "data-tone": metric.tone } : {})}>
    <dt>{metric.label}</dt>
    <dd title={valueTitle(metric)}>
      <strong><bdi><Figure value={metric.value} /></bdi></strong>
    </dd>
    {metric.detail ? <small><bdi>{metric.detail}</bdi></small> : null}
  </div>;
}

/** The prompt cache beside the hero: a ring of the lifetime left, or a state dot. */
function CacheChip({ metric, warmth }: { metric: Metric; warmth: CacheWarmthDisplay }) {
  const counting = warmth.remaining !== null && (warmth.state === "warm" || warmth.state === "expiring");
  return <div className="usage-widget-chip" data-usage-metric={metric.id} data-state={warmth.state}
    {...(metric.tone ? { "data-tone": metric.tone } : {})} title={`${metric.label}: ${metric.value} · ${warmth.detail}`}>
    <span className="sr-only">{metric.label}</span>
    {counting
      ? <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${Math.max(4, warmth.remaining! * 100)} 100`} /></svg>
      : <i aria-hidden="true" />}
    <strong><bdi>{metric.value}</bdi></strong>
  </div>;
}

/** Context occupancy under the hero; the number above it is the readable value. */
function ContextMeter({ context }: { context: SessionContextDisplay }) {
  if (context.fraction === undefined) return null;
  return <div className="usage-widget-meter" aria-hidden="true" {...(context.level ? { "data-level": context.level } : {})}>
    <i style={{ inlineSize: `${context.fraction * 100}%` }} />
  </div>;
}

/** Consecutive metrics of one group, in the order they were listed. */
function groupMetrics(metrics: readonly Metric[]): { group: MetricGroup; metrics: Metric[] }[] {
  const groups: { group: MetricGroup; metrics: Metric[] }[] = [];
  for (const metric of metrics) {
    const last = groups.at(-1);
    if (last?.group === metric.group) last.metrics.push(metric);
    else groups.push({ group: metric.group, metrics: [metric] });
  }
  return groups;
}

/**
 * Recorded usage per bucket: a captioned chart with its first and last date,
 * or, in the glance, a bare sparkline beside the lead value.
 */
function Activity({ report, metric, spark = false }: { report: UsageStatsReport; metric: "tokens" | "cost"; spark?: boolean }) {
  const { bucket, buckets } = report.chart;
  const timezone = report.effective.timezone;
  // Server labels are en-US; the card speaks the viewer's locale.
  const bars = useMemo(
    () => usageWidgetBars(buckets, metric, (item) => formatBucketRange(item.start, item.end, bucket, timezone)),
    [buckets, bucket, metric, timezone],
  );
  if (!bars.some((bar) => bar.value !== null && bar.value > 0)) return null;
  const plot = <ol className={spark ? "usage-widget-bars usage-widget-spark" : "usage-widget-bars"} aria-label={tr(spark ? "usage.activity" : "usage.actualRecordedUsage")}>
    {bars.map((bar, index) => {
      const value = metric === "cost" ? money(bar.value, bar.complete) : tokens(bar.value, bar.complete);
      return <li key={index} data-known={bar.value !== null} data-latest={index === bars.length - 1 || undefined} title={`${bar.label}: ${value}`}>
        <span className="sr-only">{bar.label}: {value}</span>
        <span aria-hidden="true" style={{ height: `${bar.height}%` }} />
      </li>;
    })}
  </ol>;
  if (spark) return plot;
  return <figure className="usage-widget-activity">
    <figcaption><span>{tr("usage.activity")}</span><span>{tr(metric === "cost" ? "usage.cost" : "usage.tokens")}</span></figcaption>
    {plot}
    <div className="usage-widget-axis" aria-hidden="true">
      <span>{buckets[0] ? formatBucketTick(buckets[0].start, bucket, timezone) : null}</span>
      <span>{buckets.length > 1 ? formatBucketTick(buckets.at(-1)!.start, bucket, timezone) : null}</span>
    </div>
  </figure>;
}

/**
 * The compact panel size. The lead value comes first with what explains it
 * beside it (the context meter or the activity sparkline, and the cache
 * chip), then one line of its caption and the next two values. Without a lead
 * (the Metrics layout) up to four values share one row.
 */
function Glance({ hero, aside, caption, values }: {
  hero: Metric | null;
  aside: ReactNode;
  caption: string;
  values: readonly Metric[];
}) {
  if (!hero) {
    return <dl className="usage-widget-metrics usage-widget-strip" style={{ "--usage-strip-columns": Math.max(1, values.length) } as CSSProperties}>
      {values.map((metric) => <MetricValue key={metric.id} metric={metric} />)}
    </dl>;
  }
  return <div className="usage-widget-glance" data-usage-metric={hero.id}>
    <div className="usage-widget-glance-lead">
      <strong className="usage-widget-glance-figure" title={valueTitle(hero)}><bdi><Figure value={hero.value} /></bdi></strong>
      {aside}
    </div>
    <div className="usage-widget-glance-meta">
      <span className="usage-widget-glance-caption"><bdi>{caption}</bdi></span>
      {values.length > 0 ? <dl className="usage-widget-glance-values">
        {values.map((metric) => <div key={metric.id} data-usage-metric={metric.id} {...(metric.tone ? { "data-tone": metric.tone } : {})}>
          <dt>{metric.label}</dt>
          <dd title={valueTitle(metric)}><bdi><Figure value={metric.value} /></bdi></dd>
        </div>)}
      </dl> : null}
    </div>
  </div>;
}

export function UsageWidget({
  scope, title, query, enabled, context, session = null, config, editing, panelSize,
}: Pick<WidgetRenderContext, "config" | "editing" | "panelSize"> & {
  scope: UsageWidgetScope;
  title?: string;
  query: UsageStatsQuery;
  enabled: boolean;
  context?: SessionContextDisplay;
  /** Session scope only: its live cache countdown. */
  session?: SessionProjection | null;
}) {
  const stats = useUsageStats(query, { enabled });
  const [scrollRef, moreBelow] = useMoreBelow<HTMLDivElement>();
  const prefs = usageWidgetPreferences(config, scope);
  const report = stats.report;
  const populated = !!report?.totals.observations;
  const reportedCache = scope === "session" ? report?.sessions.find((item) => item.id === session?.id)?.cache : undefined;
  const warmth = useSessionCache(scope === "session" ? session : null, reportedCache)?.warmth;
  const metrics = widgetMetrics(populated ? report.totals : null, context, warmth);
  const primary = metrics.find((metric) => metric.id === prefs.primary) ?? metrics[0];
  // Turn telemetry many harnesses never report: unknown, it is only noise. An
  // unknown token, cost or cache value keeps its dash: it must not read as zero.
  const shown = metrics.filter((metric) => metric === primary || !OPTIONAL_METRICS.has(metric.id) || metric.value !== "—");
  const hero = prefs.layout !== "metrics" && primary ? primary : null;
  const chip = hero && warmth ? shown.find((metric) => metric.id === "cache-ttl" && metric !== hero) : undefined;
  const supporting = shown.filter((metric) => metric !== hero && metric !== chip);
  const listed = prefs.layout === "summary" ? supporting.slice(0, 2) : supporting;
  // Headings only where there is more than one kind of value to tell apart.
  const headed = scope === "session" && prefs.layout !== "summary";
  const chartMetric = prefs.primary === "cost" ? "cost" : "tokens";
  const label = tr(scope === "session" ? "usage.sessionWidgetTitle" : scope === "project" ? "usage.projectWidgetTitle" : "usage.globalWidgetTitle");
  // A session's totals are lifetime by definition, so it has no range.
  const range = scope === "session" ? null : prefs.range === "all" ? tr("usage.allTime") : tr("usage.days", { count: Number.parseInt(prefs.range, 10) });
  const compact = usageWidgetCompact(panelSize);
  return <div className="usage-widget" data-compact={compact || undefined} aria-busy={stats.loading || stats.refreshing}>
    <div ref={scrollRef} className="usage-widget-scroll" data-more={moreBelow || undefined} role="region" tabIndex={0} aria-label={label}>
      <div className="usage-widget-content" data-layout={prefs.layout} data-scope={scope}>
        {/* The title names the scope; the scope word stays for assistive tech.
            The glance has no room for a title line: the panel's own header
            names the card, and the range moves into the lead's caption. A
            compact row of values has no caption, so it keeps the line for
            its range. */}
        <header className={compact && (hero || !range) ? "usage-widget-heading sr-only" : "usage-widget-heading"}>
          <div><span className={title ? "sr-only" : undefined}>{tr(scope === "global" ? "usage.allProjects" : scope === "project" ? "usage.project" : "usage.session")}</span>
            {title ? <strong title={title}>{title}</strong> : null}</div>
          {range ? <span className="usage-widget-range">{range}</span> : null}
        </header>
        {enabled && primary && compact ? <Glance
          hero={hero}
          caption={hero ? [hero.label, hero.detail, range].filter(Boolean).join(" · ") : ""}
          values={hero ? supporting.slice(0, 2) : shown.slice(0, 4)}
          aside={<>
            {hero?.id === "context" && context ? <ContextMeter context={context} /> : null}
            {hero && populated && scope !== "session" && prefs.showActivity ? <Activity report={report} metric={chartMetric} spark /> : null}
            {chip && warmth ? <CacheChip metric={chip} warmth={warmth} /> : null}
          </>}
        /> : null}
        {enabled && primary && !compact ? <div className="usage-widget-overview">
          {hero ? <div className="usage-widget-lead">
            <div className="usage-widget-lead-row">
              <dl className="usage-widget-hero"><MetricValue metric={hero} /></dl>
              {chip && warmth ? <CacheChip metric={chip} warmth={warmth} /> : null}
            </div>
            {hero.id === "context" && context ? <ContextMeter context={context} /> : null}
          </div> : null}
          {listed.length > 0 ? <div className="usage-widget-ledger">
            {groupMetrics(listed).map(({ group, metrics: items }) => {
              const heading = headed && group in GROUP_LABEL ? tr(GROUP_LABEL[group as keyof typeof GROUP_LABEL]) : null;
              return <section className="usage-widget-group" key={`${group}:${items[0]!.id}`}>
                {heading ? <h4>{heading}</h4> : null}
                <dl className="usage-widget-metrics">{items.map((metric) => <MetricValue key={metric.id} metric={metric} />)}</dl>
              </section>;
            })}
          </div> : null}
        </div> : null}
        {!enabled || !populated ? <div className="usage-widget-state" role="status">
          <EmptyState variant="compact"
            title={!enabled ? tr(scope === "session" ? "usage.noActiveSession" : "usage.noProjectSelected") : stats.loading ? tr("usage.loading") : stats.error ? tr("usage.unavailable") : tr("usage.noUsageData")}
            description={!enabled ? tr(scope === "session" ? "usage.openSessionToInspect" : "usage.createOrSelectProject") : stats.error ?? (!stats.loading ? tr("usage.recordedUsageWillAppear") : undefined)}
            {...(enabled && stats.error && !editing ? { actionLabel: tr("usage.retry"), onAction: stats.refresh } : {})} />
        </div> : null}
        {stats.stale && populated ? <div className="usage-widget-note" role="status">
          <span title={stats.error ?? undefined}>{tr("usage.showingLastSuccessfulReport")}</span>
          {!editing ? <Button size="sm" onClick={stats.refresh} busy={stats.refreshing}>{tr("usage.retry")}</Button> : null}
        </div> : null}
        {/* Session scope always uses the all-time range, so its month buckets
            start at the first observation: a normal session is a single bucket,
            which drew as one full-width bar rather than a trend. The plot stays
            on the scopes whose range spans many buckets. */}
        {populated && !compact && scope !== "session" && prefs.showActivity ? <Activity report={report} metric={chartMetric} /> : null}
        {populated && !compact && scope === "global" && prefs.showBreakdown && prefs.layout !== "summary" && report.projects.length > 0 ?
          <section className="usage-widget-projects" aria-label={tr("usage.projects")}>
            <header><span>{tr("usage.projects")}</span><span>{formatNumber(Math.min(4, report.projects.length))} / {formatNumber(report.projects.length)}</span></header>
            <dl>{report.projects.slice(0, 4).map((project) => {
              const share = projectShare(chartMetric === "cost" ? project.metrics.cost : project.metrics.tokens.total,
                chartMetric === "cost" ? report.totals.cost : report.totals.tokens.total);
              return <div key={project.id} {...(share !== null ? { style: { "--usage-share": share } as CSSProperties } : {})}>
                <dt title={project.label}>{project.label}</dt>
                <dd><bdi>{chartMetric === "cost" ? money(project.metrics.cost, project.metrics.costComplete) : tokens(project.metrics.tokens.total, project.metrics.tokens.totalComplete)}</bdi></dd>
              </div>;
            })}</dl>
          </section> : null}
      </div>
    </div>
  </div>;
}

export function UsageWidgetSettings({ widgetId, config, updateConfig }: WidgetSettingsContext) {
  const scope: UsageWidgetScope = widgetId === "usage.session" ? "session" : widgetId === "usage.project" ? "project" : "global";
  const prefs = usageWidgetPreferences(config, scope);
  const update = (key: string, value: string | boolean) => updateConfig({ ...config, [key]: value });
  return <div className="usage-widget-settings">
    <label><span>{tr("usage.widgetLayout")}</span><Select label={tr("usage.widgetLayout")} value={prefs.layout} onChange={(value) => update("layout", value)}
      options={[{ value: "auto", label: tr("usage.widgetAdaptive") }, { value: "summary", label: tr("usage.widgetSummary") }, { value: "metrics", label: tr("usage.widgetMetrics") }]} /></label>
    <label><span>{tr("usage.widgetPrimaryMetric")}</span><Select label={tr("usage.widgetPrimaryMetric")} value={prefs.primary} onChange={(value) => update("primary", value)}
      options={[...(scope === "session" ? [{ value: "context", label: tr("usage.context") }] : []), { value: "tokens", label: tr("usage.tokens") }, { value: "cost", label: tr("usage.reportedCost") }]} /></label>
    {scope !== "session" ? <label><span>{tr("usage.usageRange")}</span><Select label={tr("usage.usageRange")} value={prefs.range} onChange={(value) => update("range", value)}
      options={["7d", "30d", "90d", "all"].map((value) => ({ value, label: value === "all" ? tr("usage.allTime") : tr("usage.days", { count: Number.parseInt(value, 10) }) }))} /></label> : null}
    {scope !== "session" ? <Checkbox checked={prefs.showActivity} onChange={(value) => update("showActivity", value)} label={tr("usage.activity")} /> : null}
    {scope === "global" ? <Checkbox checked={prefs.showBreakdown} disabled={prefs.layout === "summary"} onChange={(value) => update("showBreakdown", value)} label={tr("usage.projects")} /> : null}
  </div>;
}
