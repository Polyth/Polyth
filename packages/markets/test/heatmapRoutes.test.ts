import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import type { ServerPackage } from "@polyth/plugins";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketUniverseService, type MarketUniverseRow } from "../src/screener.ts";
import { MarketsService } from "../src/service.ts";

const rows: MarketUniverseRow[] = [
  { symbol: "AAA", name: "Alpha", marketCap: 60, changePercent: 2, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
  { symbol: "BBB", name: "Beta", marketCap: 40, changePercent: -1, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
  { symbol: "CCC", name: "Gamma", marketCap: 50, changePercent: 3, sector: "Financials", exchange: "NYSE", source: "fixture" },
];

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(pathAndQuery: string, universe: MarketUniverseService) {
  let status = 0;
  let responseBody: unknown;
  const url = new URL(pathAndQuery, "http://localhost");
  const route = marketsRoutes({
    spaceStorage: () => {
      throw new Error("storage should not be used by heatmap routes");
    },
  }, new MarketsService(), universe);
  const request = {
    path: url.pathname,
    method: "GET",
    url,
    space: {} as SpaceContext,
    json(nextStatus: number, nextBody: unknown) {
      status = nextStatus;
      responseBody = nextBody;
    },
  } as RouteRequest;
  return { handled: await route(request), status, body: responseBody };
}

test("heatmap route filters sector and returns bounded cells with summaries", async () => {
  const universe = new MarketUniverseService(async () => rows, () => 0);
  const response = await invoke("/api/markets/heatmap?sector=Technology&limit=25", universe);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as {
    total: number;
    limit: number;
    cells: Array<{ symbol: string }>;
    sectorSummaries: Array<{ sector: string; count: number }>;
  };
  assert.equal(body.total, 2);
  assert.equal(body.limit, 25);
  assert.deepEqual(body.cells.map((cell) => cell.symbol), ["AAA", "BBB"]);
  assert.deepEqual(body.sectorSummaries, [{ sector: "Technology", marketCap: 100, weightedChangePercent: 0.8, count: 2 }]);
});

test("invalid heatmap input returns 400 before loading the shared universe", async () => {
  let loads = 0;
  const universe = new MarketUniverseService(async () => {
    loads += 1;
    return rows;
  }, () => 0);
  const response = await invoke("/api/markets/heatmap?limit=401", universe);
  assert.equal(response.status, 400);
  assert.equal(loads, 0);
});
