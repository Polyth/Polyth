import assert from "node:assert/strict";
import test from "node:test";
import { createTradingViewUniverseLoader } from "../src/providers/tradingviewUniverse.ts";
import type { FetchLike } from "../src/providers/http.ts";
import { MarketUniverseService, screenMarketUniverse, type MarketUniverseRow } from "../src/screener.ts";

const rows: MarketUniverseRow[] = [
  { symbol: "AAA", name: "Alpha", price: 10, changePercent: 4, volume: 3_000_000, marketCap: 20_000_000_000, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
  { symbol: "BBB", name: "Beta", price: 20, changePercent: -2, volume: 5_000_000, marketCap: 40_000_000_000, sector: "Financials", exchange: "NYSE", source: "fixture" },
  { symbol: "CCC", name: "Gamma", price: 30, changePercent: 1, volume: 1_000_000, sector: "Technology", exchange: "NASDAQ", source: "fixture" },
];

test("screener filters, sorts, paginates, and keeps missing sort values last", () => {
  const page = screenMarketUniverse(rows, {
    sector: "technology",
    changeMin: 0,
    sort: "marketCap",
    direction: "desc",
    limit: 1,
  });
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map((row) => row.symbol), ["AAA"]);
  assert.deepEqual(page.sectors, ["Financials", "Technology"]);

  const ascending = screenMarketUniverse(rows, { sort: "marketCap", direction: "asc", limit: 10 });
  assert.deepEqual(ascending.rows.map((row) => row.symbol), ["AAA", "BBB", "CCC"]);
});

test("screener validates bounded pagination and non-negative size filters", () => {
  assert.throws(() => screenMarketUniverse(rows, { limit: 101 }), /limit must be 1-100/);
  assert.throws(() => screenMarketUniverse(rows, { offset: -1 }), /offset must be 0-10000/);
  assert.throws(() => screenMarketUniverse(rows, { marketCapMin: -1 }), /marketCapMin must be non-negative/);
  assert.throws(() => screenMarketUniverse(rows, { volumeMin: -1 }), /volumeMin must be non-negative/);
});

test("blank sector is normalized away instead of filtering out the universe", () => {
  const page = screenMarketUniverse(rows, { sector: "   " });
  assert.equal(page.total, rows.length);
});

test("market universe service validates before loading and shares one cached load across queries", async () => {
  let calls = 0;
  const service = new MarketUniverseService(async () => {
    calls += 1;
    return rows;
  }, () => 0);
  await assert.rejects(service.screen({ limit: 101 }), /limit must be 1-100/);
  assert.equal(calls, 0);
  const first = await service.screen({ sector: "Technology" });
  const second = await service.screen({ sector: "Financials" });
  assert.equal(first.total, 2);
  assert.equal(second.total, 1);
  assert.equal(calls, 1);
});

test("TradingView universe loader uses one scanner request and removes OTC rows", async () => {
  let calls = 0;
  let method = "";
  let body = "";
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    method = init?.method ?? "";
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({
      data: [
        { s: "NASDAQ:AAA", d: ["Alpha", 10, 4, 20_000_000_000, "Technology", 3_000_000, "NASDAQ"] },
        { s: "OTC:FOREIGN", d: ["Foreign mirror", 5, 1, 1_000_000, "Other", 10_000, "OTC"] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchLike;

  const load = createTradingViewUniverseLoader({ fetch: fetchImpl, limit: 1_500 });
  const universe = await load();
  assert.equal(calls, 1);
  assert.equal(method, "POST");
  assert.match(body, /market_cap_basic/);
  assert.match(body, /"range":\[0,1500\]/);
  assert.deepEqual(universe.map((row) => row.symbol), ["AAA"]);
});
