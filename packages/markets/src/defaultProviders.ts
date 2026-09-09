import type { MarketsService } from "./service.ts";
import { createNasdaqProvider, type NasdaqProviderOptions } from "./providers/nasdaq.ts";
import { createStooqProvider, type StooqProviderOptions } from "./providers/stooq.ts";
import { createTradingViewProvider, type TradingViewProviderOptions } from "./providers/tradingview.ts";
import { createYahooProvider, type YahooProviderOptions } from "./providers/yahoo.ts";
import type { FetchLike } from "./providers/http.ts";

export interface DefaultMarketProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

export function registerDefaultMarketProviders(
  service: MarketsService,
  options: DefaultMarketProviderOptions = {},
): void {
  const common = { fetch: options.fetch, now: options.now };
  service.registerProvider(createNasdaqProvider(common satisfies NasdaqProviderOptions));
  service.registerProvider(createYahooProvider(common satisfies YahooProviderOptions));
  service.registerProvider(createStooqProvider(common satisfies StooqProviderOptions));
  service.registerProvider(createTradingViewProvider(common satisfies TradingViewProviderOptions));
}
