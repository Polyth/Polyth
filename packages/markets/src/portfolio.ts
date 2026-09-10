import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import type { MarketsService } from "./service.ts";
import { normalizeSymbol } from "./service.ts";
import type { MarketQuote } from "./types.ts";

export interface MarketPortfolioHolding {
  symbol: string;
  quantity: number;
  averageCost?: number;
}

export interface MarketPortfolio {
  version: 1;
  holdings: MarketPortfolioHolding[];
}

export interface MarketPortfolioPosition {
  holding: MarketPortfolioHolding;
  quote?: MarketQuote;
  currency?: string;
  marketValue?: number;
  costBasis?: number;
  unrealizedGain?: number;
  dailyChange?: number;
  error?: string;
}

export interface MarketPortfolioCurrencySummary {
  currency: string;
  marketValue: number;
  costBasis?: number;
  unrealizedGain?: number;
  dailyChange?: number;
}

export interface MarketPortfolioSnapshot {
  generatedAt: string;
  positions: MarketPortfolioPosition[];
  currencies: MarketPortfolioCurrencySummary[];
  errors: Array<{ symbol: string; message: string }>;
}

export const DEFAULT_PORTFOLIO: MarketPortfolio = { version: 1, holdings: [] };
const MAX_HOLDINGS = 100;

const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function parsePortfolio(value: unknown): MarketPortfolio {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("portfolio must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) fail("unsupported portfolio version");
  if (!Array.isArray(raw.holdings) || raw.holdings.length > MAX_HOLDINGS) {
    fail(`portfolio may contain at most ${MAX_HOLDINGS} holdings`);
  }

  const seen = new Set<string>();
  const holdings = raw.holdings.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("each holding must be an object");
    const item = value as Record<string, unknown>;
    if (typeof item.symbol !== "string") fail("holding symbol must be a string");
    const symbol = normalizeSymbol(item.symbol);
    if (seen.has(symbol)) fail(`duplicate holding symbol: ${symbol}`);
    seen.add(symbol);
    if (typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      fail("holding quantity must be a positive number");
    }
    if (item.averageCost !== undefined && (
      typeof item.averageCost !== "number" || !Number.isFinite(item.averageCost) || item.averageCost < 0
    )) {
      fail("holding average cost must be a non-negative number");
    }
    return {
      symbol,
      quantity: item.quantity,
      ...(item.averageCost === undefined ? {} : { averageCost: item.averageCost as number }),
    };
  });

  return { version: 1, holdings };
}

export async function loadPortfolio(storage: SpaceStorage): Promise<MarketPortfolio> {
  const file = join(storage.packageDir("markets"), "portfolio.json");
  try {
    return parsePortfolio(JSON.parse(await readFile(file, "utf8")));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_PORTFOLIO);
    throw cause;
  }
}

export async function savePortfolio(storage: SpaceStorage, value: unknown): Promise<MarketPortfolio> {
  const document = parsePortfolio(value);
  const dir = storage.packageDir("markets");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "portfolio.json");
  const temporary = join(dir, `.portfolio.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return document;
}

export async function snapshotPortfolio(
  markets: Pick<MarketsService, "quote">,
  portfolio: MarketPortfolio,
  now: () => number = Date.now,
): Promise<MarketPortfolioSnapshot> {
  const settled = await Promise.all(portfolio.holdings.map(async (holding): Promise<MarketPortfolioPosition> => {
    try {
      const quote = (await markets.quote(holding.symbol)).data;
      const marketValue = quote.price * holding.quantity;
      const costBasis = holding.averageCost === undefined ? undefined : holding.averageCost * holding.quantity;
      return {
        holding,
        quote,
        currency: quote.currency ?? "UNKNOWN",
        marketValue,
        ...(costBasis === undefined ? {} : { costBasis, unrealizedGain: marketValue - costBasis }),
        ...(quote.change === undefined ? {} : { dailyChange: quote.change * holding.quantity }),
      };
    } catch (cause) {
      return {
        holding,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }));

  const errors = settled
    .filter((position) => position.error)
    .map((position) => ({ symbol: position.holding.symbol, message: position.error! }));
  const groups = new Map<string, MarketPortfolioPosition[]>();
  for (const position of settled) {
    if (!position.currency || position.marketValue === undefined) continue;
    const items = groups.get(position.currency) ?? [];
    items.push(position);
    groups.set(position.currency, items);
  }

  const currencies = [...groups.entries()].map(([currency, positions]) => {
    const marketValue = positions.reduce((sum, position) => sum + position.marketValue!, 0);
    const allCostsKnown = positions.every((position) => position.costBasis !== undefined);
    const allDailyKnown = positions.every((position) => position.dailyChange !== undefined);
    const costBasis = allCostsKnown ? positions.reduce((sum, position) => sum + position.costBasis!, 0) : undefined;
    return {
      currency,
      marketValue,
      ...(costBasis === undefined ? {} : { costBasis, unrealizedGain: marketValue - costBasis }),
      ...(allDailyKnown ? { dailyChange: positions.reduce((sum, position) => sum + position.dailyChange!, 0) } : {}),
    };
  }).sort((left, right) => left.currency.localeCompare(right.currency));

  return {
    generatedAt: new Date(now()).toISOString(),
    positions: settled,
    currencies,
    errors,
  };
}
