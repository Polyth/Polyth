import type { MarketDataResult, MarketMacroSnapshot, MarketQuote } from "../src/types.ts";
import { untrustedMarketDataBlock } from "./untrusted.ts";

export function buildOverviewHandoffText(
  macro: MarketMacroSnapshot | null,
  crypto: MarketDataResult<MarketQuote[]> | null,
): string {
  const evidence = {
    macroGeneratedAt: macro?.generatedAt,
    cryptoCachedAt: crypto?.cachedAt,
    macroIndicators: macro?.indicators ?? [],
    majorMarkets: macro?.markets ?? [],
    crypto: crypto?.data ?? [],
    partialErrors: macro?.errors ?? [],
  };
  return [
    "Analyze the current macro and crypto market snapshot. Identify what is materially notable, cross-asset tensions, risk-on/risk-off signals, and what deserves follow-up research. Do not invent causal explanations from price moves alone.",
    "",
    ...untrustedMarketDataBlock("macro and crypto snapshot", [JSON.stringify(evidence, null, 2)]),
    "",
    "Treat all values as observational market data. Verify time-sensitive conclusions against current primary sources before relying on them.",
  ].join("\n");
}
