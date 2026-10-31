import type { MarketScreenerPage, MarketScreenerQuery } from "../src/screener.ts";
import { untrustedMarketDataBlock } from "./untrusted.ts";

export function buildScreenerHandoffText(page: MarketScreenerPage, query: MarketScreenerQuery): string {
  const evidence = {
    generatedAt: page.generatedAt,
    totalMatching: page.total,
    filters: query,
    rows: page.rows,
  };
  return [
    "Analyze this market screener result. Identify meaningful clusters, outliers, and a small number of companies worth deeper research. Do not infer quality or causality from price action alone.",
    "",
    ...untrustedMarketDataBlock("screener page", [JSON.stringify(evidence, null, 2)]),
    "",
    "This is only the current screener page, not the whole market universe. Verify time-sensitive claims and company-specific conclusions before relying on them.",
  ].join("\n");
}
