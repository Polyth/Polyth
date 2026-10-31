import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketHeatmap } from "../src/heatmap.ts";
import { MarketUniverseService, type MarketUniverseRow } from "../src/screener.ts";

const rows: MarketUniverseRow[] = [
  { symbol: "AAA", name: "Alpha", marketCap: 60, changePercent: 2, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
  { symbol: "BBB", name: "Beta", marketCap: 40, changePercent: -1, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
  { symbol: "CCC", name: "Gamma", marketCap: 50, changePercent: 3, sector: "Financials", exchange: "NYSE", source: "fixture" },
  { symbol: "DDD", name: "No move", marketCap: 30, sector: "Financials", exchange: "NYSE", source: "fixture" },
];

test("heatmap keeps valid market-cap cells, summarizes sectors, and filters before limit", () => {
  const all = buildMarketHeatmap(rows, { limit: 25 });
  assert.deepEqual(all.cells.map((cell) => cell.symbol), ["AAA", "CCC", "BBB"]);
  assert.equal(all.total, 3);
  const technology = all.sectorSummaries.find((sector) => sector.sector === "Technology");
  assert.equal(technology?.marketCap, 100);
  assert.equal(technology?.count, 2);
  assert.ok(Math.abs((technology?.weightedChangePercent ?? 0) - 0.8) < 1e-9);

  const filtered = buildMarketHeatmap(rows, { sector: "financials", limit: 25 });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.cells.map((cell) => cell.symbol), ["CCC"]);
  assert.deepEqual(filtered.sectors, ["Financials", "Technology"]);
});

test("heatmap validates bounded payload size and ignores blank sector", () => {
  assert.throws(() => buildMarketHeatmap(rows, { limit: 24 }), /limit must be 25-400/);
  assert.throws(() => buildMarketHeatmap(rows, { limit: 401 }), /limit must be 25-400/);
  assert.equal(buildMarketHeatmap(rows, { sector: "   ", limit: 25 }).total, 3);
});

test("screener and heatmap share the same cached market-universe load", async () => {
  let loads = 0;
  const service = new MarketUniverseService(async () => {
    loads += 1;
    return rows;
  }, () => 0);

  const screen = await service.screen({ limit: 50 });
  const heatmap = await service.heatmap({ limit: 25 });
  assert.equal(screen.total, 4);
  assert.equal(heatmap.total, 3);
  assert.equal(loads, 1);
});
