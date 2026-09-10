import type { MarketUniverseRow } from "./screener.ts";

export interface MarketHeatmapQuery {
  sector?: string;
  limit?: number;
}

export interface MarketHeatmapCell extends MarketUniverseRow {
  marketCap: number;
  changePercent: number;
}

export interface MarketHeatmapSector {
  sector: string;
  marketCap: number;
  weightedChangePercent: number;
  count: number;
}

export interface MarketHeatmapData {
  total: number;
  limit: number;
  sectors: string[];
  cells: MarketHeatmapCell[];
  sectorSummaries: MarketHeatmapSector[];
}

export interface MarketHeatmapSnapshot extends MarketHeatmapData {
  generatedAt: string;
  cache: "fresh" | "stale" | "refreshed";
  revalidating: boolean;
}

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function normalizeHeatmapQuery(query: MarketHeatmapQuery = {}): Required<Pick<MarketHeatmapQuery, "limit">> & MarketHeatmapQuery {
  const limit = query.limit ?? 250;
  if (!Number.isInteger(limit) || limit < 25 || limit > 400) invalid("heatmap limit must be 25-400");
  const sector = query.sector?.trim();
  if (sector && sector.length > 80) invalid("heatmap sector is too long");
  const { sector: _sector, ...rest } = query;
  return { ...rest, ...(sector ? { sector } : {}), limit };
}

export function buildMarketHeatmap(rows: readonly MarketUniverseRow[], query: MarketHeatmapQuery = {}): MarketHeatmapData {
  const normalized = normalizeHeatmapQuery(query);
  const valid = rows.filter((row): row is MarketHeatmapCell =>
    row.marketCap !== undefined
    && row.marketCap > 0
    && row.changePercent !== undefined
    && Number.isFinite(row.changePercent));
  const sectors = [...new Set(valid.map((row) => row.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sectorNeedle = normalized.sector?.toLocaleLowerCase();
  const filtered = sectorNeedle
    ? valid.filter((row) => row.sector.toLocaleLowerCase() === sectorNeedle)
    : valid;
  const cells = [...filtered]
    .sort((left, right) => right.marketCap - left.marketCap || left.symbol.localeCompare(right.symbol))
    .slice(0, normalized.limit);
  const grouped = new Map<string, { marketCap: number; weightedMove: number; count: number }>();
  for (const cell of cells) {
    const current = grouped.get(cell.sector) ?? { marketCap: 0, weightedMove: 0, count: 0 };
    current.marketCap += cell.marketCap;
    current.weightedMove += cell.marketCap * cell.changePercent;
    current.count += 1;
    grouped.set(cell.sector, current);
  }
  const sectorSummaries = [...grouped.entries()]
    .map(([sector, value]) => ({
      sector,
      marketCap: value.marketCap,
      weightedChangePercent: value.marketCap > 0 ? value.weightedMove / value.marketCap : 0,
      count: value.count,
    }))
    .sort((left, right) => right.marketCap - left.marketCap || left.sector.localeCompare(right.sector));
  return {
    total: filtered.length,
    limit: normalized.limit,
    sectors,
    cells,
    sectorSummaries,
  };
}
