import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import type { ServerPackage } from "@polyth/plugins";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketsService } from "../src/service.ts";

const service = (): MarketsService => {
  const markets = new MarketsService({ now: () => Date.UTC(2026, 8, 10) });
  markets.registerProvider({
    id: "fixture",
    async quote(symbol) {
      return {
        symbol,
        name: symbol,
        assetType: "index",
        currency: "USD",
        price: symbol === "^VIX" ? 15 : 100,
        changePercent: 1,
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async macro() {
      return [{
        id: "treasury-10y",
        label: "U.S. Treasury 10Y",
        value: 4.1,
        unit: "percent",
        asOf: "2026-09-09",
        source: "fixture",
      }];
    },
    async crypto() {
      return [{
        symbol: "BTC/USDT",
        name: "Bitcoin",
        assetType: "crypto",
        currency: "USDT",
        exchange: "Fixture",
        price: 110_000,
        changePercent: 2.5,
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "live",
      }];
    },
  });
  return markets;
};

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(path: string): Promise<{ handled: boolean; status: number; body: unknown }> {
  let status = 0;
  let responseBody: unknown;
  const route = marketsRoutes({
    spaceStorage: () => {
      throw new Error("storage should not be used by macro/crypto routes");
    },
  }, service());
  const request = {
    path,
    method: "GET",
    url: new URL(path, "http://localhost"),
    space: {} as SpaceContext,
    json(nextStatus: number, nextBody: unknown) {
      status = nextStatus;
      responseBody = nextBody;
    },
  } as RouteRequest;
  return { handled: await route(request), status, body: responseBody };
}

test("macro route returns indicators and major market quotes", async () => {
  const response = await invoke("/api/markets/macro");
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as {
    indicators: Array<{ id: string; value: number }>;
    markets: Array<{ symbol: string }>;
    errors: string[];
  };
  assert.deepEqual(body.indicators, [{
    id: "treasury-10y",
    label: "U.S. Treasury 10Y",
    value: 4.1,
    unit: "percent",
    asOf: "2026-09-09",
    source: "fixture",
  }]);
  assert.deepEqual(body.markets.map((item) => item.symbol), ["^GSPC", "^IXIC", "^VIX"]);
  assert.deepEqual(body.errors, []);
});

test("crypto route returns the cached provider board contract", async () => {
  const response = await invoke("/api/markets/crypto");
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as { data: Array<{ symbol: string; price: number }> };
  assert.deepEqual(body.data.map((item) => item.symbol), ["BTC/USDT"]);
  assert.equal(body.data[0]?.price, 110_000);
});
