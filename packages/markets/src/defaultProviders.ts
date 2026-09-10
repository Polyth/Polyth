import type { MarketsService } from "./service.ts";
import { createBinanceProvider, type BinanceProviderOptions } from "./providers/binance.ts";
import { createFredProvider, type FredProviderOptions } from "./providers/fred.ts";
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
  // Registration order is capability priority. Binance handles only explicit
  // */USDT crypto symbols and misses everything else without network I/O, so
  // equity quote/candle requests still reach Nasdaq first in practice.
  service.registerProvider(createBinanceProvider(common satisfies BinanceProviderOptions));
  service.registerProvider(createTradingViewProvider(common satisfies TradingViewProviderOptions));
  service.registerProvider(createNasdaqProvider(common satisfies NasdaqProviderOptions));
  service.registerProvider(createYahooProvider(common satisfies YahooProviderOptions));
  service.registerProvider(createStooqProvider(common satisfies StooqProviderOptions));
  service.registerProvider(createFredProvider(common satisfies FredProviderOptions));
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
