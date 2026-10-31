export interface UsageInterval {
  start: number;
  end: number;
}

/** Union wall-clock duration for overlapping tool intervals. */
export function unionIntervalDurationMs(intervals: readonly UsageInterval[]): number {
  const valid = intervals.filter(
    (interval) => Number.isFinite(interval.start) &&
      Number.isFinite(interval.end) &&
      interval.end > interval.start,
  );
  if (valid.length === 0) return 0;
  const sorted = [...valid].sort((a, b) => a.start - b.start);
  let total = 0;
  let currentStart = sorted[0]!.start;
  let currentEnd = sorted[0]!.end;
  for (let index = 1; index < sorted.length; index += 1) {
    const interval = sorted[index]!;
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  return total + currentEnd - currentStart;
}

function modelSegments(
  turnStart: number,
  turnEnd: number,
  toolIntervals: readonly UsageInterval[],
): UsageInterval[] {
  const sorted = toolIntervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const segments: UsageInterval[] = [];
  let cursor = turnStart;
  for (const tool of sorted) {
    const start = Math.max(turnStart, tool.start);
    const end = Math.min(turnEnd, tool.end);
    if (end <= start) continue;
    if (start > cursor) segments.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < turnEnd) segments.push({ start: cursor, end: turnEnd });
  return segments;
}

export interface DerivedUsageTiming {
  totalMs: number;
  toolMs: number;
  modelMs: number;
  ttftMs: number | null;
}

export function deriveUsageTiming(input: {
  start: number;
  end: number;
  toolIntervals: readonly UsageInterval[];
  assistantTimes: readonly number[];
}): DerivedUsageTiming | null {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end < input.start) return null;
  const totalMs = Math.max(0, input.end - input.start);
  const toolMs = Math.min(totalMs, unionIntervalDurationMs(input.toolIntervals));
  const modelMs = Math.max(0, totalMs - toolMs);
  const ttfts: number[] = [];
  // A turn can stream 100k+ chunks across hundreds of tool gaps. Sort once and
  // binary-search each segment instead of scanning every chunk per segment.
  const times = Float64Array.from(input.assistantTimes).sort();
  for (const segment of modelSegments(input.start, input.end, input.toolIntervals)) {
    let low = 0;
    let high = times.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (times[middle]! < segment.start) low = middle + 1;
      else high = middle;
    }
    const first = times[low];
    if (first !== undefined && first < segment.end) ttfts.push(first - segment.start);
  }
  return {
    totalMs,
    toolMs,
    modelMs,
    ttftMs: ttfts.length > 0
      ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length
      : null,
  };
}
