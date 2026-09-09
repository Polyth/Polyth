import { SwrCache, type SwrCachePolicy } from "./cache.ts";
import { ProviderRegistry, type MarketProvider } from "./providers.ts";
import type { MarketDataResult, MarketQuote } from "./types.ts";

const DEFAULT_QUOTE_POLICY: SwrCachePolicy = {
  softTtlMs: 10_000,
  hardTtlMs: 5 * 60_000,
  maxEntries: 2_000,
};

export interface MarketsServiceOptions {
  providers?: ProviderRegistry;
  quotePolicy?: SwrCachePolicy;
  quoteTimeoutMs?: number;
  now?: () => number;
}

export class MarketsService {
  readonly providers: ProviderRegistry;
  private readonly quotes: SwrCache<MarketQuote>;
  private readonly quotePolicy: SwrCachePolicy;
  private readonly quoteTimeoutMs: number;

  constructor(options: MarketsServiceOptions = {}) {
    this.providers = options.providers ?? new ProviderRegistry({ now: options.now });
    this.quotes = new SwrCache(options.now);
    this.quotePolicy = options.quotePolicy ?? DEFAULT_QUOTE_POLICY;
    this.quoteTimeoutMs = options.quoteTimeoutMs ?? 3_000;
  }

  registerProvider(provider: MarketProvider): void {
    this.providers.register(provider);
  }

  async quote(symbol: string): Promise<MarketDataResult<MarketQuote>> {
    const normalized = normalizeSymbol(symbol);
    const result = await this.quotes.get(normalized, this.quotePolicy, async () => {
      const loaded = await this.providers.run("quote", async (provider) => {
        if (!provider.quote) throw new Error(`${provider.id} does not implement quote`);
        return await provider.quote(normalized, AbortSignal.timeout(this.quoteTimeoutMs));
      });
      return loaded.value.source ? loaded.value : { ...loaded.value, source: loaded.providerId };
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
