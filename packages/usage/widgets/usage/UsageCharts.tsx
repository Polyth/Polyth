import { memo, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import type { UsageChartMetric, UsageStatsReport } from "../../src/analytics/contracts.ts";
import {
  axisLabelIndices,
  niceScale,
  sparklineGeometry,
  summarizeSeries,
  usageSeries,
} from "./chartModel.ts";
import {
  formatAxisValue,
  formatBucketRange,
  formatBucketTick,
  formatMetric,
  metricLabel,
} from "./dashboardFormat.ts";

const AVERAGE_LABEL = {
  hour: "usage.chartAverageHour",
  day: "usage.chartAverageDay",
  week: "usage.chartAverageWeek",
  month: "usage.chartAverageMonth",
} as const;

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 32;

/**
 * Decorative trend line for a KPI. The KPI's own text carries the value, so the
 * drawing is hidden from assistive technology.
 */
export const Sparkline = memo(function Sparkline({ values }: { values: readonly (number | null)[] }) {
  const geometry = useMemo(() => sparklineGeometry(values, SPARK_WIDTH, SPARK_HEIGHT), [values]);
  if (!geometry.line) return null;
  return (
    <svg
      className="usage-clean-spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {geometry.area ? <path className="usage-clean-spark-area" d={geometry.area} /> : null}
      <path className="usage-clean-spark-line" d={geometry.line} />
    </svg>
  );
});

/** A 0…100 ring for ratios such as cache hit. Text beside it carries the value. */
export function RatioRing({ percent, children }: { percent: number | null; children?: ReactNode }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  // r = 15.915… makes the circumference exactly 100 user units.
  return (
    <div className="usage-clean-ring" data-known={percent === null ? "false" : "true"}>
      <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
        <circle className="usage-clean-ring-track" cx="18" cy="18" r="15.9155" />
        {value > 0 ? (
          <circle
            className="usage-clean-ring-value"
            cx="18"
            cy="18"
            r="15.9155"
            strokeDasharray={`${value} ${100 - value}`}
          />
        ) : null}
      </svg>
      {children ? <div className="usage-clean-ring-label">{children}</div> : null}
    </div>
  );
}

/**
 * Activity over time as static bars. Every bucket is a column; hovering,
 * tapping or arrowing through the plot inspects one period and a polite live
 * region announces it, so the values are reachable without a pointer.
 */
export function ActivityChart({ report, metric }: { report: UsageStatsReport; metric: UsageChartMetric }) {
  const points = useMemo(() => usageSeries(report, metric), [report, metric]);
  const summary = useMemo(() => summarizeSeries(points), [points]);
  const scale = useMemo(() => niceScale(summary.peak ?? 0), [summary.peak]);
  // Label rank: 0 for the two edges, then alternating 2/1 so narrow plots can
  // drop every other inner label and keep an even rhythm.
  const labels = useMemo(() => {
    const indices = axisLabelIndices(points.length, 7);
    return new Map(indices.map((index, position) => [
      index,
      position === 0 || position === indices.length - 1 ? 0 : position % 2 === 1 ? 2 : 1,
    ]));
  }, [points.length]);
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const timezone = report.effective.timezone;
  const bucket = report.chart.bucket;

  if (summary.peak === null || summary.peak <= 0) {
    return <div className="usage-clean-empty">{tr("usage.chartEmpty", { metric: metricLabel(metric) })}</div>;
  }

  const step = scale.ticks[1] ?? scale.max;
  const describe = (index: number): string => {
    const point = points[index]!;
    const value = point.value === null ? tr("usage.widgetUnknown") : formatMetric(metric, point.value, point.complete);
    return `${formatBucketRange(point.start, point.end, bucket, timezone)}: ${value}`;
  };
  const shown = active !== null && active < points.length ? active : null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = points.length - 1;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    let next: number | null = null;
    if (event.key === forward) next = shown === null ? 0 : Math.min(last, shown + 1);
    else if (event.key === backward) next = shown === null ? last : Math.max(0, shown - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape" && shown !== null) next = -1;
    if (next === null) return;
    event.preventDefault();
    setActive(next < 0 ? null : next);
  };
  const align = (index: number): "start" | "center" | "end" =>
    index < points.length * .18 ? "start" : index > points.length * .82 ? "end" : "center";
  const average = summary.average;

  return (
    <div
      className="usage-clean-chart"
      data-bucket={bucket}
      data-density={points.length > 60 ? "dense" : points.length > 31 ? "medium" : undefined}
    >
      <dl className="usage-clean-chart-summary">
        <div>
          <dt>{tr("usage.chartTotal")}</dt>
          <dd>{formatMetric(metric, summary.total, summary.totalComplete)}</dd>
        </div>
        <div>
          <dt>{tr("usage.chartPeak")}</dt>
          <dd>
            {formatMetric(metric, summary.peak)}
            {summary.peakIndex !== null ? <small>{formatBucketRange(points[summary.peakIndex]!.start, points[summary.peakIndex]!.end, bucket, timezone)}</small> : null}
          </dd>
        </div>
        <div>
          <dt>{tr(AVERAGE_LABEL[bucket])}</dt>
          <dd>{formatMetric(metric, average)}</dd>
        </div>
      </dl>
      <div className="usage-clean-chart-frame">
        <div className="usage-clean-chart-yaxis" aria-hidden="true">
          {/* Ticks are positioned out of flow; this invisible copy of the widest
              one gives the auto-sized axis column its real width. */}
          <span className="usage-clean-chart-yaxis-sizer">
            {scale.ticks.map((tick) => formatAxisValue(metric, tick, step)).reduce((wide, label) => label.length > wide.length ? label : wide, "")}
          </span>
          {scale.ticks.map((tick) => (
            <span key={tick} style={{ insetBlockEnd: `${tick / scale.max * 100}%` }}>{formatAxisValue(metric, tick, step)}</span>
          ))}
        </div>
        <div
          className="usage-clean-chart-plot"
          tabIndex={0}
          role="group"
          aria-label={tr("usage.chartExplore", { metric: metricLabel(metric) })}
          aria-describedby={liveId}
          onKeyDown={onKeyDown}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") setActive(null); }}
          onBlur={() => setActive(null)}
        >
          <div className="usage-clean-chart-grid" aria-hidden="true">
            {scale.ticks.map((tick) => <i key={tick} style={{ insetBlockEnd: `${tick / scale.max * 100}%` }} />)}
            {average !== null ? (
              <b className="usage-clean-chart-average" style={{ insetBlockEnd: `${average / scale.max * 100}%` }} />
            ) : null}
          </div>
          <div className="usage-clean-chart-bars" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
            {points.map((point, index) => (
              <div
                key={point.start}
                className="usage-clean-chart-col"
                data-active={shown === index ? "true" : undefined}
                data-peak={summary.peakIndex === index ? "true" : undefined}
                data-partial={point.complete ? undefined : "true"}
                onPointerEnter={() => setActive(index)}
                onPointerDown={() => setActive(index)}
              >
                {point.value !== null && point.value > 0 ? (
                  <i style={{ blockSize: `max(2px, ${point.value / scale.max * 100}%)` }} />
                ) : null}
                {shown === index ? (
                  <div className="usage-clean-chart-tip" data-align={align(index)} aria-hidden="true">
                    <strong>{point.value === null ? tr("usage.widgetUnknown") : formatMetric(metric, point.value, point.complete)}</strong>
                    <small>{formatBucketRange(point.start, point.end, bucket, timezone)}</small>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <div className="usage-clean-chart-xaxis" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
          {points.map((point, index) => (
            <span
              key={point.start}
              data-edge={index === 0 ? "start" : index === points.length - 1 ? "end" : undefined}
              data-minor={labels.get(index) === 2 ? "true" : undefined}
            >
              {labels.has(index) ? formatBucketTick(point.start, bucket, timezone) : null}
            </span>
          ))}
        </div>
      </div>
      <p id={liveId} className="sr-only" aria-live="polite">{shown === null ? "" : describe(shown)}</p>
    </div>
  );
}
