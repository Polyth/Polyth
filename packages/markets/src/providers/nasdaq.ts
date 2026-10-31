import type { MarketProvider } from "../providers.ts";
import type { MarketCandle, MarketEarningsSurprise, MarketRange } from "../types.ts";
import {
  createLimiter,
  fetchJson,
  numeric,
  record,
  text,
  USER_AGENT,
  valueAt,
  type FetchLike,
} from "./http.ts";

const ETFS = new Set(["SPY", "DIA", "QQQ", "GLD", "USO", "UUP", "IWM", "VTI", "TLT"]);
const NASDAQ_SYMBOL = /^[A-Z][A-Z0-9-]{0,15}$/;
const RANGE_DAYS: Record<MarketRange, number> = {
  "1D": 5,
  "5D": 10,
  "1M": 35,
  "6M": 190,
  YTD: 400,
  "1Y": 400,
  "5Y": 1_900,
  MAX: 7_300,
};

export interface NasdaqProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

const date = (value: Date): string => value.toISOString().slice(0, 10);
const miss: (message: string) => never = (message) => {
  throw Object.assign(new Error(message), { code: "not-found" });
};
const requireSupportedSymbol = (symbol: string): void => {
  if (!NASDAQ_SYMBOL.test(symbol)) miss(`nasdaq: unsupported symbol ${symbol}`);
};

export function createNasdaqProvider(options: NasdaqProviderOptions = {}): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(6);
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Origin: "https://www.nasdaq.com",
    Referer: "https://www.nasdaq.com/",
  };
  const get = (url: string, signal: AbortSignal): Promise<unknown> => limit(async () => {
    const json = await fetchJson(fetchImpl, url, { headers, signal }, "nasdaq");
    const data = valueAt(json, "data");
    if (data === undefined || data === null) miss("nasdaq: missing data");
    return data;
  });
  const assetClass = (symbol: string): "stocks" | "etf" => ETFS.has(symbol) ? "etf" : "stocks";

  return {
    id: "nasdaq",
    async quote(symbol, signal) {
      requireSupportedSymbol(symbol);
      const kind = assetClass(symbol);
      const encoded = encodeURIComponent(symbol);
      const [info, summary] = await Promise.all([
        get(`https://api.nasdaq.com/api/quote/${encoded}/info?assetclass=${kind}`, signal),
        get(`https://api.nasdaq.com/api/quote/${encoded}/summary?assetclass=${kind}`, signal).catch(() => undefined),
      ]);
      const price = numeric(valueAt(info, "primaryData", "lastSalePrice"))
        ?? miss(`nasdaq: no quote for ${symbol}`);
      const previousClose = numeric(valueAt(info, "primaryData", "previousClose"))
        ?? numeric(valueAt(summary, "summaryData", "PreviousClose", "value"));
      const change = numeric(valueAt(info, "primaryData", "netChange"));
      const changePercent = numeric(valueAt(info, "primaryData", "percentageChange"));
      const dayRange = text(valueAt(info, "keyStats", "dayrange", "value"))?.split(" - ") ?? [];
      const marketCap = numeric(valueAt(summary, "summaryData", "MarketCap", "value"));
      return {
        symbol,
        name: text(valueAt(info, "companyName")),
        assetType: kind === "etf" ? "etf" : "equity",
        currency: "USD",
        exchange: text(valueAt(info, "exchange")),
        price,
        ...(change !== undefined ? { change } : {}),
        ...(changePercent !== undefined ? { changePercent } : {}),
        ...(numeric(dayRange[1]) !== undefined ? { high: numeric(dayRange[1]) } : {}),
        ...(numeric(dayRange[0]) !== undefined ? { low: numeric(dayRange[0]) } : {}),
        ...(previousClose !== undefined ? { previousClose } : {}),
        ...(numeric(valueAt(info, "primaryData", "volume")) !== undefined
          ? { volume: numeric(valueAt(info, "primaryData", "volume")) }
          : {}),
        ...(marketCap !== undefined ? { marketCap } : {}),
        asOf: new Date(now()).toISOString(),
        source: "nasdaq",
        freshness: "delayed",
      };
    },
    async candles(symbol, range, signal) {
      requireSupportedSymbol(symbol);
      const end = new Date(now());
      const start = new Date(end.getTime() - RANGE_DAYS[range] * 86_400_000);
      const data = await get(
        `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=${assetClass(symbol)}&fromdate=${date(start)}&todate=${date(end)}`,
        signal,
      );
      const rows = valueAt(data, "chart");
      if (!Array.isArray(rows)) return miss(`nasdaq: no chart for ${symbol}`);
      const candles: MarketCandle[] = [];
      for (const raw of rows) {
        const row = record(raw);
        const z = record(row?.z);
        const timeMs = numeric(row?.x);
        const open = numeric(z?.open);
        const high = numeric(z?.high);
        const low = numeric(z?.low);
        const close = numeric(z?.close);
        if (timeMs === undefined || open === undefined || high === undefined || low === undefined || close === undefined) continue;
        candles.push({
          time: Math.round(timeMs / 1_000),
          open,
          high,
          low,
          close,
          ...(numeric(z?.volume) !== undefined ? { volume: numeric(z?.volume) } : {}),
        });
      }
      if (candles.length === 0) miss(`nasdaq: empty chart for ${symbol}`);
      return {
        symbol,
        range,
        candles,
        asOf: new Date(now()).toISOString(),
        source: "nasdaq",
        freshness: "delayed",
      };
    },
    async earnings(symbol, signal) {
      requireSupportedSymbol(symbol);
      const data = await get(
        `https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`,
        signal,
      );
      const rows = valueAt(data, "earningsSurpriseTable", "rows");
      if (!Array.isArray(rows)) return miss(`nasdaq: no earnings history for ${symbol}`);
      const earnings: MarketEarningsSurprise[] = [];
      for (const raw of rows) {
        const row = record(raw);
        if (!row) continue;
        const fiscalQuarterEnd = text(row.fiscalQtrEnd);
        const reportedAt = text(row.dateReported);
        const actualEps = numeric(row.eps);
        const consensusEps = numeric(row.consensusForecast);
        const surprisePercent = numeric(row.percentageSurprise);
        if (
          fiscalQuarterEnd === undefined
          && reportedAt === undefined
          && actualEps === undefined
          && consensusEps === undefined
          && surprisePercent === undefined
        ) continue;
        earnings.push({
          symbol,
          ...(fiscalQuarterEnd ? { fiscalQuarterEnd } : {}),
          ...(reportedAt ? { reportedAt } : {}),
          ...(actualEps !== undefined ? { actualEps } : {}),
          ...(consensusEps !== undefined ? { consensusEps } : {}),
          ...(surprisePercent !== undefined ? { surprisePercent } : {}),
          source: "nasdaq",
        });
      }
      if (earnings.length === 0) miss(`nasdaq: empty earnings history for ${symbol}`);
      return earnings;
    },
  };
}
