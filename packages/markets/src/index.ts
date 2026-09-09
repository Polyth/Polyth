export { SwrCache, type SwrCachePolicy, type SwrCacheResult } from "./cache.ts";
export {
  ProviderRegistry,
  type MarketProvider,
  type ProviderHealth,
  type ProviderRegistryOptions,
} from "./providers.ts";
export {
  MarketsService,
  createMarketsService,
  normalizeSymbol,
  type MarketsServiceOptions,
} from "./service.ts";
export type {
  MarketAssetType,
  MarketCacheState,
  MarketCandle,
  MarketDataFreshness,
  MarketDataResult,
  MarketProviderCapability,
  MarketQuote,
  MarketSearchResult,
} from "./types.ts";
