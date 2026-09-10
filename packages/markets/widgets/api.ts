import { createApiTransport } from "@polyth/web-sdk";
import type {
  MarketCandleSeries,
  MarketComparison,
  MarketDataResult,
  MarketFundamentals,
  MarketNewsItem,
  MarketQuote,
  MarketRange,
  MarketResearchContext,
  MarketSearchResult,
} from "../src/types.ts";
import type { MarketWatchlists } from "../src/watchlists.ts";

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
  news(symbol: string, signal?: AbortSignal): Promise<MarketDataResult<MarketNewsItem[]>> {
    return transport.get(`/api/markets/news?symbol=${encodeURIComponent(symbol)}`, { signal });
  },
  context(symbol: string, range: MarketRange, signal?: AbortSignal): Promise<MarketResearchContext> {
    return transport.get(`/api/markets/context?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`, { signal });
  },
  compare(symbols: readonly string[], range: MarketRange, signal?: AbortSignal): Promise<MarketComparison> {
    return transport.get(`/api/markets/compare?symbols=${encodeURIComponent(symbols.join(","))}&range=${encodeURIComponent(range)}`, { signal });
  },
  watchlists(signal?: AbortSignal): Promise<MarketWatchlists> {
    return transport.get("/api/markets/watchlists", { signal });
  },
  saveWatchlists(document: MarketWatchlists, signal?: AbortSignal): Promise<MarketWatchlists> {
    return transport.put("/api/markets/watchlists", document, { signal });
  },
};
