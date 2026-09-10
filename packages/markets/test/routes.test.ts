import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
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
        candles: [
          { time: 1, open: 1, high: 2, low: 1, close: 1 },
          { time: 2, open: 2, high: 3, low: 2, close: 2 },
        ],
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
    async news(symbol) {
      return [{ title: "Fixture news", url: "https://example.com/news", publisher: "Fixture", symbol, source: "fixture" }];
    },
  });
  return markets;
};

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(pathAndQuery: string): Promise<{ handled: boolean; status: number; body: unknown }> {
  let status = 0;
  let responseBody: unknown;
  const url = new URL(pathAndQuery, "http://localhost");
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-routes-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const route = marketsRoutes({ spaceStorage: () => storage }, service());
  const space = { storageDir: root } as SpaceContext;
  const request = {
    path: url.pathname,
    method: "GET",
    url,
    space,
    json(nextStatus: number, nextBody: unknown) {
      status = nextStatus;
      responseBody = nextBody;
    },
  } as RouteRequest;
  return { handled: await route(request), status, body: responseBody };
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

test("market read routes expose search, candles, fundamentals, news, context, compare, and health", async () => {
  assert.equal((await invoke("/api/markets/search?q=nvidia")).status, 200);
  assert.equal((await invoke("/api/markets/candles?symbol=NVDA&range=1Y")).status, 200);
  assert.equal((await invoke("/api/markets/fundamentals?symbol=NVDA")).status, 200);
  assert.equal((await invoke("/api/markets/news?symbol=NVDA")).status, 200);
  const context = await invoke("/api/markets/context?symbol=NVDA&range=1M");
  assert.equal(context.status, 200);
  assert.equal((context.body as { performance: { changePercent: number } }).performance.changePercent, 100);
  const comparison = await invoke("/api/markets/compare?symbols=NVDA,AAPL,NVDA&range=1M");
  assert.equal(comparison.status, 200);
  const comparisonBody = comparison.body as { range: string; items: Array<{ symbol: string; performance?: { changePercent: number } }> };
  assert.equal(comparisonBody.range, "1M");
  assert.deepEqual(comparisonBody.items.map((item) => item.symbol), ["NVDA", "AAPL"]);
  assert.equal(comparisonBody.items[0]?.performance?.changePercent, 100);
  const health = await invoke("/api/markets/providers");
  assert.equal(health.status, 200);
  assert.deepEqual((health.body as { providers: Array<{ providerId: string }> }).providers.map((item) => item.providerId), ["fixture"]);
});

test("compare route enforces symbol and range bounds", async () => {
  assert.equal((await invoke("/api/markets/compare?symbols=NVDA")).status, 400);
  assert.equal((await invoke("/api/markets/compare?symbols=NVDA,AAPL&range=NOPE")).status, 400);
  const symbols = Array.from({ length: 9 }, (_, index) => `S${index}`).join(",");
  assert.equal((await invoke(`/api/markets/compare?symbols=${symbols}`)).status, 400);
});
