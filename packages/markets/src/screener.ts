import { SwrCache } from "./cache.ts";

export interface MarketUniverseRow {
  symbol: string;
  name: string;
  price?: number;
  changePercent?: number;
  volume?: number;
  marketCap?: number;
  sector: string;
  exchange: string;
  source: string;
}

export type MarketScreenerSort = "symbol" | "price" | "changePercent" | "volume" | "marketCap";
export type MarketScreenerDirection = "asc" | "desc";

export interface MarketScreenerQuery {
  sector?: string;
  changeMin?: number;
  marketCapMin?: number;
  volumeMin?: number;
  sort?: MarketScreenerSort;
  direction?: MarketScreenerDirection;
  offset?: number;
  limit?: number;
}

export interface MarketScreenerPage {
  generatedAt: string;
  total: number;
  offset: number;
  limit: number;
  sectors: string[];
  rows: MarketUniverseRow[];
  cache: "fresh" | "stale" | "refreshed";
  revalidating: boolean;
}

export type MarketUniverseLoader = () => Promise<MarketUniverseRow[]>;

const POLICY = { softTtlMs: 30_000, hardTtlMs: 5 * 60_000, maxEntries: 1 } as const;
const SORTS = new Set<MarketScreenerSort>(["symbol", "price", "changePercent", "volume", "marketCap"]);

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function normalizeScreenerQuery(query: MarketScreenerQuery): Required<Pick<MarketScreenerQuery, "sort" | "direction" | "offset" | "limit">> & MarketScreenerQuery {
  const sort = query.sort ?? "marketCap";
  const direction = query.direction ?? "desc";
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (!SORTS.has(sort)) invalid("invalid screener sort");
  if (direction !== "asc" && direction !== "desc") invalid("invalid screener direction");
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) invalid("screener offset must be 0-10000");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("screener limit must be 1-100");
  for (const [name, value] of [
    ["changeMin", query.changeMin],
    ["marketCapMin", query.marketCapMin],
    ["volumeMin", query.volumeMin],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) invalid(`${name} must be finite`);
  }
  if (query.marketCapMin !== undefined && query.marketCapMin < 0) invalid("marketCapMin must be non-negative");
  if (query.volumeMin !== undefined && query.volumeMin < 0) invalid("volumeMin must be non-negative");
  const sector = query.sector?.trim();
  if (sector && sector.length > 80) invalid("screener sector is too long");
  const { sector: _sector, ...rest } = query;
  return { ...rest, ...(sector ? { sector } : {}), sort, direction, offset, limit };
}

export function screenMarketUniverse(rows: readonly MarketUniverseRow[], query: MarketScreenerQuery = {}): Omit<MarketScreenerPage, "generatedAt" | "cache" | "revalidating"> {
  const normalized = normalizeScreenerQuery(query);
  const sectorNeedle = normalized.sector?.toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    if (sectorNeedle && row.sector.toLocaleLowerCase() !== sectorNeedle) return false;
    if (normalized.changeMin !== undefined && (row.changePercent === undefined || row.changePercent < normalized.changeMin)) return false;
    if (normalized.marketCapMin !== undefined && (row.marketCap === undefined || row.marketCap < normalized.marketCapMin)) return false;
    if (normalized.volumeMin !== undefined && (row.volume === undefined || row.volume < normalized.volumeMin)) return false;
    return true;
  });

  const value = (row: MarketUniverseRow): string | number | undefined => row[normalized.sort];
  filtered.sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (a === undefined && b === undefined) return left.symbol.localeCompare(right.symbol);
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    if (comparison === 0) return left.symbol.localeCompare(right.symbol);
    return normalized.direction === "asc" ? comparison : -comparison;
  });

  const sectors = [...new Set(rows.map((row) => row.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    total: filtered.length,
    offset: normalized.offset,
    limit: normalized.limit,
    sectors,
    rows: filtered.slice(normalized.offset, normalized.offset + normalized.limit),
  };
}

export class MarketUniverseService {
  private readonly cache: SwrCache<MarketUniverseRow[]>;

  constructor(
    private readonly load: MarketUniverseLoader,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = new SwrCache(this.now);
  }

  async screen(query: MarketScreenerQuery = {}): Promise<MarketScreenerPage> {
    const normalized = normalizeScreenerQuery(query);
    const snapshot = await this.cache.get("us-common-stocks", POLICY, this.load);
    const page = screenMarketUniverse(snapshot.value, normalized);
    return {
      ...page,
      generatedAt: new Date(snapshot.updatedAt).toISOString(),
      cache: snapshot.state,
      revalidating: snapshot.revalidating,
    };
  }
}
