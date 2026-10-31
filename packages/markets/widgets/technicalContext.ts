import type { MarketTechnicalSnapshot } from "../src/technicals.ts";
import { untrustedMarketDataBlock } from "./untrusted.ts";

const MAX_POINTS = 60;

export function buildTechnicalHandoffText(snapshot: MarketTechnicalSnapshot): string {
  const evidence = {
    symbol: snapshot.symbol,
    range: snapshot.range,
    asOf: snapshot.asOf,
    source: snapshot.source,
    freshness: snapshot.freshness,
    signals: snapshot.signals,
    latest: snapshot.latest,
    recentPoints: snapshot.points.slice(-MAX_POINTS),
    pointsTruncated: snapshot.points.length > MAX_POINTS,
  };
  return [
    `Analyze the technical state of ${snapshot.symbol} using the derived indicators below. Explain trend, momentum, MACD, and Bollinger context, identify conflicting signals, and suggest what price/indicator developments would invalidate the current reading.`,
    "Technical indicators are descriptive transforms of historical market data, not predictions or investment advice.",
    "",
    ...untrustedMarketDataBlock("technical indicator data", [JSON.stringify(evidence, null, 2)]),
    "",
    "Do not invent catalysts or causal explanations from technical data alone. Verify any time-sensitive market claims separately.",
  ].join("\n");
}
