import { SwrCache } from "./cache.ts";
import type { MarketDataResult } from "./types.ts";

export type MarketEconomicImpact = "Low" | "Medium" | "High" | "Holiday";

export interface MarketEconomicEvent {
  title: string;
  currency: string;
  date: string;
  impact: MarketEconomicImpact;
  forecast?: string;
  previous?: string;
  actual?: string;
  source: string;
}

export interface MarketEarningsCalendarEntry {
  symbol: string;
  nextEarningsAt?: string;
  lastEarningsAt?: string;
  epsForecast?: number;
  source: string;
}

export type MarketEconomicCalendarLoader = () => Promise<MarketEconomicEvent[]>;
export type MarketEarningsCalendarLoader = (symbols: readonly string[]) => Promise<MarketEarningsCalendarEntry[]>;

const ECONOMIC_POLICY = {
  softTtlMs: 60 * 60_000,
  hardTtlMs: 6 * 60 * 60_000,
  maxEntries: 1,
} as const;
const EARNINGS_POLICY = {
  softTtlMs: 60 * 60_000,
  hardTtlMs: 12 * 60 * 60_000,
  maxEntries: 100,
} as const;
const US_SYMBOL = /^[A-Z][A-Z0-9-]{0,15}$/;

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function normalizeCalendarSymbols(symbols: readonly string[]): string[] {
  if (symbols.length < 1 || symbols.length > 100) invalid("earnings calendar requires 1-100 symbols");
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (normalized.length < 1 || normalized.some((symbol) => !US_SYMBOL.test(symbol))) {
    invalid("earnings calendar supports US symbols only");
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

export class MarketCalendarService {
  private readonly economicCache: SwrCache<MarketEconomicEvent[]>;
  private readonly earningsCache: SwrCache<MarketEarningsCalendarEntry[]>;

  constructor(
    private readonly economicLoader: MarketEconomicCalendarLoader,
    private readonly earningsLoader: MarketEarningsCalendarLoader,
    private readonly now: () => number = Date.now,
  ) {
    this.economicCache = new SwrCache(this.now);
    this.earningsCache = new SwrCache(this.now);
  }

  async economic(): Promise<MarketDataResult<MarketEconomicEvent[]>> {
    const result = await this.economicCache.get("week", ECONOMIC_POLICY, this.economicLoader);
    return this.result(result);
  }

  async earnings(symbols: readonly string[]): Promise<MarketDataResult<MarketEarningsCalendarEntry[]>> {
    const normalized = normalizeCalendarSymbols(symbols);
    const result = await this.earningsCache.get(normalized.join("\u0000"), EARNINGS_POLICY, () => this.earningsLoader(normalized));
    return this.result(result);
  }

  private result<T>(result: { value: T; state: "fresh" | "stale" | "refreshed"; updatedAt: number; revalidating: boolean }): MarketDataResult<T> {
    return {
      data: result.value,
      cache: result.state,
      cachedAt: new Date(result.updatedAt).toISOString(),
      revalidating: result.revalidating,
    };
  }
}
