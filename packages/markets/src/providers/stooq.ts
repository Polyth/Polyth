import type { MarketProvider } from "../providers.ts";
import type { MarketCandle, MarketRange } from "../types.ts";
import { createLimiter, fetchText, type FetchLike } from "./http.ts";

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

export interface StooqProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

export function stooqSymbol(symbol: string): string {
  const normalized = symbol.toLowerCase();
  if (normalized.startsWith("^")) return normalized;
  if (normalized.includes(".") || normalized.includes("=") || normalized.includes("-")) return normalized;
  return `${normalized}.us`;
}

const dateParam = (value: Date): string => value.toISOString().slice(0, 10).replaceAll("-", "");

export function createStooqProvider(options: StooqProviderOptions = {}): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(2);
  const get = (url: string, signal: AbortSignal): Promise<string> => limit(() =>
    fetchText(fetchImpl, url, { signal }, "stooq")
  );

  return {
    id: "stooq",
    async quote(symbol, signal) {
      const csv = await get(
        `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&f=sd2t2ohlcv&h&e=csv`,
        signal,
      );
      const lines = csv.trim().split(/\r?\n/);
      if (lines.length < 2) throw new Error(`stooq: no quote for ${symbol}`);
      const [remoteSymbol, , , openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = lines[1].split(",");
      const price = Number(closeRaw);
      if (!Number.isFinite(price)) throw new Error(`stooq: no price for ${symbol}`);
      const open = Number(openRaw);
      const high = Number(highRaw);
      const low = Number(lowRaw);
      const volume = Number(volumeRaw);
      return {
        symbol,
        name: remoteSymbol || symbol,
        price,
        ...(Number.isFinite(open) ? { open } : {}),
        ...(Number.isFinite(high) ? { high } : {}),
        ...(Number.isFinite(low) ? { low } : {}),
        ...(Number.isFinite(volume) ? { volume } : {}),
        asOf: new Date(now()).toISOString(),
        source: "stooq",
        freshness: "indicative",
      };
    },
    async candles(symbol, range, signal) {
      const end = new Date(now());
      const start = new Date(end.getTime() - RANGE_DAYS[range] * 86_400_000);
      const csv = await get(
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&d1=${dateParam(start)}&d2=${dateParam(end)}&i=d`,
        signal,
      );
      const lines = csv.trim().split(/\r?\n/);
      if (lines.length < 2 || !lines[0].startsWith("Date")) throw new Error(`stooq: no chart for ${symbol}`);
      const candles: MarketCandle[] = [];
      for (const line of lines.slice(1)) {
        const [date, openRaw, highRaw, lowRaw, closeRaw, volumeRaw] = line.split(",");
        const time = Date.parse(`${date}T00:00:00Z`) / 1_000;
        const open = Number(openRaw);
        const high = Number(highRaw);
        const low = Number(lowRaw);
        const close = Number(closeRaw);
        const volume = Number(volumeRaw);
        if (![time, open, high, low, close].every(Number.isFinite)) continue;
        candles.push({ time, open, high, low, close, ...(Number.isFinite(volume) ? { volume } : {}) });
      }
      if (candles.length === 0) throw new Error(`stooq: empty chart for ${symbol}`);
      return { symbol, range, candles, asOf: new Date(now()).toISOString(), source: "stooq", freshness: "indicative" };
    },
  };
}
