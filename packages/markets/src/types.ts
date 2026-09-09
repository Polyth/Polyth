export type MarketAssetType =
  | "equity"
  | "etf"
  | "index"
  | "crypto"
  | "currency"
  | "commodity"
  | "unknown";

export type MarketRange = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";
export type MarketDataFreshness = "live" | "delayed" | "indicative";
export type MarketCacheState = "fresh" | "stale" | "refreshed";
export type MarketProviderCapability = "quote" | "candles" | "search" | "fundamentals";

export interface MarketQuote {
  symbol: string;
  name?: string;
  assetType?: MarketAssetType;
  currency?: string;
  exchange?: string;
  price: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  volume?: number;
  marketCap?: number;
  asOf: string;
  source: string;
  freshness: MarketDataFreshness;
}

export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MarketCandleSeries {
  symbol: string;
  range: MarketRange;
  candles: MarketCandle[];
  asOf: string;
  source: string;
  freshness: MarketDataFreshness;
}

export interface MarketSearchResult {
  symbol: string;
  name: string;
  exchange?: string;
  assetType: MarketAssetType;
  currency?: string;
  source: string;
}

export interface MarketFundamentals {
  symbol: string;
  exchange?: string;
  marketCap?: number;
  pe?: number;
  eps?: number;
  dividendYield?: number;
  beta?: number;
  sharesOutstanding?: number;
  sector?: string;
  industry?: string;
  asOf: string;
  source: string;
  freshness: MarketDataFreshness;
}

export interface MarketDataResult<T> {
  data: T;
  cache: MarketCacheState;
  cachedAt: string;
  revalidating: boolean;
}
