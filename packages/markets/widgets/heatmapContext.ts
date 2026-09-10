import type { MarketHeatmapQuery, MarketHeatmapSnapshot } from "../src/heatmap.ts";
import { untrustedMarketDataBlock } from "./untrusted.ts";

const MAX_HANDOFF_CELLS = 80;

export function buildHeatmapHandoffText(snapshot: MarketHeatmapSnapshot, query: MarketHeatmapQuery): string {
  const evidence = {
    generatedAt: snapshot.generatedAt,
    query,
    totalMatching: snapshot.total,
    sectorSummaries: snapshot.sectorSummaries,
    companies: snapshot.cells.slice(0, MAX_HANDOFF_CELLS),
    companiesTruncated: snapshot.cells.length > MAX_HANDOFF_CELLS,
  };
  return [
    "Analyze this market heatmap snapshot. Identify sector leadership/weakness, concentration, notable outliers, and a small number of companies worth deeper research. Do not infer causality from price action alone.",
    "",
    ...untrustedMarketDataBlock("heatmap snapshot", [JSON.stringify(evidence, null, 2)]),
    "",
    "Heatmap area represents market capitalization and daily move is observational only. Verify time-sensitive and company-specific conclusions before relying on them.",
  ].join("\n");
}
