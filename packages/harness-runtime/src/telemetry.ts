import type { ContextWindowState, TelemetryQuality, TokenUsage } from "@polyth/contracts";

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const optionalCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;

/** Normalize provider token counters without using truthiness: zero is a
 * valid native sample and must not collapse into "telemetry absent". */
export function normalizeTokenUsage(input: {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}): TokenUsage {
  const reasoning = optionalCount(input.reasoning);
  const cacheRead = optionalCount(input.cacheRead);
  const cacheWrite = optionalCount(input.cacheWrite);
  return {
    input: count(input.input),
    output: count(input.output),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

/** One provider-neutral context occupancy calculation for every harness. */
export function contextWindowTelemetry(input: {
  source: TelemetryQuality;
  updatedAt?: number;
  usedTokens?: unknown;
  limitTokens?: unknown;
  compaction?: ContextWindowState["compaction"];
}): ContextWindowState {
  const usedTokens = optionalCount(input.usedTokens);
  const limitTokens = optionalCount(input.limitTokens);
  return {
    source: input.source,
    updatedAt: input.updatedAt ?? Date.now(),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(usedTokens !== undefined && limitTokens !== undefined
      ? {
          remainingTokens: Math.max(0, limitTokens - usedTokens),
          fraction: limitTokens > 0 ? usedTokens / limitTokens : undefined,
        }
      : {}),
    ...(input.compaction ? { compaction: input.compaction } : {}),
  };
}
