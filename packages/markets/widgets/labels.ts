import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { MarketsMessageKey } from "../src/i18n/en.ts";

/** Enum values that arrive from the server are translated for display only;
 *  their raw values stay the wire contract. */

const label = (key: MarketsMessageKey): string => tr(key);

export function freshnessLabel(value: string): string {
  switch (value) {
    case "live": return label("markets.freshness.live");
    case "delayed": return label("markets.freshness.delayed");
    case "indicative": return label("markets.freshness.indicative");
    default: return value;
  }
}

export function cacheLabel(value: string): string {
  switch (value) {
    case "fresh": return label("markets.cache.fresh");
    case "stale": return label("markets.cache.stale");
    case "refreshed": return label("markets.cache.refreshed");
    default: return value;
  }
}

export function assetTypeLabel(value: string): string {
  switch (value) {
    case "equity": return label("markets.assetType.equity");
    case "etf": return label("markets.assetType.etf");
    case "index": return label("markets.assetType.index");
    case "crypto": return label("markets.assetType.crypto");
    case "currency": return label("markets.assetType.currency");
    case "commodity": return label("markets.assetType.commodity");
    case "unknown": return label("markets.assetType.unknown");
    default: return value;
  }
}

export function impactLabel(value: string): string {
  switch (value) {
    case "Low": return label("markets.impact.low");
    case "Medium": return label("markets.impact.medium");
    case "High": return label("markets.impact.high");
    case "Holiday": return label("markets.impact.holiday");
    default: return value;
  }
}

export function macroIndicatorLabel(id: string, fallback: string): string {
  switch (id) {
    case "fed-funds": return label("markets.macro.fedFunds");
    case "treasury-2y": return label("markets.macro.treasury2y");
    case "treasury-10y": return label("markets.macro.treasury10y");
    case "unemployment": return label("markets.macro.unemployment");
    case "yield-curve-10y2y": return label("markets.macro.yieldSpread");
    case "cpi-yoy": return label("markets.macro.cpiYoy");
    default: return fallback;
  }
}

export function signalLabel(value: string): string {
  switch (value) {
    case "unknown": return label("markets.signal.unknown");
    case "bullish": return label("markets.signal.bullish");
    case "bearish": return label("markets.signal.bearish");
    case "neutral": return label("markets.signal.neutral");
    case "overbought": return label("markets.signal.overbought");
    case "oversold": return label("markets.signal.oversold");
    case "above": return label("markets.signal.above");
    case "below": return label("markets.signal.below");
    case "inside": return label("markets.signal.inside");
    default: return value;
  }
}
