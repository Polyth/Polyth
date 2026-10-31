import { memo, useMemo, useState, type ReactNode } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { openSession } from "../../../../apps/web/src/init.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { Button, Tabs } from "../../../../apps/web/src/components/ui/index.ts";
import { useSessionContext } from "../contextUsage.ts";
import { UNKNOWN_HARNESS_ID } from "../../src/providerIdentity.ts";
import { harnessShares, ringSegments, type HarnessShareRow } from "./harnessShare.ts";
import { ActivityChart, RatioRing, Sparkline } from "./UsageCharts.tsx";
import {
  formatCount,
  formatDateTime,
  formatDurationValue,
  formatLatency,
  formatMetric,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatRate,
  formatShare,
  formatTokens,
  formatTrendPercent,
  metricLabel,
  rangeLabel,
} from "./dashboardFormat.ts";
import type { UsageDashboardRange, UsageLayoutScope } from "./dashboardLayout.ts";
import type {
  UsageAggregate,
  UsageChartMetric,
  UsageGroupSummary,
  UsageStatsReport,
  UsageTrend,
} from "../../src/analytics/contracts.ts";

const METRIC_TABS = (): Array<{ id: UsageChartMetric; label: string }> => [
  { id: "tokens", label: tr("usage.tokens") },
  { id: "cost", label: tr("usage.cost") },
  { id: "turns", label: tr("usage.turns") },
];

export function Section({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`usage-clean-section ${className}`.trim()}>
      <header>
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function CoverageNote({ report }: { report: UsageStatsReport }) {
  if (report.coverage.derivedObservations === 0 && report.coverage.estimatedObservations === 0) return null;
  const parts = [
    report.coverage.derivedObservations > 0
      ? tr("usage.derivedObservations", { count: report.coverage.derivedObservations })
      : "",
    report.coverage.estimatedObservations > 0
      ? tr("usage.estimatedObservations", { count: report.coverage.estimatedObservations })
      : "",
  ].filter(Boolean);
  return (
    <div className="usage-clean-note" role="note">
      {tr("usage.coverageNote", { details: parts.join(" · ") })}
    </div>
  );
}

/**
 * Change against the preceding equal period. Direction is spelled out by the
 * sign and the hidden sentence; usage going up is not judged good or bad.
 */
function TrendChip({ trend, range }: { trend: UsageTrend | null | undefined; range: UsageDashboardRange }) {
  const value = trend && range !== "all" ? formatTrendPercent(trend) : null;
  if (!trend || value === null) return null;
  const sentence = tr("usage.trendVsPrevious", { value, period: rangeLabel(range) });
  return (
    <span className="usage-clean-trend" data-direction={trend.direction} title={sentence}>
      <span aria-hidden="true">{value}</span>
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

function Kpi({
  label,
  value,
  title,
  detail,
  trend,
  range,
  spark,
  ring,
  primary = false,
}: {
  label: string;
  value: string;
  title?: string;
  detail?: string;
  trend?: UsageTrend | null;
  range?: UsageDashboardRange;
  spark?: readonly (number | null)[];
  ring?: number | null;
  primary?: boolean;
}) {
  return (
    <div className="usage-clean-kpi" data-primary={primary ? "true" : undefined}>
      <div className="usage-clean-kpi-head">
        <span>{label}</span>
        {range ? <TrendChip trend={trend} range={range} /> : null}
      </div>
      <div className="usage-clean-kpi-body">
        {ring !== undefined ? <RatioRing percent={ring} /> : null}
        <div className="usage-clean-kpi-value">
          <strong title={title}>{value}</strong>
          {detail ? <small>{detail}</small> : null}
        </div>
      </div>
      {spark ? <Sparkline values={spark} /> : null}
    </div>
  );
}

/** Headline totals for Project and Global, each with its own trend and shape. */
export const ScopedOverview = memo(function ScopedOverview({ report, range }: { report: UsageStatsReport; range: UsageDashboardRange }) {
  const metrics = report.totals;
  const series = useMemo(() => ({
    tokens: report.chart.buckets.map((bucket) => bucket.values.tokens),
    cost: report.chart.buckets.map((bucket) => bucket.values.cost),
    turns: report.chart.buckets.map((bucket) => bucket.values.turns),
  }), [report]);
  return (
    <div className="usage-clean-overview">
      <Kpi
        primary
        label={tr("usage.modelTokens")}
        value={formatTokens(metrics.tokens.total, metrics.tokens.totalComplete)}
        title={metrics.tokens.total === null ? undefined : formatCount(metrics.tokens.total)}
        trend={report.trends.tokens}
        range={range}
        spark={series.tokens}
      />
      <Kpi
        label={tr("usage.reportedCost")}
        value={formatMoneyCompact(metrics.cost, metrics.costComplete)}
        title={formatMoney(metrics.cost, metrics.costComplete)}
        trend={report.trends.cost}
        range={range}
        spark={series.cost}
      />
      <Kpi label={tr("usage.turns")} value={formatMetric("turns", metrics.turns, metrics.turnsComplete)} trend={report.trends.turns} range={range} spark={series.turns} />
      <Kpi label={tr("usage.sessions")} value={formatCount(metrics.sessions)} trend={report.trends.sessions} range={range} />
      <Kpi label={tr("usage.cacheHit")} value={formatPercent(metrics.cacheHitPercent)} ring={metrics.cacheHitPercent} detail={tr("usage.cacheHitDetail")} />
      <Kpi
        label={tr("usage.activeDays")}
        value={formatCount(metrics.activeDays)}
        detail={metrics.longestActivityStreak > 1 ? tr("usage.longestStreak", { count: metrics.longestActivityStreak }) : undefined}
      />
    </div>
  );
});

/** Session headline: live context occupancy beside lifetime telemetry. */
export function SessionOverview({ report, session }: { report: UsageStatsReport; session: SessionProjection | null }) {
  const metrics = report.totals;
  const context = useSessionContext(session);
  // Detail rows arrive newest first; sparklines read left to right in time.
  const perTurn = useMemo(() => {
    const turns = report.turns.toSorted((a, b) => a.timestamp - b.timestamp);
    return {
      tokens: turns.map((turn) => turn.metrics.tokens.total),
      response: turns.map((turn) => turn.metrics.rates?.responseTokPerSec ?? null),
    };
  }, [report]);
  const caption = report.turns.length > 1 ? tr("usage.lastTurns", { count: report.turns.length }) : undefined;
  return (
    <div className="usage-clean-overview">
      <Kpi primary label={tr("usage.context")} value={context.value} detail={context.detail} />
      <Kpi
        label={tr("usage.modelTokens")}
        value={formatTokens(metrics.tokens.total, metrics.tokens.totalComplete)}
        title={metrics.tokens.total === null ? undefined : formatCount(metrics.tokens.total)}
        detail={caption}
        spark={perTurn.tokens}
      />
      <Kpi label={tr("usage.cacheHit")} value={formatPercent(metrics.cacheHitPercent)} ring={metrics.cacheHitPercent} detail={tr("usage.cacheHitDetail")} />
      <Kpi label={tr("usage.response")} value={formatRate(metrics.rates?.responseTokPerSec)} detail={tr("usage.outputPerModelTime")} spark={perTurn.response} />
      <Kpi label={tr("usage.wholeTurn")} value={formatRate(metrics.rates?.wholeTurnTokPerSec)} detail={tr("usage.outputPerWallTime")} />
      <Kpi label={tr("usage.reportedCost")} value={formatMoneyCompact(metrics.cost, metrics.costComplete)} title={formatMoney(metrics.cost, metrics.costComplete)} />
    </div>
  );
}

type TokenPart = "input" | "cacheRead" | "cacheWrite" | "output";

const TOKEN_PARTS: ReadonlyArray<{ id: TokenPart; label: () => string }> = [
  { id: "input", label: () => tr("usage.input") },
  { id: "cacheRead", label: () => tr("usage.cacheRead") },
  { id: "cacheWrite", label: () => tr("usage.cacheWrite") },
  { id: "output", label: () => tr("usage.output") },
];

/**
 * The four parts that make up the token total, as one proportional bar.
 * Reasoning is listed separately: it is not added to the total.
 */
export const TokenMix = memo(function TokenMix({ metrics, description }: { metrics: UsageAggregate; description: string }) {
  const parts = TOKEN_PARTS.map((part) => ({ ...part, value: metrics.tokens[part.id] }));
  const plotted = parts.reduce((sum, part) => sum + (part.value ?? 0), 0);
  return (
    <Section className="usage-clean-tokens" title={tr("usage.tokenMix")} description={description}>
      {plotted <= 0 ? (
        <div className="usage-clean-empty">{tr("usage.chartEmpty", { metric: tr("usage.tokens") })}</div>
      ) : (
        <div className="usage-clean-mix">
          <div className="usage-clean-mix-main">
            <div className="usage-clean-mix-total">
              <strong>{formatTokens(metrics.tokens.total, metrics.tokens.totalComplete)}</strong>
              <span>{tr("usage.modelTokens")}</span>
            </div>
            <div className="usage-clean-mix-bar" aria-hidden="true">
              {parts.map((part) => part.value ? (
                <i key={part.id} data-part={part.id} style={{ flexGrow: part.value }} title={`${part.label()} · ${formatShare(part.value / plotted)}`} />
              ) : null)}
            </div>
            <ul className="usage-clean-mix-legend">
              {parts.map((part) => (
                <li key={part.id}>
                  <i data-part={part.id} aria-hidden="true" />
                  <span>{part.label()}</span>
                  <strong>{formatTokens(part.value)}</strong>
                  <small>{part.value === null ? "—" : formatShare(part.value / plotted)}</small>
                </li>
              ))}
              <li data-separate="true">
                <i data-part="reasoning" aria-hidden="true" />
                <span title={tr("usage.reasoningSeparate")}>{tr("usage.reasoning")}</span>
                <strong>{formatTokens(metrics.tokens.reasoning)}</strong>
                <small>{tr("usage.reasoningShort")}</small>
              </li>
            </ul>
          </div>
          <div className="usage-clean-mix-cache">
            <RatioRing percent={metrics.cacheHitPercent}>
              <strong>{formatPercent(metrics.cacheHitPercent)}</strong>
            </RatioRing>
            <div className="usage-clean-mix-cache-copy">
              <strong>{tr("usage.cacheHit")}</strong>
              <small>{tr("usage.cacheHitDetail")}</small>
              {metrics.cacheBurn ? (
                <small data-usage-cache-burn={metrics.cacheBurn.rewrites > 0 ? "burned" : "none"}>
                  {metrics.cacheBurn.rewrites > 0
                    ? tr("usage.cacheBurnSummary", { tokens: formatTokens(metrics.cacheBurn.tokens), count: formatCount(metrics.cacheBurn.rewrites) })
                    : tr("usage.cacheBurnNone")}
                </small>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
});

/** Where measured turn time went, plus the turn-level counters. */
export function TimingBlock({ metrics }: { metrics: UsageAggregate }) {
  const model = metrics.timing?.modelMs ?? null;
  const tool = metrics.timing?.toolMs ?? null;
  const split = (model ?? 0) + (tool ?? 0);
  return (
    <Section title={tr("usage.timing")} description={tr("usage.turnTelemetryCountedOnce")}>
      <div className="usage-clean-timing">
        {split > 0 ? (
          <div className="usage-clean-split">
            <div className="usage-clean-split-bar" aria-hidden="true">
              {model ? <i data-part="model" style={{ flexGrow: model }} /> : null}
              {tool ? <i data-part="tool" style={{ flexGrow: tool }} /> : null}
            </div>
            <ul className="usage-clean-split-legend">
              <li><i data-part="model" aria-hidden="true" /><span>{tr("usage.modelTime")}</span><strong>{formatDurationValue(model)}</strong><small>{model === null ? "—" : formatShare(model / split)}</small></li>
              <li><i data-part="tool" aria-hidden="true" /><span>{tr("usage.toolTime")}</span><strong>{formatDurationValue(tool)}</strong><small>{tool === null ? "—" : formatShare(tool / split)}</small></li>
            </ul>
          </div>
        ) : null}
        <dl className="usage-clean-facts">
          <div><dt>{tr("usage.wallTime")}</dt><dd>{formatDurationValue(metrics.timing?.totalMs)}</dd></div>
          <div><dt>{tr("usage.avgTtft")}</dt><dd>{formatLatency(metrics.timing?.ttftMs)}</dd></div>
          <div><dt>{tr("usage.turns")}</dt><dd>{formatMetric("turns", metrics.turns, metrics.turnsComplete)}</dd></div>
          <div><dt>{tr("usage.steps")}</dt><dd>{formatCount(metrics.steps)}</dd></div>
          <div><dt>{tr("usage.retries")}</dt><dd>{formatCount(metrics.retries)}</dd></div>
        </dl>
      </div>
    </Section>
  );
}

function ShowMore({ total, shown, expanded, onToggle }: { total: number; shown: number; expanded: boolean; onToggle: () => void }) {
  if (total <= shown && !expanded) return null;
  return (
    <div className="usage-clean-more">
      <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? tr("usage.showLess") : tr("usage.showAll", { count: total })}
      </Button>
    </div>
  );
}

function useExpandable<T>(items: readonly T[], collapsed: number): { visible: readonly T[]; more: ReactNode } {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, collapsed);
  return {
    visible,
    more: items.length > collapsed
      ? <ShowMore total={items.length} shown={visible.length} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
      : null,
  };
}

/** Bar width relative to the largest row, so the leader always reads as full. */
const shareOfLeader = (value: number | null, leader: number): number =>
  value === null || leader <= 0 ? 0 : Math.max(0, Math.min(1, value / leader));

/** One value column; its column name is spoken, the visual header carries it on screen. */
function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <span className={className ? `usage-clean-cell ${className}` : "usage-clean-cell"}>
      <span className="sr-only">{`${label}: `}</span>
      {children}
    </span>
  );
}

/** Column names on the same grid as the rows, so breakpoints hide both together. */
function ListHead({ name, columns }: { name: string; columns: readonly string[] }) {
  return (
    <div className="usage-clean-row usage-clean-list-head" aria-hidden="true">
      <span className="usage-clean-row-main">{name}</span>
      <span />
      {columns.map((column, index) => <span key={index} className="usage-clean-cell">{column}</span>)}
    </div>
  );
}

export function TurnsBlock({ report }: { report: UsageStatsReport }) {
  const leader = Math.max(0, ...report.turns.map((turn) => turn.metrics.tokens.total ?? 0));
  const { visible, more } = useExpandable(report.turns, 12);
  return (
    <Section title={tr("usage.turns")} description={tr("usage.recentMeasuredTurns")}>
      <div className="usage-clean-list" data-kind="turns">
        {report.turns.length > 0 ? (
          <ListHead name={tr("usage.models")} columns={[tr("usage.tokens"), tr("usage.response"), tr("usage.cacheHit"), tr("usage.ttft")]} />
        ) : null}
        {visible.map((turn) => (
          <div className="usage-clean-row" key={turn.id}>
            <div className="usage-clean-row-main">
              <strong>{turn.modelId ?? tr("usage.defaultModel")}</strong>
              <small>{formatDateTime(turn.timestamp)}{turn.modelVariant ? ` · ${turn.modelVariant}` : ""}</small>
            </div>
            <div className="usage-clean-row-bar" aria-hidden="true"><i style={{ inlineSize: `${shareOfLeader(turn.metrics.tokens.total, leader) * 100}%` }} /></div>
            <Cell label={tr("usage.tokens")}>{formatTokens(turn.metrics.tokens.total, turn.metrics.tokens.totalComplete)}</Cell>
            <Cell label={tr("usage.response")}>{formatRate(turn.metrics.rates?.responseTokPerSec)}</Cell>
            <Cell label={tr("usage.cacheHit")}>{formatPercent(turn.metrics.cacheHitPercent)}</Cell>
            <Cell label={tr("usage.ttft")}>{formatLatency(turn.metrics.timing?.ttftMs)}</Cell>
          </div>
        ))}
        {report.turns.length === 0 ? <div className="usage-clean-empty">{tr("usage.noTurnTelemetry")}</div> : null}
      </div>
      {more}
    </Section>
  );
}

function GroupRows({
  groups,
  range,
  name,
  empty,
  detail,
  lastLabel,
  last,
}: {
  groups: readonly UsageGroupSummary[];
  range: UsageDashboardRange;
  name: string;
  empty: string;
  detail: (group: UsageGroupSummary) => string;
  lastLabel: string;
  last: (group: UsageGroupSummary) => string;
}) {
  const trendColumn = range === "all" ? "" : tr("usage.changeColumn");
  const leader = Math.max(0, ...groups.map((group) => group.metrics.tokens.total ?? 0));
  const { visible, more } = useExpandable(groups, 8);
  return (
    <>
      <div className="usage-clean-list" data-kind="groups">
        {groups.length > 0 ? (
          <ListHead name={name} columns={[tr("usage.tokens"), tr("usage.cost"), lastLabel, trendColumn]} />
        ) : null}
        {visible.map((group) => (
          <div className="usage-clean-row" key={group.id}>
            <div className="usage-clean-row-main">
              <strong>{group.label}</strong>
              <small>{detail(group)}</small>
            </div>
            <div className="usage-clean-row-bar" aria-hidden="true"><i style={{ inlineSize: `${shareOfLeader(group.metrics.tokens.total, leader) * 100}%` }} /></div>
            <Cell label={tr("usage.tokens")}>{formatTokens(group.metrics.tokens.total, group.metrics.tokens.totalComplete)}</Cell>
            <Cell label={tr("usage.cost")}>{formatMoneyCompact(group.metrics.cost, group.metrics.costComplete)}</Cell>
            <Cell label={lastLabel}>{last(group)}</Cell>
            <span className="usage-clean-cell usage-clean-row-trend"><TrendChip trend={group.trend} range={range} /></span>
          </div>
        ))}
        {groups.length === 0 ? <div className="usage-clean-empty">{empty}</div> : null}
      </div>
      {more}
    </>
  );
}

export function ProjectsBlock({ report, range }: { report: UsageStatsReport; range: UsageDashboardRange }) {
  return (
    <Section title={tr("usage.projects")} description={tr("usage.whereUsageHappening")}>
      <GroupRows
        groups={report.projects}
        range={range}
        name={tr("usage.projects")}
        lastLabel={tr("usage.sessions")}
        empty={tr("usage.noProjectActivity")}
        detail={(project) => project.detail ?? project.id}
        last={(project) => formatCount(project.metrics.sessions)}
      />
    </Section>
  );
}

export function ModelsBlock({ report, range }: { report: UsageStatsReport; range: UsageDashboardRange }) {
  return (
    <Section title={tr("usage.models")} description={tr("usage.modelsUsedInScope")}>
      <GroupRows
        groups={report.models}
        range={range}
        name={tr("usage.models")}
        lastLabel={tr("usage.turns")}
        empty={tr("usage.noModelUsage")}
        detail={(model) => model.detail ?? tr("usage.sessionsValue", { count: model.metrics.sessions })}
        last={(model) => formatMetric("turns", model.metrics.turns, model.metrics.turnsComplete)}
      />
    </Section>
  );
}

export function SessionsBlock({ report }: { report: UsageStatsReport }) {
  const leader = Math.max(0, ...report.sessions.map((session) => session.metrics.tokens.total ?? 0));
  const { visible, more } = useExpandable(report.sessions, 10);
  return (
    <Section title={tr("usage.sessions")} description={tr("usage.mostRecentlyActiveSessions")}>
      <div className="usage-clean-list" data-kind="sessions">
        {report.sessions.length > 0 ? (
          <ListHead name={tr("usage.sessions")} columns={[tr("usage.tokens"), tr("usage.cost"), tr("usage.turns")]} />
        ) : null}
        {visible.map((session) => (
          <button
            type="button"
            className="usage-clean-row usage-clean-row-button"
            key={session.id}
            onClick={() => void openSession(session.id)}
          >
            <span className="usage-clean-row-main">
              <strong>{session.title}</strong>
              <small>{session.projectName} · {formatDateTime(session.lastActivityAt)}</small>
            </span>
            <span className="usage-clean-row-bar" aria-hidden="true"><i style={{ inlineSize: `${shareOfLeader(session.metrics.tokens.total, leader) * 100}%` }} /></span>
            <Cell label={tr("usage.tokens")}>{formatTokens(session.metrics.tokens.total, session.metrics.tokens.totalComplete)}</Cell>
            <Cell label={tr("usage.cost")}>{formatMoneyCompact(session.metrics.cost, session.metrics.costComplete)}</Cell>
            <Cell label={tr("usage.turns")}>{formatMetric("turns", session.metrics.turns, session.metrics.turnsComplete)}</Cell>
          </button>
        ))}
        {report.sessions.length === 0 ? <div className="usage-clean-empty">{tr("usage.noSessions")}</div> : null}
      </div>
      {more}
    </Section>
  );
}

export function ActivityBlock({ report, metric, onMetric }: { report: UsageStatsReport; metric: UsageChartMetric; onMetric: (metric: UsageChartMetric) => void }) {
  return (
    <Section
      className="usage-clean-activity"
      title={tr("usage.activity")}
      description={tr("usage.actualRecordedUsage")}
      action={
        <Tabs
          size="sm"
          label={tr("usage.activityMetric")}
          value={metric}
          tabs={METRIC_TABS()}
          onChange={(value) => onMetric(value as UsageChartMetric)}
        />
      }
    >
      <ActivityChart report={report} metric={metric} />
    </Section>
  );
}

type BurnDimension = "models" | "projects" | "harnesses" | "sessions" | "turns";

interface BurnRow { id: string; label: string; detail: string; tokens: number; rewrites: number }

const BURN_DIMENSIONS: Readonly<Record<UsageLayoutScope, readonly BurnDimension[]>> = {
  session: ["turns"],
  project: ["models", "harnesses", "sessions"],
  global: ["models", "projects", "harnesses", "sessions"],
};

const burnDimensionLabel = (dimension: BurnDimension): string => tr(
  dimension === "models" ? "usage.models"
    : dimension === "projects" ? "usage.projects"
      : dimension === "harnesses" ? "usage.harnesses"
        : dimension === "sessions" ? "usage.sessions" : "usage.turns",
);

const burned = (metrics: UsageAggregate): { tokens: number; rewrites: number } | null =>
  metrics.cacheBurn && metrics.cacheBurn.rewrites > 0 ? metrics.cacheBurn : null;

/** Rows that actually burned cache, largest first. Unburned rows add only noise. */
function burnRows(report: UsageStatsReport, dimension: BurnDimension): BurnRow[] {
  const rows: BurnRow[] = [];
  const push = (id: string, label: string, detail: string, metrics: UsageAggregate) => {
    const burn = burned(metrics);
    if (burn) rows.push({ id, label, detail, tokens: burn.tokens, rewrites: burn.rewrites });
  };
  if (dimension === "turns") {
    for (const turn of report.turns) push(turn.id, turn.modelId ?? tr("usage.defaultModel"), formatDateTime(turn.timestamp), turn.metrics);
  } else if (dimension === "sessions") {
    for (const session of report.sessions) push(session.id, session.title, `${session.projectName} · ${formatDateTime(session.lastActivityAt)}`, session.metrics);
  } else {
    const groups = dimension === "models" ? report.models : dimension === "projects" ? report.projects : report.harnesses ?? [];
    for (const group of groups) {
      const label = dimension === "harnesses" && group.id === UNKNOWN_HARNESS_ID ? tr("usage.unknownHarness") : group.label;
      push(group.id, label, group.detail ?? tr("usage.sessionsValue", { count: group.metrics.sessions }), group.metrics);
    }
  }
  return rows.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Prompt cache re-written after expiry, and where it happened. Burn is
 * measured only when the providers report cache writes; reads-only telemetry
 * (OpenAI) is stated as not reported, never shown as zero.
 */
export function CacheBurnBlock({ report, scope }: { report: UsageStatsReport; scope: UsageLayoutScope }) {
  const dimensions = BURN_DIMENSIONS[scope];
  const [chosen, setDimension] = useState<BurnDimension>(dimensions[0]!);
  const dimension = dimensions.includes(chosen) ? chosen : dimensions[0]!;
  const rows = useMemo(() => burnRows(report, dimension), [report, dimension]);
  const total = report.totals.cacheBurn;
  const leader = rows[0]?.tokens ?? 0;
  const { visible, more } = useExpandable(rows, 8);
  const tabs = total && total.rewrites > 0 && dimensions.length > 1 ? (
    <Tabs
      size="sm"
      label={tr("usage.cacheBurnBreakdown")}
      value={dimension}
      tabs={dimensions.map((id) => ({ id, label: burnDimensionLabel(id) }))}
      onChange={(value) => setDimension(value as BurnDimension)}
    />
  ) : undefined;
  return (
    <Section className="usage-clean-burn" title={tr("usage.cacheBurn")} description={tr("usage.cacheBurnDescription")} action={tabs}>
      {!total ? (
        <div className="usage-clean-empty">{tr("usage.cacheBurnNotReported")}</div>
      ) : total.rewrites === 0 ? (
        <div className="usage-clean-empty">{tr("usage.cacheBurnNone")}</div>
      ) : (
        <>
          <p className="usage-clean-burn-total">
            {tr("usage.cacheBurnSummary", { tokens: formatTokens(total.tokens), count: formatCount(total.rewrites) })}
          </p>
          <div className="usage-clean-list" data-kind="burn">
            {rows.length > 0 ? (
              <ListHead name={burnDimensionLabel(dimension)} columns={[tr("usage.cacheBurn"), tr("usage.cacheRewrites"), tr("usage.cacheBurnShare")]} />
            ) : null}
            {visible.map((row) => (
              <div className="usage-clean-row" key={row.id}>
                <div className="usage-clean-row-main">
                  {/* Own direction: an LTR model id in RTL keeps its start and ellipsizes at its end. */}
                  <strong dir="auto" title={row.label}>{row.label}</strong>
                  <small dir="auto" title={row.detail}>{row.detail}</small>
                </div>
                <div className="usage-clean-row-bar" aria-hidden="true"><i style={{ inlineSize: `${shareOfLeader(row.tokens, leader) * 100}%` }} /></div>
                <Cell label={tr("usage.cacheBurn")}>{formatTokens(row.tokens)}</Cell>
                <Cell label={tr("usage.cacheRewrites")}>{formatCount(row.rewrites)}</Cell>
                <Cell label={tr("usage.cacheBurnShare")}>{formatShare(row.tokens / total.tokens)}</Cell>
              </div>
            ))}
          </div>
          {more}
        </>
      )}
    </Section>
  );
}

/**
 * Who ran the work in this scope, as a share of one metric. The pie is drawn as
 * static SVG so its slices and the legend swatches resolve the same theme tokens.
 */
export function HarnessBreakdown({ harnesses }: { harnesses: UsageGroupSummary[] }) {
  const [metric, setMetric] = useState<UsageChartMetric>("tokens");
  const shares = useMemo(() => harnessShares(harnesses, metric), [harnesses, metric]);
  const segments = useMemo(() => ringSegments(shares.rows), [shares]);
  const harnessLabel = (row: HarnessShareRow): string =>
    row.id === UNKNOWN_HARNESS_ID ? tr("usage.unknownHarness") : row.label;

  return (
    <Section
      className="usage-clean-harnesses"
      title={tr("usage.harnesses")}
      description={tr("usage.harnessesDescription")}
      action={
        <Tabs
          size="sm"
          label={tr("usage.harnessMetric")}
          value={metric}
          tabs={METRIC_TABS()}
          onChange={(value) => setMetric(value as UsageChartMetric)}
        />
      }
    >
      {shares.rows.length === 0 ? (
        <div className="usage-clean-empty">{tr("usage.noHarnessUsage")}</div>
      ) : shares.total === null ? (
        <div className="usage-clean-empty">{tr("usage.chartEmpty", { metric: metricLabel(metric) })}</div>
      ) : (
        <div className="usage-clean-harness-body">
          <div className="usage-clean-harness-donut">
            <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
              {segments.map(({ row, path }) => (
                <path key={row.id} className="usage-clean-harness-slice" data-tone={row.tone} d={path}>
                  <title>{`${harnessLabel(row)} · ${formatShare(row.share!)} · ${formatMetric(metric, row.value, row.complete)}`}</title>
                </path>
              ))}
            </svg>
            <div className="usage-clean-harness-center">
              <strong>{formatMetric(metric, shares.total, shares.totalComplete)}</strong>
              <small>{metricLabel(metric)}</small>
            </div>
          </div>
          <ul className="usage-clean-harness-legend" aria-label={tr("usage.harnesses")}>
            {shares.rows.map((row) => (
              <li className="usage-clean-harness-row" key={row.id}>
                <i
                  className="usage-clean-harness-swatch"
                  data-tone={row.tone}
                  data-plotted={row.share === null ? "false" : "true"}
                  aria-hidden="true"
                />
                <div>
                  <strong>{harnessLabel(row)}</strong>
                  <small>{tr("usage.sessionsValue", { count: row.sessions })}</small>
                </div>
                <span>{row.share === null ? "—" : formatShare(row.share)}</span>
                <span>{formatMetric(metric, row.value, row.complete)}</span>
                <b className="usage-clean-harness-meter" aria-hidden="true">
                  <i data-tone={row.tone} style={{ inlineSize: `${(row.share ?? 0) * 100}%` }} />
                </b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
