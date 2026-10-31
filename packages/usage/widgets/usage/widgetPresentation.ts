import type { JsonObject } from "@polyth/contracts";
import type { UsageChartBucket } from "../../src/analytics/contracts.ts";

export type UsageWidgetScope = "session" | "project" | "global";
export type UsageWidgetMetric = "context" | "tokens" | "cost";

/**
 * Whether the Workspace panel asked for the glance: the smaller of a widget's
 * two panel sizes (`compact`, or `wide` for Project). The larger one, and any
 * host that sets no panel size, gets the full card.
 */
export const usageWidgetCompact = (panelSize: unknown): boolean => panelSize === "compact" || panelSize === "wide";

export function usageWidgetPreferences(config: Readonly<JsonObject>, scope: UsageWidgetScope) {
  return {
    layout: config.layout === "summary" || config.layout === "metrics" ? config.layout : "auto",
    primary: config.primary === "cost" || config.primary === "tokens"
      ? config.primary : scope === "session" ? "context" : "tokens",
    range: scope === "session" || config.range === "all" ? "all"
      : config.range === "7d" || config.range === "90d" ? config.range : "30d",
    showActivity: config.showActivity !== false,
    showBreakdown: config.showBreakdown !== false,
  } as const;
}

export interface UsageWidgetBar {
  label: string;
  value: number | null;
  complete: boolean;
  height: number;
}

/** Bound the DOM without sampling away activity or turning unknown buckets into zero. */
export function usageWidgetBars(
  buckets: readonly UsageChartBucket[],
  metric: "tokens" | "cost",
  labelOf: (bucket: UsageChartBucket) => string = (bucket) => bucket.label,
): UsageWidgetBar[] {
  const result: UsageWidgetBar[] = [];
  const count = Math.min(28, buckets.length);
  for (let index = 0; index < count; index += 1) {
    const from = Math.floor(index * buckets.length / count);
    const to = Math.floor((index + 1) * buckets.length / count);
    const first = buckets[from]!;
    const last = buckets[to - 1]!;
    let value: number | null = null;
    let complete = true;
    for (let position = from; position < to; position += 1) {
      const values = buckets[position]!.values;
      const sample = values[metric];
      if (sample !== null && Number.isFinite(sample) && sample >= 0) value = (value ?? 0) + sample;
      else complete = false;
      complete &&= metric === "cost" ? values.costComplete : values.tokensComplete;
    }
    result.push({ label: first === last ? labelOf(first) : `${labelOf(first)} – ${labelOf(last)}`, value, complete, height: 0 });
  }
  const maximum = Math.max(0, ...result.map((bar) => bar.value ?? 0));
  for (const bar of result) bar.height = maximum > 0 ? (bar.value ?? 0) / maximum * 100 : 0;
  return result;
}
