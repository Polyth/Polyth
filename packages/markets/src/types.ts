export type MarketAssetType =
  | "equity"
  | "etf"
  | "index"
  | "crypto"
  | "currency"
  | "commodity"
  | "unknown";

export type MarketDataFreshness = "live" | "delayed" | "indicative";
export type MarketCacheState = "fresh" | "stale" | "refreshed";
export type MarketProviderCapability = "quote" | "candles" | "search";

export interface MarketQuote {
  symbol: string;
  name?: string;
  assetType?: MarketAssetType;
  currency: string;
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

export interface MarketSearchResult {
  symbol: string;
  name: string;
  exchange?: string;
  assetType: MarketAssetType;
  currency?: string;
  source: string;
}

export interface MarketDataResult<T> {
  data: T;
  cache: MarketCacheState;
  cachedAt: string;
  revalidating: boolean;
}
