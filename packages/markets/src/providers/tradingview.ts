import type { MarketProvider } from "../providers.ts";
import type { MarketAssetType } from "../types.ts";
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

export interface TradingViewProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

const EXCHANGE_SUFFIX: Array<{ match: RegExp; suffix: string }> = [
  { match: /^(mil|bit)$/i, suffix: ".MI" },
  { match: /euronext paris|^par$/i, suffix: ".PA" },
  { match: /euronext amsterdam|^ams$/i, suffix: ".AS" },
  { match: /^(xetr|fra|ger|gettex)$/i, suffix: ".DE" },
  { match: /^(lse|lsin)$/i, suffix: ".L" },
  { match: /^(bme|mce)$/i, suffix: ".MC" },
  { match: /^(six|swx|ebs)$/i, suffix: ".SW" },
  { match: /^(tsx|tsxv)$/i, suffix: ".TO" },
  { match: /^asx$/i, suffix: ".AX" },
  { match: /^hkex$/i, suffix: ".HK" },
  { match: /^tse$/i, suffix: ".T" },
  { match: /^nse$/i, suffix: ".NS" },
  { match: /^bse$/i, suffix: ".BO" },
];
const US_FUNDAMENTALS_SYMBOL = /^[A-Z][A-Z0-9-]{0,15}$/;

const stripEmphasis = (value: string): string => value.replace(/<\/?em>/g, "");
const suffixFor = (exchange: string): string => EXCHANGE_SUFFIX.find((item) => item.match.test(exchange))?.suffix ?? "";
const assetType = (type: string): MarketAssetType => type === "fund" ? "etf" : type === "stock" || type === "dr" ? "equity" : "unknown";
const miss: (message: string) => never = (message) => {
  throw Object.assign(new Error(message), { code: "not-found" });
};

export function createTradingViewProvider(options: TradingViewProviderOptions = {}): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(4);
  const headers = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    Referer: "https://www.tradingview.com/",
    Origin: "https://www.tradingview.com",
  };
  const request = (url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> => limit(() =>
    fetchJson(fetchImpl, url, { ...init, headers: { ...headers, ...init.headers }, signal }, "tradingview")
  );

  return {
    id: "tradingview",
    async search(query, signal) {
      const json = await request(
        `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(query)}&hl=1&lang=en&search_type=undefined&domain=production&sort_by_country=US`,
        { method: "GET" },
        signal,
      );
      const rows = valueAt(json, "symbols");
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((raw) => {
        const row = record(raw);
        const type = text(row?.type) ?? "";
        const rawSymbol = text(row?.symbol);
        if (!row || !rawSymbol || !["stock", "fund", "dr"].includes(type)) return [];
        const exchange = text(row.exchange) ?? "";
        const symbol = stripEmphasis(rawSymbol);
        return [{
          symbol: symbol.includes(".") ? symbol : symbol + suffixFor(exchange),
          name: stripEmphasis(text(row.description) ?? symbol),
          ...(exchange ? { exchange } : {}),
          assetType: assetType(type),
          source: "tradingview",
        }];
      }).slice(0, 15);
    },
    async fundamentals(symbol, signal) {
      if (!US_FUNDAMENTALS_SYMBOL.test(symbol)) {
        miss(`tradingview fundamentals do not support symbol ${symbol}`);
      }
      const tickers = ["NASDAQ", "NYSE", "AMEX"].map((exchange) => `${exchange}:${symbol}`);
      const columns = [
        "market_cap_basic",
        "price_earnings_ttm",
        "earnings_per_share_basic_ttm",
        "dividends_yield_current",
        "beta_1_year",
        "total_shares_outstanding",
        "sector",
        "industry",
      ];
      const json = await request(
        "https://scanner.tradingview.com/america/scan",
        { method: "POST", body: JSON.stringify({ symbols: { tickers }, columns }) },
        signal,
      );
      const rows = valueAt(json, "data");
      const first = Array.isArray(rows) ? record(rows[0]) : undefined;
      const values = Array.isArray(first?.d)
        ? first.d
        : miss(`tradingview: no fundamentals for ${symbol}`);
      const ticker = text(first?.s) ?? miss(`tradingview: no fundamentals for ${symbol}`);
      const [marketCap, pe, eps, dividendYieldPct, beta, sharesOutstanding, sector, industry] = values;
      const exchange = ticker.split(":")[0];
      return {
        symbol,
        ...(exchange ? { exchange } : {}),
        ...(finite(marketCap) !== undefined ? { marketCap: finite(marketCap) } : {}),
        ...(finite(pe) !== undefined ? { pe: finite(pe) } : {}),
        ...(finite(eps) !== undefined ? { eps: finite(eps) } : {}),
        ...(finite(dividendYieldPct) !== undefined ? { dividendYield: finite(dividendYieldPct)! / 100 } : {}),
        ...(finite(beta) !== undefined ? { beta: finite(beta) } : {}),
        ...(finite(sharesOutstanding) !== undefined ? { sharesOutstanding: finite(sharesOutstanding) } : {}),
        ...(text(sector) ? { sector: text(sector) } : {}),
        ...(text(industry) ? { industry: text(industry) } : {}),
        asOf: new Date(now()).toISOString(),
        source: "tradingview",
        freshness: "delayed",
      };
    },
  };
}
