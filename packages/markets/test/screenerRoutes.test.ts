import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import type { ServerPackage } from "@polyth/plugins";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketUniverseService, type MarketUniverseRow } from "../src/screener.ts";
import { MarketsService } from "../src/service.ts";

const rows: MarketUniverseRow[] = [
  { symbol: "AAA", name: "Alpha", price: 10, changePercent: 4, volume: 3_000_000, marketCap: 20_000_000_000, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
  { symbol: "BBB", name: "Beta", price: 20, changePercent: -2, volume: 5_000_000, marketCap: 40_000_000_000, sector: "Financials", exchange: "NYSE", source: "fixture" },
];

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(pathAndQuery: string, screener: MarketUniverseService) {
  let status = 0;
  let responseBody: unknown;
  const url = new URL(pathAndQuery, "http://localhost");
  const route = marketsRoutes({
    spaceStorage: () => {
      throw new Error("storage should not be used by screener routes");
    },
  }, new MarketsService(), screener);
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

test("screener route filters, sorts, and paginates server-side", async () => {
  const screener = new MarketUniverseService(async () => rows, () => 0);
  const response = await invoke("/api/markets/screener?sector=Technology&changeMin=1&sort=changePercent&dir=desc&offset=0&limit=25", screener);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as { total: number; limit: number; rows: Array<{ symbol: string }>; sectors: string[] };
  assert.equal(body.total, 1);
  assert.equal(body.limit, 25);
  assert.deepEqual(body.rows.map((row) => row.symbol), ["AAA"]);
  assert.deepEqual(body.sectors, ["Financials", "Technology"]);
});

test("invalid screener input returns 400 before loading the market universe", async () => {
  let loads = 0;
  const screener = new MarketUniverseService(async () => {
    loads += 1;
    return rows;
  }, () => 0);
  const oversized = await invoke("/api/markets/screener?limit=101", screener);
  assert.equal(oversized.status, 400);
  assert.equal(loads, 0);

  const negative = await invoke("/api/markets/screener?marketCapMin=-1", screener);
  assert.equal(negative.status, 400);
  assert.equal(loads, 0);
});
