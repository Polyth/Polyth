import type { UsageChartMetric, UsageStatsReport } from "../../src/analytics/contracts.ts";

export interface UsageSeriesPoint {
  start: number;
  end: number;
  /** Null when nothing reported this metric in the bucket; never coerced to zero. */
  value: number | null;
  /** False when part of the bucket's usage did not report the metric (a lower bound). */
  complete: boolean;
}

export function usageSeries(report: UsageStatsReport, metric: UsageChartMetric): UsageSeriesPoint[] {
  return report.chart.buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    value: bucket.values[metric],
    complete: metric === "tokens"
      ? bucket.values.tokensComplete
      : metric === "cost"
        ? bucket.values.costComplete
        : bucket.values.turnsComplete,
  }));
}

export interface UsageScale {
  /** Top of the axis: a 1/2/2.5/5 × 10ⁿ multiple at or above the data peak. */
  max: number;
  ticks: number[];
}

/** A readable axis for a non-negative series, with `count` intervals. */
export function niceScale(peak: number, count = 4): UsageScale {
  if (!Number.isFinite(peak) || peak <= 0) return { max: 1, ticks: [0, 1] };
  const rough = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const max = step * Math.ceil(peak / step - 1e-9);
  const ticks: number[] = [];
  for (let index = 0; index * step <= max + step / 1e6; index += 1) ticks.push(index * step);
  return { max, ticks };
}

/** Evenly spread label positions that always include the first and last bucket. */
export function axisLabelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);
  const labels = Math.max(2, maxLabels);
  const indices = new Set<number>();
  for (let slot = 0; slot < labels; slot += 1) indices.add(Math.round(slot * (count - 1) / (labels - 1)));
  return [...indices].sort((a, b) => a - b);
}

export interface UsageSeriesSummary {
  peakIndex: number | null;
  peak: number | null;
  /** Mean over buckets that reported the metric. */
  average: number | null;
  total: number | null;
  totalComplete: boolean;
  reported: number;
}

export function summarizeSeries(points: readonly UsageSeriesPoint[]): UsageSeriesSummary {
  let peakIndex: number | null = null;
  let total = 0;
  let reported = 0;
  let totalComplete = true;
  points.forEach((point, index) => {
    if (!point.complete) totalComplete = false;
    if (point.value === null) return;
    reported += 1;
    total += point.value;
    if (peakIndex === null || point.value > points[peakIndex]!.value!) peakIndex = index;
  });
  return {
    peakIndex,
    peak: peakIndex === null ? null : points[peakIndex]!.value,
    average: reported > 0 ? total / reported : null,
    total: reported > 0 ? total : null,
    totalComplete,
    reported,
  };
}

export interface SparklineGeometry {
  line: string;
  area: string;
  /** Coordinates of the last reported point, for the end marker. */
  last: { x: number; y: number } | null;
}

/**
 * Sparkline paths in a `width`×`height` box. Unreported samples break the
 * line rather than dipping to zero, so a gap never reads as idle time.
 */
export function sparklineGeometry(values: readonly (number | null)[], width: number, height: number, inset = 1.5): SparklineGeometry {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < 2 || known.length === 0) return { line: "", area: "", last: null };
  const peak = Math.max(...known);
  const floor = height - inset;
  const x = (index: number): number => inset + index * (width - inset * 2) / (values.length - 1);
  const y = (value: number): number => peak <= 0 ? floor : floor - value / peak * (height - inset * 2);
  const round = (value: number): string => (Math.round(value * 100) / 100).toString();
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([x(index), y(value)]);
  });
  if (run.length) runs.push(run);
  const line = runs.map((points) => points.length === 1
    ? `M${round(points[0]![0] - .75)} ${round(points[0]![1])}H${round(points[0]![0] + .75)}`
    : points.map(([px, py], index) => `${index ? "L" : "M"}${round(px)} ${round(py)}`).join("")).join("");
  const area = runs.filter((points) => points.length > 1).map((points) =>
    `M${round(points[0]![0])} ${round(floor)}${points.map(([px, py]) => `L${round(px)} ${round(py)}`).join("")}L${round(points.at(-1)![0])} ${round(floor)}Z`).join("");
  const end = runs.at(-1)?.at(-1);
  return { line, area, last: end ? { x: end[0], y: end[1] } : null };
}
