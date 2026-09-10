import type { MarketsService } from "./service.ts";
import { createNasdaqProvider, type NasdaqProviderOptions } from "./providers/nasdaq.ts";
import { createGoogleNewsProvider, createYahooNewsProvider, type NewsProviderOptions } from "./providers/news.ts";
import { createSecProvider, type SecProviderOptions } from "./providers/sec.ts";
import { createStooqProvider, type StooqProviderOptions } from "./providers/stooq.ts";
import { createTradingViewProvider, type TradingViewProviderOptions } from "./providers/tradingview.ts";
import { createYahooProvider, type YahooProviderOptions } from "./providers/yahoo.ts";
import type { FetchLike } from "./providers/http.ts";

export interface DefaultMarketProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
  secUserAgent?: string;
}

export function registerDefaultMarketProviders(
  service: MarketsService,
  options: DefaultMarketProviderOptions = {},
): void {
  const common = { fetch: options.fetch, now: options.now };
  // Registration order is capability priority. TradingView does not expose
  // quote/candle adapters here, so Nasdaq remains first for price data while
  // TradingView wins search/fundamentals without a second priority system.
  service.registerProvider(createTradingViewProvider(common satisfies TradingViewProviderOptions));
  service.registerProvider(createNasdaqProvider(common satisfies NasdaqProviderOptions));
  service.registerProvider(createYahooProvider(common satisfies YahooProviderOptions));
  service.registerProvider(createStooqProvider(common satisfies StooqProviderOptions));
  service.registerProvider(createYahooNewsProvider({ fetch: options.fetch } satisfies NewsProviderOptions));
  service.registerProvider(createGoogleNewsProvider({ fetch: options.fetch } satisfies NewsProviderOptions));
  if (options.secUserAgent?.trim()) {
    service.registerProvider(createSecProvider({
      userAgent: options.secUserAgent,
      fetch: options.fetch,
      now: options.now,
    } satisfies SecProviderOptions));
  }
}
