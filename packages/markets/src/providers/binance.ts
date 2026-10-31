import type { MarketProvider } from "../providers.ts";
import type { MarketCandle, MarketQuote, MarketRange } from "../types.ts";
import { createLimiter, fetchJson, numeric, record, type FetchLike } from "./http.ts";

export const BINANCE_CRYPTO_ASSETS = [
  { symbol: "BTC/USDT", pair: "BTCUSDT", name: "Bitcoin" },
  { symbol: "ETH/USDT", pair: "ETHUSDT", name: "Ethereum" },
  { symbol: "BNB/USDT", pair: "BNBUSDT", name: "BNB" },
  { symbol: "SOL/USDT", pair: "SOLUSDT", name: "Solana" },
  { symbol: "XRP/USDT", pair: "XRPUSDT", name: "XRP" },
  { symbol: "DOGE/USDT", pair: "DOGEUSDT", name: "Dogecoin" },
  { symbol: "ADA/USDT", pair: "ADAUSDT", name: "Cardano" },
  { symbol: "AVAX/USDT", pair: "AVAXUSDT", name: "Avalanche" },
  { symbol: "LINK/USDT", pair: "LINKUSDT", name: "Chainlink" },
  { symbol: "DOT/USDT", pair: "DOTUSDT", name: "Polkadot" },
  { symbol: "LTC/USDT", pair: "LTCUSDT", name: "Litecoin" },
  { symbol: "BCH/USDT", pair: "BCHUSDT", name: "Bitcoin Cash" },
] as const;

type BinanceAsset = (typeof BINANCE_CRYPTO_ASSETS)[number];
// Keyed by string: both lookups take a caller-supplied symbol, never a literal.
const assetBySymbol = new Map<string, BinanceAsset>(BINANCE_CRYPTO_ASSETS.map((asset) => [asset.symbol, asset]));
const assetByPair = new Map<string, BinanceAsset>(BINANCE_CRYPTO_ASSETS.map((asset) => [asset.pair, asset]));
const RANGE: Record<MarketRange, { interval: string; limit: number }> = {
  "1D": { interval: "5m", limit: 288 },
  "5D": { interval: "15m", limit: 480 },
  "1M": { interval: "1h", limit: 720 },
  "6M": { interval: "6h", limit: 720 },
  YTD: { interval: "1d", limit: 400 },
  "1Y": { interval: "1d", limit: 365 },
  "5Y": { interval: "3d", limit: 610 },
  MAX: { interval: "1w", limit: 1_000 },
};

export interface BinanceProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

const miss: (message: string) => never = (message) => {
  throw Object.assign(new Error(message), { code: "not-found" });
};

const assetFor = (symbol: string) => assetBySymbol.get(symbol) ?? miss(`binance: unsupported crypto symbol ${symbol}`);

function quoteFromTicker(raw: unknown, fallbackAsOf: number): MarketQuote | undefined {
  const row = record(raw);
  if (!row) return undefined;
  const pair = typeof row.symbol === "string" ? row.symbol.toUpperCase() : "";
  const asset = assetByPair.get(pair);
  const price = numeric(row.lastPrice);
  if (!asset || price === undefined) return undefined;
  const closeTime = numeric(row.closeTime);
  return {
    symbol: asset.symbol,
    name: asset.name,
    assetType: "crypto",
    currency: "USDT",
    exchange: "Binance",
    price,
    ...(numeric(row.priceChange) !== undefined ? { change: numeric(row.priceChange) } : {}),
    ...(numeric(row.priceChangePercent) !== undefined ? { changePercent: numeric(row.priceChangePercent) } : {}),
    ...(numeric(row.openPrice) !== undefined ? { open: numeric(row.openPrice) } : {}),
    ...(numeric(row.highPrice) !== undefined ? { high: numeric(row.highPrice) } : {}),
    ...(numeric(row.lowPrice) !== undefined ? { low: numeric(row.lowPrice) } : {}),
    ...(numeric(row.prevClosePrice) !== undefined ? { previousClose: numeric(row.prevClosePrice) } : {}),
    ...(numeric(row.volume) !== undefined ? { volume: numeric(row.volume) } : {}),
    asOf: new Date(closeTime ?? fallbackAsOf).toISOString(),
    source: "binance",
    freshness: "live",
  };
}

export function createBinanceProvider(options: BinanceProviderOptions = {}): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(4);
  const get = (url: string, signal: AbortSignal): Promise<unknown> => limit(() =>
    fetchJson(fetchImpl, url, { headers: { Accept: "application/json" }, signal }, "binance")
  );

  return {
    id: "binance",
    async quote(symbol, signal) {
      const asset = assetFor(symbol);
      const data = await get(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(asset.pair)}`,
        signal,
      );
      return quoteFromTicker(data, now()) ?? miss(`binance: no quote for ${symbol}`);
    },
    async candles(symbol, range, signal) {
      const asset = assetFor(symbol);
      const spec = RANGE[range];
      const data = await get(
        `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(asset.pair)}&interval=${encodeURIComponent(spec.interval)}&limit=${spec.limit}`,
        signal,
      );
      if (!Array.isArray(data)) return miss(`binance: no candles for ${symbol}`);
      const candles: MarketCandle[] = data.flatMap((raw) => {
        if (!Array.isArray(raw)) return [];
        const timeMs = numeric(raw[0]);
        const open = numeric(raw[1]);
        const high = numeric(raw[2]);
        const low = numeric(raw[3]);
        const close = numeric(raw[4]);
        if (timeMs === undefined || open === undefined || high === undefined || low === undefined || close === undefined) return [];
        const volume = numeric(raw[5]);
        return [{
          time: Math.round(timeMs / 1_000),
          open,
          high,
          low,
          close,
          ...(volume !== undefined ? { volume } : {}),
        }];
      });
      if (candles.length === 0) miss(`binance: empty candles for ${symbol}`);
      return {
        symbol: asset.symbol,
        range,
        candles,
        asOf: new Date(now()).toISOString(),
        source: "binance",
        freshness: "live",
      };
    },
    async crypto(signal) {
      const pairs = BINANCE_CRYPTO_ASSETS.map((asset) => asset.pair);
      const data = await get(
        `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`,
        signal,
      );
      if (!Array.isArray(data)) throw new Error("binance: malformed crypto board");
      const quotes = data
        .map((row: unknown) => quoteFromTicker(row, now()))
        .filter((quote): quote is MarketQuote => quote !== undefined)
        .sort((left, right) => BINANCE_CRYPTO_ASSETS.findIndex((asset) => asset.symbol === left.symbol)
          - BINANCE_CRYPTO_ASSETS.findIndex((asset) => asset.symbol === right.symbol));
      if (quotes.length === 0) throw new Error("binance: empty crypto board");
      return quotes;
    },
  };
}
