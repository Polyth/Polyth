import { SwrCache, type SwrCachePolicy } from "./cache.ts";
import { ProviderRegistry, type MarketProvider } from "./providers.ts";
import { dedupeMarketNews } from "./providers/news.ts";
import type {
  MarketCandleSeries,
  MarketDataResult,
  MarketFundamentals,
  MarketNewsItem,
  MarketQuote,
  MarketRange,
  MarketResearchContext,
  MarketSearchResult,
} from "./types.ts";

const QUOTE_POLICY: SwrCachePolicy = { softTtlMs: 10_000, hardTtlMs: 5 * 60_000, maxEntries: 2_000 };
const CANDLE_POLICY: SwrCachePolicy = { softTtlMs: 30_000, hardTtlMs: 60 * 60_000, maxEntries: 100 };
const SEARCH_POLICY: SwrCachePolicy = { softTtlMs: 12 * 60 * 60_000, hardTtlMs: 24 * 60 * 60_000, maxEntries: 500 };
const FUNDAMENTALS_POLICY: SwrCachePolicy = { softTtlMs: 30 * 60_000, hardTtlMs: 24 * 60 * 60_000, maxEntries: 1_000 };
const NEWS_POLICY: SwrCachePolicy = { softTtlMs: 2 * 60_000, hardTtlMs: 30 * 60_000, maxEntries: 1_000 };
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
  private readonly newsCache: SwrCache<MarketNewsItem[]>;
  private readonly quotePolicy: SwrCachePolicy;
  private readonly now: () => number;

  constructor(options: MarketsServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.providers = options.providers ?? new ProviderRegistry({ now: this.now });
    this.quotes = new SwrCache(this.now);
    this.candleSeries = new SwrCache(this.now);
    this.searches = new SwrCache(this.now);
    this.fundamentalsCache = new SwrCache(this.now);
    this.newsCache = new SwrCache(this.now);
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

  news(symbol: string): Promise<MarketDataResult<MarketNewsItem[]>> {
    const normalized = normalizeSymbol(symbol);
    return this.cachedAll(this.newsCache, normalized, NEWS_POLICY, "news", 4_000, (provider, signal) =>
      provider.news!(normalized, signal), (values) => dedupeMarketNews(values.flat()));
  }

  async context(symbol: string, range: MarketRange = "1M"): Promise<MarketResearchContext> {
    const normalized = normalizeSymbol(symbol);
    const normalizedRange = normalizeRange(range);
    const settled = await Promise.allSettled([
      this.quote(normalized),
      this.fundamentals(normalized),
      this.candles(normalized, normalizedRange),
      this.news(normalized),
    ]);
    const [quoteResult, fundamentalsResult, candlesResult, newsResult] = settled;
    const errors: string[] = [];
    const collectError = (label: string, result: PromiseSettledResult<unknown>) => {
      if (result.status === "rejected") errors.push(`${label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    };
    collectError("quote", quoteResult);
    collectError("fundamentals", fundamentalsResult);
    collectError("candles", candlesResult);
    collectError("news", newsResult);

    const candles = candlesResult.status === "fulfilled" ? candlesResult.value.data : undefined;
    const firstClose = candles?.candles[0]?.close;
    const lastClose = candles?.candles.at(-1)?.close;
    const performance = candles && firstClose !== undefined && lastClose !== undefined && firstClose !== 0
      ? {
          range: normalizedRange,
          firstClose,
          lastClose,
          changePercent: ((lastClose - firstClose) / firstClose) * 100,
          source: candles.source,
          freshness: candles.freshness,
        }
      : undefined;

    return {
      symbol: normalized,
      generatedAt: new Date(this.now()).toISOString(),
      ...(quoteResult.status === "fulfilled" ? { quote: quoteResult.value.data } : {}),
      ...(fundamentalsResult.status === "fulfilled" ? { fundamentals: fundamentalsResult.value.data } : {}),
      ...(performance ? { performance } : {}),
      news: newsResult.status === "fulfilled" ? newsResult.value.data.slice(0, 12) : [],
      errors,
    };
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
    return this.result(result);
  }

  private async cachedAll<T>(
    cache: SwrCache<T>,
    key: string,
    policy: SwrCachePolicy,
    capability: "news",
    timeoutMs: number,
    invoke: (provider: MarketProvider, signal: AbortSignal) => Promise<T>,
    merge: (values: T[]) => T,
  ): Promise<MarketDataResult<T>> {
    const result = await cache.get(key, policy, async () => {
      const loaded = await this.providers.runAll(capability, (provider) =>
        invoke(provider, AbortSignal.timeout(timeoutMs)));
      return merge(loaded.map((item) => item.value));
    });
    return this.result(result);
  }

  private result<T>(result: { value: T; state: "fresh" | "stale" | "refreshed"; updatedAt: number; revalidating: boolean }): MarketDataResult<T> {
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
