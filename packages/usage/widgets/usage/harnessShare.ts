import type { UsageChartMetric, UsageGroupSummary } from "../../src/analytics/contracts.ts";
import { UNKNOWN_HARNESS_ID } from "../../src/providerIdentity.ts";

/** Series tones the stylesheet defines (`data-tone="1"…"8"`); tone 0 is the neutral tail. */
export const HARNESS_TONES = 8;

export interface HarnessShareRow {
  id: string;
  label: string;
  sessions: number;
  /** The selected metric for this harness; null when nothing recorded it. */
  value: number | null;
  /** False for a lower bound or an absent value, mirroring the report's `*Complete` flags. */
  complete: boolean;
  /** Fraction of the plotted total in 0…1; null when the harness has no slice. */
  share: number | null;
  /** 1…HARNESS_TONES by token rank, or 0 for the unknown harness and any harness past the palette. */
  tone: number;
}

export interface HarnessShares {
  /** Plotted harnesses by value, then the ones with nothing to plot. */
  rows: HarnessShareRow[];
  /** Sum of the plotted values, i.e. what the shares are relative to; null when nothing is plotted. */
  total: number | null;
  totalComplete: boolean;
}

const measure = (
  group: UsageGroupSummary,
  metric: UsageChartMetric,
): { value: number | null; complete: boolean } => {
  const { metrics } = group;
  if (metric === "tokens") return { value: metrics.tokens.total, complete: metrics.tokens.totalComplete };
  if (metric === "cost") return { value: metrics.cost, complete: metrics.costComplete };
  return { value: metrics.turns, complete: metrics.turnsComplete };
};

/**
 * Turn per-harness summaries into pie shares for one metric. Tones are handed
 * out by a ranking that does not depend on the metric (tokens, then activity),
 * so switching the metric never recolors a harness and the neutral tail lands
 * on the smallest harnesses.
 */
export function harnessShares(
  groups: readonly UsageGroupSummary[],
  metric: UsageChartMetric,
): HarnessShares {
  const tones = new Map<string, number>();
  groups
    .filter((group) => group.id !== UNKNOWN_HARNESS_ID)
    .toSorted((a, b) =>
      (b.metrics.tokens.total ?? -1) - (a.metrics.tokens.total ?? -1) ||
      b.metrics.observations - a.metrics.observations ||
      a.id.localeCompare(b.id))
    .forEach((group, index) => tones.set(group.id, index < HARNESS_TONES ? index + 1 : 0));

  type Measured = { group: UsageGroupSummary; value: number | null; complete: boolean };
  const plotted: Measured[] = [];
  const unplotted: Measured[] = [];
  for (const group of groups) {
    const measured = { group, ...measure(group, metric) };
    (measured.value !== null && measured.value > 0 ? plotted : unplotted).push(measured);
  }
  const total = plotted.reduce((sum, entry) => sum + entry.value!, 0);
  const byLabel = (a: Measured, b: Measured): number => a.group.label.localeCompare(b.group.label);
  const toRow = (entry: Measured, share: number | null): HarnessShareRow => ({
    id: entry.group.id,
    label: entry.group.label,
    sessions: entry.group.metrics.sessions,
    value: entry.value,
    complete: entry.complete,
    share,
    tone: tones.get(entry.group.id) ?? 0,
  });

  return {
    rows: [
      ...plotted.toSorted((a, b) => b.value! - a.value! || byLabel(a, b)).map((entry) => toRow(entry, entry.value! / total)),
      ...unplotted.toSorted(byLabel).map((entry) => toRow(entry, null)),
    ],
    total: plotted.length > 0 ? total : null,
    totalComplete: [...plotted, ...unplotted].every((entry) => entry.complete),
  };
}

/**
 * Ring geometry in a 100×100 viewBox: the pie is a donut so its total can sit
 * in the hole. The hole is 60% of the width; `.usage-clean-harness-center`
 * pads its text to fit inside it, so change both together.
 */
const RING_CENTER = 50;
const RING_OUTER = 46;
const RING_INNER = 30;

const FULL_TURN = Math.PI * 2;
const TOP = -Math.PI / 2;
const coordinate = (value: number): number => Math.round(value * 1000) / 1000;
const point = (radius: number, angle: number): string =>
  `${coordinate(RING_CENTER + radius * Math.cos(angle))} ${coordinate(RING_CENTER + radius * Math.sin(angle))}`;

/**
 * Path of one ring segment covering the `start`…`end` fractions of a turn,
 * clockwise from 12 o'clock. A whole turn is drawn as two half arcs per edge:
 * a single arc whose endpoints coincide would collapse to nothing.
 */
export function ringSegmentPath(start: number, end: number): string {
  if (end - start >= 1 - 1e-9) {
    const bottom = TOP + Math.PI;
    return [
      `M ${point(RING_OUTER, TOP)}`,
      `A ${RING_OUTER} ${RING_OUTER} 0 1 1 ${point(RING_OUTER, bottom)}`,
      `A ${RING_OUTER} ${RING_OUTER} 0 1 1 ${point(RING_OUTER, TOP)}`,
      `M ${point(RING_INNER, TOP)}`,
      `A ${RING_INNER} ${RING_INNER} 0 1 0 ${point(RING_INNER, bottom)}`,
      `A ${RING_INNER} ${RING_INNER} 0 1 0 ${point(RING_INNER, TOP)}`,
      "Z",
    ].join(" ");
  }
  const from = TOP + start * FULL_TURN;
  const to = TOP + end * FULL_TURN;
  const large = end - start > 0.5 ? 1 : 0;
  return [
    `M ${point(RING_OUTER, from)}`,
    `A ${RING_OUTER} ${RING_OUTER} 0 ${large} 1 ${point(RING_OUTER, to)}`,
    `L ${point(RING_INNER, to)}`,
    `A ${RING_INNER} ${RING_INNER} 0 ${large} 0 ${point(RING_INNER, from)}`,
    "Z",
  ].join(" ");
}

/** Consecutive ring segments for the plotted rows, in row order. */
export function ringSegments(rows: readonly HarnessShareRow[]): Array<{ row: HarnessShareRow; path: string }> {
  let start = 0;
  const segments: Array<{ row: HarnessShareRow; path: string }> = [];
  for (const row of rows) {
    if (row.share === null) continue;
    const end = start + row.share;
    segments.push({ row, path: ringSegmentPath(start, end) });
    start = end;
  }
  return segments;
}
