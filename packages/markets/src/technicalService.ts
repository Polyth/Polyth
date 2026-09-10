import { calculateMarketTechnicals, type MarketTechnicalSnapshot } from "./technicals.ts";
import type { MarketCandleSeries, MarketDataResult, MarketRange } from "./types.ts";

export interface MarketTechnicalCandleSource {
  candles(symbol: string, range: MarketRange): Promise<MarketDataResult<MarketCandleSeries>>;
}

export async function loadMarketTechnicals(
  source: MarketTechnicalCandleSource,
  symbol: string,
  range: MarketRange,
): Promise<MarketDataResult<MarketTechnicalSnapshot>> {
  const candles = await source.candles(symbol, range);
  return {
    ...candles,
    data: calculateMarketTechnicals(candles.data),
  };
}
