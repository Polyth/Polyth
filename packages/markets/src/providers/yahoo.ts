import type { MarketProvider } from "../providers.ts";
import type { MarketAssetType, MarketCandle, MarketRange } from "../types.ts";
import {
  createLimiter,
  fetchJson,
  finite,
  record,
  text,
  USER_AGENT,
  valueAt,
  type FetchLike,
} from "./http.ts";

const RANGE: Record<MarketRange, { range: string; interval: string }> = {
  "1D": { range: "1d", interval: "5m" },
  "5D": { range: "5d", interval: "15m" },
  "1M": { range: "1mo", interval: "1d" },
  "6M": { range: "6mo", interval: "1d" },
  YTD: { range: "ytd", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  "5Y": { range: "5y", interval: "1wk" },
  MAX: { range: "max", interval: "1mo" },
};

export interface YahooProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

function assetType(value: unknown): MarketAssetType {
  switch (String(value ?? "").toUpperCase()) {
    case "EQUITY": return "equity";
    case "ETF":
    case "MUTUALFUND": return "etf";
    case "INDEX": return "index";
    case "CRYPTOCURRENCY": return "crypto";
    case "CURRENCY": return "currency";
    case "FUTURE": return "commodity";
    default: return "unknown";
  }
}

export function createYahooProvider(options: YahooProviderOptions = {}): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(2);
  const get = (url: string, signal: AbortSignal): Promise<unknown> => limit(() =>
    fetchJson(fetchImpl, url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal }, "yahoo")
  );

  return {
    id: "yahoo",
    async quote(symbol, signal) {
      const json = await get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
        signal,
      );
      const meta = valueAt(json, "chart", "result");
      const first = Array.isArray(meta) ? record(meta[0]) : undefined;
      const info = record(first?.meta);
      if (!info) throw new Error(`yahoo: no quote for ${symbol}`);
      const price = finite(info.regularMarketPrice);
      if (price === undefined) throw new Error(`yahoo: no price for ${symbol}`);
      const previousClose = finite(info.chartPreviousClose) ?? finite(info.previousClose);
      return {
        symbol: text(info.symbol) ?? symbol,
        name: text(info.longName) ?? text(info.shortName),
        currency: text(info.currency),
        exchange: text(info.fullExchangeName) ?? text(info.exchangeName),
        price,
        ...(previousClose !== undefined ? { previousClose } : {}),
        ...(previousClose !== undefined ? { change: price - previousClose } : {}),
        ...(previousClose !== undefined && previousClose !== 0
          ? { changePercent: ((price - previousClose) / previousClose) * 100 }
          : {}),
        ...(finite(info.regularMarketDayHigh) !== undefined ? { high: finite(info.regularMarketDayHigh) } : {}),
        ...(finite(info.regularMarketDayLow) !== undefined ? { low: finite(info.regularMarketDayLow) } : {}),
        ...(finite(info.regularMarketVolume) !== undefined ? { volume: finite(info.regularMarketVolume) } : {}),
        asOf: new Date((finite(info.regularMarketTime) ?? Math.round(now() / 1_000)) * 1_000).toISOString(),
        source: "yahoo",
        freshness: "delayed",
      };
    },
    async candles(symbol, range, signal) {
      const spec = RANGE[range];
      const json = await get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${spec.range}&interval=${spec.interval}&includePrePost=false`,
        signal,
      );
      const results = valueAt(json, "chart", "result");
      const first = Array.isArray(results) ? record(results[0]) : undefined;
      if (!first) throw new Error(`yahoo: no chart for ${symbol}`);
      const timestamps = Array.isArray(first.timestamp) ? first.timestamp : [];
      const indicators = record(first.indicators);
      const quotes = Array.isArray(indicators?.quote) ? indicators?.quote : [];
      const quote = record(quotes[0]);
      const opens = Array.isArray(quote?.open) ? quote.open : [];
      const highs = Array.isArray(quote?.high) ? quote.high : [];
      const lows = Array.isArray(quote?.low) ? quote.low : [];
      const closes = Array.isArray(quote?.close) ? quote.close : [];
      const volumes = Array.isArray(quote?.volume) ? quote.volume : [];
      const candles: MarketCandle[] = [];
      for (let index = 0; index < timestamps.length; index += 1) {
        const time = finite(timestamps[index]);
        const open = finite(opens[index]);
        const high = finite(highs[index]);
        const low = finite(lows[index]);
        const close = finite(closes[index]);
        if (time === undefined || open === undefined || high === undefined || low === undefined || close === undefined) continue;
        candles.push({ time, open, high, low, close, ...(finite(volumes[index]) !== undefined ? { volume: finite(volumes[index]) } : {}) });
      }
      if (candles.length === 0) throw new Error(`yahoo: empty chart for ${symbol}`);
      return { symbol, range, candles, asOf: new Date(now()).toISOString(), source: "yahoo", freshness: "delayed" };
    },
    async search(query, signal) {
      const json = await get(
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`,
        signal,
      );
      const rows = valueAt(json, "quotes");
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((raw) => {
        const row = record(raw);
        const symbol = text(row?.symbol);
        if (!row || !symbol) return [];
        return [{
          symbol,
          name: text(row.longname) ?? text(row.shortname) ?? symbol,
          exchange: text(row.exchDisp) ?? text(row.exchange),
          assetType: assetType(row.quoteType ?? row.typeDisp),
          source: "yahoo",
        }];
      });
    },
  };
}
