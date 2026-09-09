import assert from "node:assert/strict";
import test from "node:test";
import type { ServerPackage } from "@polyth/plugins";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketsService } from "../src/service.ts";

const service = (): MarketsService => {
  const markets = new MarketsService({ now: () => Date.UTC(2026, 8, 9) });
  markets.registerProvider({
    id: "fixture",
    async quote(symbol) {
      if (symbol === "BAD") throw new Error("missing");
      return {
        symbol,
        currency: "USD",
        price: symbol === "AAPL" ? 230 : 181.42,
        asOf: "2026-09-09T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async search(query) {
      return [{ symbol: "NVDA", name: `NVIDIA ${query}`, assetType: "equity", source: "fixture" }];
    },
    async candles(symbol, range) {
      return {
        symbol,
        range,
        candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2 }],
        asOf: "2026-09-09T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async fundamentals(symbol) {
      return {
        symbol,
        pe: 20,
        asOf: "2026-09-09T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
  });
  return markets;
};

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(pathAndQuery: string): Promise<{ handled: boolean; status: number; body: unknown }> {
  let status = 0;
  let body: unknown;
  const url = new URL(pathAndQuery, "http://localhost");
  const route = marketsRoutes(service());
  const request = {
    path: url.pathname,
    method: "GET",
    url,
    json(nextStatus: number, nextBody: unknown) {
      status = nextStatus;
      body = nextBody;
    },
  } as RouteRequest;
  return { handled: await route(request), status, body };
}

test("quote route batches symbols and preserves partial failures", async () => {
  const response = await invoke("/api/markets/quote?symbols=NVDA,BAD,AAPL,NVDA");
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as { items: Array<{ data: { symbol: string } }>; errors: Array<{ symbol: string }> };
  assert.deepEqual(body.items.map((item) => item.data.symbol), ["NVDA", "AAPL"]);
  assert.deepEqual(body.errors.map((item) => item.symbol), ["BAD"]);
});

test("quote route rejects empty and oversized batches", async () => {
  assert.equal((await invoke("/api/markets/quote")).status, 400);
  const symbols = Array.from({ length: 51 }, (_, index) => `S${index}`).join(",");
  assert.equal((await invoke(`/api/markets/quote?symbols=${symbols}`)).status, 400);
});

test("market read routes expose search, candles, fundamentals, and health", async () => {
  assert.equal((await invoke("/api/markets/search?q=nvidia")).status, 200);
  assert.equal((await invoke("/api/markets/candles?symbol=NVDA&range=1Y")).status, 200);
  assert.equal((await invoke("/api/markets/fundamentals?symbol=NVDA")).status, 200);
  const health = await invoke("/api/markets/providers");
  assert.equal(health.status, 200);
  assert.deepEqual((health.body as { providers: Array<{ providerId: string }> }).providers.map((item) => item.providerId), ["fixture"]);
});
