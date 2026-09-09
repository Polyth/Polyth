import { createApiTransport } from "@polyth/web-sdk";
import type {
  MarketCandleSeries,
  MarketDataResult,
  MarketFundamentals,
  MarketQuote,
  MarketRange,
  MarketSearchResult,
} from "../src/types.ts";

const transport = createApiTransport();

export interface MarketQuoteBatch {
  items: MarketDataResult<MarketQuote>[];
  errors: Array<{ symbol: string; message: string }>;
}

export const marketsApi = {
  quotes(symbols: readonly string[], signal?: AbortSignal): Promise<MarketQuoteBatch> {
    const query = encodeURIComponent(symbols.join(","));
    return transport.get(`/api/markets/quote?symbols=${query}`, { signal });
  },
  search(query: string, signal?: AbortSignal): Promise<MarketDataResult<MarketSearchResult[]>> {
    return transport.get(`/api/markets/search?q=${encodeURIComponent(query)}`, { signal });
  },
  candles(symbol: string, range: MarketRange, signal?: AbortSignal): Promise<MarketDataResult<MarketCandleSeries>> {
    return transport.get(`/api/markets/candles?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`, { signal });
  },
  fundamentals(symbol: string, signal?: AbortSignal): Promise<MarketDataResult<MarketFundamentals>> {
    return transport.get(`/api/markets/fundamentals?symbol=${encodeURIComponent(symbol)}`, { signal });
  },
};
