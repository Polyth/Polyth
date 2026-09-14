import type { RenderMessage, TurnState } from "../../../../apps/web/src/reduce.ts";

export const TURN_STATS_UNKNOWN = "—";

export type TurnStatsVisibilityKey =
  | "showResponseRate"
  | "showWholeTurnRate"
  | "showModelTime"
  | "showToolTime"
  | "showAvgTtft"
  | "showSteps"
  | "showTokens"
  | "showCache"
  | "showCost";

export interface TurnStatsDerived {
  responseTokPerSec: number | null;
  wholeTurnTokPerSec: number | null;
  modelTimeMs: number | null;
  toolTimeMs: number | null;
  avgTtftMs: number | null;
  steps: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachePercent: number | null;
  cost: number | null;
  costKnown: boolean;
  tokensKnown: boolean;
}

const finiteNonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function unionIntervalDurationMs(intervals: ReadonlyArray<{ start: number; end: number }>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (let index = 1; index < sorted.length; index += 1) {
    const interval = sorted[index]!;
    if (interval.start <= curEnd) {
      curEnd = Math.max(curEnd, interval.end);
    } else {
      total += curEnd - curStart;
      curStart = interval.start;
      curEnd = interval.end;
    }
  }
  total += curEnd - curStart;
  return total;
}

function toolIntervalsInWindow(
  messages: readonly RenderMessage[],
  windowStart: number,
  windowEnd: number,
  now: number,
  turnWorking: boolean,
): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const message of messages) {
    if (message.kind !== "tool" || message.undone) continue;
    if (message.time < windowStart || message.time > windowEnd) continue;
    let end = message.finishTime;
    if (end === undefined && turnWorking && (message.status === "running" || message.status === "pending")) {
      end = now;
    }
    if (end === undefined || end <= message.time) continue;
    intervals.push({ start: message.time, end: Math.min(end, windowEnd) });
  }
  return intervals;
}

function countToolsInWindow(
  messages: readonly RenderMessage[],
  windowStart: number,
  windowEnd: number,
): number {
  let count = 0;
  for (const message of messages) {
    if (message.kind !== "tool" || message.undone) continue;
    if (message.time >= windowStart && message.time <= windowEnd) count += 1;
  }
  return count;
}

function modelSegments(
  turnStart: number,
  turnEnd: number,
  toolIntervals: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...toolIntervals].sort((a, b) => a.start - b.start);
  const segments: Array<{ start: number; end: number }> = [];
  let cursor = turnStart;
  for (const tool of sorted) {
    if (tool.start > cursor) segments.push({ start: cursor, end: tool.start });
    cursor = Math.max(cursor, tool.end);
  }
  if (cursor < turnEnd) segments.push({ start: cursor, end: turnEnd });
  return segments;
}

function firstAssistantTimeInSegment(
  messages: readonly RenderMessage[],
  segStart: number,
  segEnd: number,
): number | null {
  let first: number | null = null;
  for (const message of messages) {
    if (message.kind !== "assistant" || message.undone) continue;
    if (message.time < segStart || message.time >= segEnd) continue;
    if (first === null || message.time < first) first = message.time;
  }
  return first;
}

function usageFromTurn(turn: TurnState) {
  const usage = turn.usage;
  if (usage === undefined) {
    return {
      tokensKnown: false,
      costKnown: false,
      input: null as number | null,
      output: null as number | null,
      cachePercent: null as number | null,
      cost: null as number | null,
    };
  }
  const input = finiteNonNegative(usage.tokens.input);
  const output = finiteNonNegative(usage.tokens.output);
  const cacheRead = finiteNonNegative(usage.tokens.cacheRead);
  const eligible = input + cacheRead;
  const cachePercent = eligible > 0 ? cacheRead / eligible * 100 : null;
  return {
    tokensKnown: true,
    costKnown: typeof usage.cost === "number" && Number.isFinite(usage.cost),
    input,
    output,
    cachePercent,
    cost: finiteNonNegative(usage.cost),
  };
}

export function deriveTurnStats(
  turn: TurnState,
  messages: readonly RenderMessage[],
  now = Date.now(),
): TurnStatsDerived {
  const usageBits = usageFromTurn(turn);
  const turnWorking = turn.status === "working";
  const windowStart = turn.startedAt;
  const windowEnd = turn.stoppedAt ?? (turnWorking ? now : undefined);

  if (windowStart === undefined || windowEnd === undefined) {
    return {
      responseTokPerSec: null,
      wholeTurnTokPerSec: null,
      modelTimeMs: null,
      toolTimeMs: null,
      avgTtftMs: null,
      steps: null,
      inputTokens: usageBits.input,
      outputTokens: usageBits.output,
      cachePercent: usageBits.tokensKnown ? usageBits.cachePercent : null,
      cost: usageBits.costKnown ? usageBits.cost : null,
      costKnown: usageBits.costKnown,
      tokensKnown: usageBits.tokensKnown,
    };
  }

  const wholeDurationMs = Math.max(0, windowEnd - windowStart);
  const toolIntervals = toolIntervalsInWindow(messages, windowStart, windowEnd, now, turnWorking);
  const toolTimeMs = unionIntervalDurationMs(toolIntervals);
  const modelTimeMs = Math.max(0, wholeDurationMs - toolTimeMs);
  const steps = countToolsInWindow(messages, windowStart, windowEnd);

  const segments = modelSegments(windowStart, windowEnd, toolIntervals);
  const ttfts: number[] = [];
  for (const segment of segments) {
    const first = firstAssistantTimeInSegment(messages, segment.start, segment.end);
    if (first !== null) ttfts.push(first - segment.start);
  }
  const avgTtftMs = ttfts.length > 0 ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : null;

  const output = usageBits.output ?? 0;
  const responseTokPerSec = output > 0 && modelTimeMs > 0
    ? output / (modelTimeMs / 1000)
    : null;
  const wholeTurnTokPerSec = output > 0 && wholeDurationMs > 0
    ? output / (wholeDurationMs / 1000)
    : null;

  return {
    responseTokPerSec,
    wholeTurnTokPerSec,
    modelTimeMs,
    toolTimeMs,
    avgTtftMs,
    steps,
    inputTokens: usageBits.input,
    outputTokens: usageBits.output,
    cachePercent: usageBits.tokensKnown ? usageBits.cachePercent : null,
    cost: usageBits.costKnown ? usageBits.cost : null,
    costKnown: usageBits.costKnown,
    tokensKnown: usageBits.tokensKnown,
  };
}
