import type { MarketCandleSeries, MarketFundamentals, MarketQuote, MarketRange } from "../src/types.ts";

export interface MarketHandoffSnapshot {
  symbol: string;
  range: MarketRange;
  quote?: MarketQuote;
  fundamentals?: MarketFundamentals;
  candles?: MarketCandleSeries;
}

const num = (value: number | undefined, digits = 2): string => value === undefined ? "unknown" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const pct = (value: number | undefined): string => value === undefined ? "unknown" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

export function buildMarketHandoffText(snapshot: MarketHandoffSnapshot): string {
  const quote = snapshot.quote;
  const fundamentals = snapshot.fundamentals;
  const candles = snapshot.candles?.candles ?? [];
  const first = candles[0]?.close;
  const last = candles.at(-1)?.close;
  const rangeReturn = first !== undefined && last !== undefined && first !== 0
    ? ((last - first) / first) * 100
    : undefined;
  const sources = [...new Set([
    quote?.source,
    fundamentals?.source,
    snapshot.candles?.source,
  ].filter((source): source is string => !!source))];

  return [
    `Market research context — ${snapshot.symbol}`,
    quote?.asOf ? `Quote as of: ${quote.asOf}` : "Quote as of: unavailable",
    "",
    "Price",
    `- Last: ${num(quote?.price, 4)}${quote?.currency ? ` ${quote.currency}` : ""}`,
    `- Today: ${pct(quote?.changePercent)}${quote?.change !== undefined ? ` (${num(quote.change, 4)})` : ""}`,
    `- Previous close: ${num(quote?.previousClose, 4)}`,
    `- ${snapshot.range} return from available candles: ${pct(rangeReturn)}`,
    "",
    "Fundamentals",
    `- Market cap: ${num(fundamentals?.marketCap, 0)}`,
    `- P/E: ${num(fundamentals?.pe)}`,
    `- EPS: ${num(fundamentals?.eps)}`,
    `- Dividend yield: ${fundamentals?.dividendYield === undefined ? "unknown" : `${(fundamentals.dividendYield * 100).toFixed(2)}%`}`,
    `- Beta: ${num(fundamentals?.beta)}`,
    `- Sector: ${fundamentals?.sector ?? "unknown"}`,
    `- Industry: ${fundamentals?.industry ?? "unknown"}`,
    "",
    `Data sources: ${sources.length ? sources.join(", ") : "unknown"}`,
    `Freshness: ${quote?.freshness ?? snapshot.candles?.freshness ?? fundamentals?.freshness ?? "unknown"}`,
    "",
    "Analyze what is materially notable about this asset now: explain the recent move, valuation/fundamental context, concrete risks, and what is worth watching next. Use current web research to verify time-sensitive causes or news; do not infer a causal story from price movement alone.",
  ].join("\n");
}
