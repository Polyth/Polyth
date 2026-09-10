import { createApiTransport } from "@polyth/web-sdk";
import type { MarketEconomicEvent, MarketEarningsCalendarEntry } from "../src/calendar.ts";
import type {
  MarketCandleSeries,
  MarketComparison,
  MarketDataResult,
  MarketEarningsSurprise,
  MarketFiling,
  MarketFundamentals,
  MarketMacroSnapshot,
  MarketNewsItem,
  MarketQuote,
  MarketRange,
  MarketResearchContext,
  MarketSearchResult,
} from "../src/types.ts";
import type { MarketHeatmapQuery, MarketHeatmapSnapshot } from "../src/heatmap.ts";
import type { MarketPortfolio, MarketPortfolioSnapshot } from "../src/portfolio.ts";
import type { MarketScreenerPage, MarketScreenerQuery } from "../src/screener.ts";
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
  earnings(symbol: string, signal?: AbortSignal): Promise<MarketDataResult<MarketEarningsSurprise[]>> {
    return transport.get(`/api/markets/earnings?symbol=${encodeURIComponent(symbol)}`, { signal });
  },
  filings(
    symbol: string,
    forms: readonly string[] = ["10-K", "10-Q", "8-K", "20-F", "6-K"],
    limit = 30,
    signal?: AbortSignal,
  ): Promise<MarketDataResult<MarketFiling[]>> {
    const params = new URLSearchParams({
      symbol,
      forms: forms.join(","),
      limit: String(limit),
    });
    return transport.get(`/api/markets/filings?${params}`, { signal });
  },
  macro(signal?: AbortSignal): Promise<MarketMacroSnapshot> {
    return transport.get("/api/markets/macro", { signal });
  },
  crypto(signal?: AbortSignal): Promise<MarketDataResult<MarketQuote[]>> {
    return transport.get("/api/markets/crypto", { signal });
  },
  economicCalendar(signal?: AbortSignal): Promise<MarketDataResult<MarketEconomicEvent[]>> {
    return transport.get("/api/markets/calendar/economic", { signal });
  },
  earningsCalendar(symbols: readonly string[], signal?: AbortSignal): Promise<MarketDataResult<MarketEarningsCalendarEntry[]>> {
    return transport.get(`/api/markets/calendar/earnings?symbols=${encodeURIComponent(symbols.join(","))}`, { signal });
  },
  screener(query: MarketScreenerQuery, signal?: AbortSignal): Promise<MarketScreenerPage> {
    const params = new URLSearchParams();
    if (query.sector) params.set("sector", query.sector);
    if (query.changeMin !== undefined) params.set("changeMin", String(query.changeMin));
    if (query.marketCapMin !== undefined) params.set("marketCapMin", String(query.marketCapMin));
    if (query.volumeMin !== undefined) params.set("volumeMin", String(query.volumeMin));
    if (query.sort) params.set("sort", query.sort);
    if (query.direction) params.set("dir", query.direction);
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return transport.get(`/api/markets/screener?${params}`, { signal });
  },
  heatmap(query: MarketHeatmapQuery = {}, signal?: AbortSignal): Promise<MarketHeatmapSnapshot> {
    const params = new URLSearchParams();
    if (query.sector) params.set("sector", query.sector);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return transport.get(`/api/markets/heatmap?${params}`, { signal });
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
  portfolio(signal?: AbortSignal): Promise<MarketPortfolio> {
    return transport.get("/api/markets/portfolio", { signal });
  },
  savePortfolio(document: MarketPortfolio, signal?: AbortSignal): Promise<MarketPortfolio> {
    return transport.put("/api/markets/portfolio", document, { signal });
  },
  portfolioSnapshot(signal?: AbortSignal): Promise<MarketPortfolioSnapshot> {
    return transport.get("/api/markets/portfolio/snapshot", { signal });
  },
};
