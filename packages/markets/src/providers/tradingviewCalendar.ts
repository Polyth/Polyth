import type { MarketEarningsCalendarEntry, MarketEarningsCalendarLoader } from "../calendar.ts";
import { createLimiter, fetchJson, finite, record, text, USER_AGENT, valueAt, type FetchLike } from "./http.ts";

export interface TradingViewCalendarOptions {
  fetch?: FetchLike;
}

const EXCHANGES = ["NASDAQ", "NYSE", "AMEX"] as const;
const COLUMNS = [
  "earnings_release_next_date",
  "earnings_release_date",
  "earnings_per_share_forecast_next_fq",
] as const;

const isoFromSeconds = (value: unknown): string | undefined => {
  const seconds = finite(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export function createTradingViewEarningsCalendarLoader(
  options: TradingViewCalendarOptions = {},
): MarketEarningsCalendarLoader {
  const fetchImpl = options.fetch ?? fetch;
  const limit = createLimiter(1);
  const headers = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    Referer: "https://www.tradingview.com/",
    Origin: "https://www.tradingview.com",
  };

  return async (symbols) => limit(async () => {
    const tickers = symbols.flatMap((symbol) => EXCHANGES.map((exchange) => `${exchange}:${symbol}`));
    const json = await fetchJson(fetchImpl, "https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ symbols: { tickers }, columns: COLUMNS }),
    }, "tradingview earnings calendar");
    const rows = valueAt(json, "data");
    if (!Array.isArray(rows)) throw new Error("tradingview earnings calendar: malformed response");

    const bySymbol = new Map<string, MarketEarningsCalendarEntry>();
    for (const raw of rows) {
      const row = record(raw);
      const ticker = text(row?.s);
      const values = Array.isArray(row?.d) ? row.d : undefined;
      const symbol = ticker?.split(":")[1];
      if (!symbol || !values || bySymbol.has(symbol)) continue;
      const nextEarningsAt = isoFromSeconds(values[0]);
      const lastEarningsAt = isoFromSeconds(values[1]);
      const epsForecast = finite(values[2]);
      bySymbol.set(symbol, {
        symbol,
        ...(nextEarningsAt ? { nextEarningsAt } : {}),
        ...(lastEarningsAt ? { lastEarningsAt } : {}),
        ...(epsForecast !== undefined ? { epsForecast } : {}),
        source: "tradingview",
      });
    }

    return symbols.map((symbol) => bySymbol.get(symbol) ?? { symbol, source: "tradingview" });
  });
}
