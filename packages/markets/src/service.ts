import { SwrCache, type SwrCachePolicy } from "./cache.ts";
import { ProviderRegistry, type MarketProvider } from "./providers.ts";
import type {
  MarketCandleSeries,
  MarketDataResult,
  MarketFundamentals,
  MarketQuote,
  MarketRange,
  MarketSearchResult,
} from "./types.ts";

const QUOTE_POLICY: SwrCachePolicy = { softTtlMs: 10_000, hardTtlMs: 5 * 60_000, maxEntries: 2_000 };
const CANDLE_POLICY: SwrCachePolicy = { softTtlMs: 30_000, hardTtlMs: 60 * 60_000, maxEntries: 100 };
const SEARCH_POLICY: SwrCachePolicy = { softTtlMs: 12 * 60 * 60_000, hardTtlMs: 24 * 60 * 60_000, maxEntries: 500 };
const FUNDAMENTALS_POLICY: SwrCachePolicy = { softTtlMs: 30 * 60_000, hardTtlMs: 24 * 60 * 60_000, maxEntries: 1_000 };
const RANGES = new Set<MarketRange>(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]);

export interface MarketsServiceOptions {
  providers?: ProviderRegistry;
  quotePolicy?: SwrCachePolicy;
  now?: () => number;
}

export class MarketsService {
  readonly providers: ProviderRegistry;
  private readonly quotes: SwrCache<MarketQuote>;
  private readonly candleSeries: SwrCache<MarketCandleSeries>;
  private readonly searches: SwrCache<MarketSearchResult[]>;
  private readonly fundamentalsCache: SwrCache<MarketFundamentals>;
  private readonly quotePolicy: SwrCachePolicy;

  constructor(options: MarketsServiceOptions = {}) {
    this.providers = options.providers ?? new ProviderRegistry({ now: options.now });
    this.quotes = new SwrCache(options.now);
    this.candleSeries = new SwrCache(options.now);
    this.searches = new SwrCache(options.now);
    this.fundamentalsCache = new SwrCache(options.now);
    this.quotePolicy = options.quotePolicy ?? QUOTE_POLICY;
  }

  registerProvider(provider: MarketProvider): void {
    this.providers.register(provider);
  }

  quote(symbol: string): Promise<MarketDataResult<MarketQuote>> {
    const normalized = normalizeSymbol(symbol);
    return this.cached(this.quotes, normalized, this.quotePolicy, "quote", 3_000, (provider, signal) =>
      provider.quote!(normalized, signal));
  }

  candles(symbol: string, range: MarketRange): Promise<MarketDataResult<MarketCandleSeries>> {
    const normalized = normalizeSymbol(symbol);
    const normalizedRange = normalizeRange(range);
    return this.cached(this.candleSeries, `${normalized}:${normalizedRange}`, CANDLE_POLICY, "candles", 5_000, (provider, signal) =>
      provider.candles!(normalized, normalizedRange, signal));
  }

  search(query: string): Promise<MarketDataResult<MarketSearchResult[]>> {
    const normalized = normalizeQuery(query);
    return this.cached(this.searches, normalized.toLowerCase(), SEARCH_POLICY, "search", 3_000, (provider, signal) =>
      provider.search!(normalized, signal));
  }

  fundamentals(symbol: string): Promise<MarketDataResult<MarketFundamentals>> {
    const normalized = normalizeSymbol(symbol);
    return this.cached(this.fundamentalsCache, normalized, FUNDAMENTALS_POLICY, "fundamentals", 4_000, (provider, signal) =>
      provider.fundamentals!(normalized, signal));
  }

  private async cached<T>(
    cache: SwrCache<T>,
    key: string,
    policy: SwrCachePolicy,
    capability: "quote" | "candles" | "search" | "fundamentals",
    timeoutMs: number,
    invoke: (provider: MarketProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<MarketDataResult<T>> {
    const result = await cache.get(key, policy, async () => {
      const loaded = await this.providers.run(capability, (provider) =>
        invoke(provider, AbortSignal.timeout(timeoutMs)));
      return loaded.value;
    });
    return {
      data: result.value,
      cache: result.state,
      cachedAt: new Date(result.updatedAt).toISOString(),
      revalidating: result.revalidating,
    };
  }
}

export function createMarketsService(options: MarketsServiceOptions = {}): MarketsService {
  return new MarketsService(options);
}

export function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized || normalized.length > 32 || !/^[A-Z0-9.^=_:/-]+$/.test(normalized)) {
    throw Object.assign(new Error("invalid market symbol"), { code: "invalid-input" });
  }
  return normalized;
}

export function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized || normalized.length > 80) {
    throw Object.assign(new Error("invalid market search query"), { code: "invalid-input" });
  }
  return normalized;
}

export function normalizeRange(range: string): MarketRange {
  if (!RANGES.has(range as MarketRange)) {
    throw Object.assign(new Error("invalid market range"), { code: "invalid-input" });
  }
  return range as MarketRange;
}
