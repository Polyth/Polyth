// Prompt-cache facts about an agent, and whether keeping its cache warm pays.
// Browser-safe: the editor shows the same numbers the server acts on.
import { providerCacheTtlMs } from "@polyth/usage/cache-ttl";
import type { ScheduleRunRecord } from "./index.ts";

export interface RunCache {
  runId: string;
  at: number;
  /** Uncached prompt tokens (provider-normalized: excludes cache read/write). */
  input: number;
  read: number;
  write: number;
  /** Share of the prompt served from cache; null without cache telemetry. */
  ratio: number | null;
}

/** Runs that reported usage, newest first. */
export function runCacheStats(history: readonly ScheduleRunRecord[] | undefined, limit = 12): RunCache[] {
  const out: RunCache[] = [];
  for (const run of history ?? []) {
    if (!run.tokens) continue;
    const read = run.tokens.cacheRead ?? 0;
    const write = run.tokens.cacheWrite ?? 0;
    const input = run.tokens.input;
    const total = input + read + write;
    const reported = run.tokens.cacheRead !== undefined || run.tokens.cacheWrite !== undefined;
    out.push({ runId: run.runId, at: run.finishedAt ?? run.startedAt, input, read, write, ratio: reported && total > 0 ? read / total : null });
    if (out.length >= limit) break;
  }
  return out;
}

/** measured: the harness reported cache reads; none: it reports usage but
 *  never cache; unknown: no usage telemetry yet. */
export function cacheTelemetry(history: readonly ScheduleRunRecord[] | undefined): "measured" | "none" | "unknown" {
  const runs = runCacheStats(history, 50);
  if (!runs.length) return "unknown";
  return runs.some((run) => run.read > 0) ? "measured" : "none";
}

/** Price of a cached read and of writing the prefix again, as shares of the
 *  normal input price (Anthropic: 0.1× and 1.25×). A cold start costs the
 *  write instead of a read. */
export const CACHE_READ_PRICE = 0.1;
export const CACHE_WRITE_PRICE = 1.25;
/** A keep-alive also pays its own tiny turn; counted as a share of the prefix. */
const PING_OVERHEAD = 0.02;
/** Ping this long before the cache would expire. */
export const WARM_MARGIN_MS = 60_000;

export type WarmReason =
  | "off" | "not-rolling" | "no-schedule" | "no-telemetry" | "unknown-ttl"
  | "within-ttl" | "too-far" | "wait" | "due";

export interface WarmPlan {
  reason: WarmReason;
  ttlMs?: number;
  /** Keep-alives needed to bridge the gap to the next wake. */
  pings?: number;
  /** Their cost and a cold start's, as shares of the prefix's input price. */
  pingCost?: number;
  coldCost?: number;
  nextPingAt?: number;
}

/** Whether to send a keep-alive now. Pings bridge a gap only when the next
 *  wake is known (a schedule), the provider's cache lifetime is documented,
 *  the harness has measured cache reads, and pinging is cheaper than paying
 *  for a cold start. Event wakes are unpredictable and never warmed for. */
export function planWarm(input: {
  keepWarm?: "off" | "auto";
  rolling: boolean;
  nextRunAt: number | null;
  lastActivityAt: number | undefined;
  providerId: string | undefined;
  telemetry: "measured" | "none" | "unknown";
}, now: number): WarmPlan {
  if (input.keepWarm !== "auto") return { reason: "off" };
  if (!input.rolling) return { reason: "not-rolling" };
  if (input.telemetry !== "measured") return { reason: "no-telemetry" };
  const ttlMs = providerCacheTtlMs(input.providerId) ?? undefined;
  if (!ttlMs) return { reason: "unknown-ttl" };
  if (input.nextRunAt === null || input.lastActivityAt === undefined) return { reason: "no-schedule", ttlMs };
  const gap = input.nextRunAt - input.lastActivityAt;
  if (gap <= ttlMs) return { reason: "within-ttl", ttlMs };
  const pings = Math.ceil(gap / (ttlMs - WARM_MARGIN_MS)) - 1;
  const pingCost = pings * (CACHE_READ_PRICE + PING_OVERHEAD);
  const coldCost = CACHE_WRITE_PRICE - CACHE_READ_PRICE;
  if (pingCost >= coldCost) return { reason: "too-far", ttlMs, pings, pingCost, coldCost };
  const nextPingAt = input.lastActivityAt + ttlMs - WARM_MARGIN_MS;
  return { reason: now >= nextPingAt ? "due" : "wait", ttlMs, pings, pingCost, coldCost, nextPingAt };
}

export const KEEP_ALIVE_PROMPT =
  "Automatic keep-alive from Polyth to keep this conversation's prompt cache warm. Do nothing; reply with just: OK";
