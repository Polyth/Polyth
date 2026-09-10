import assert from "node:assert/strict";
import test from "node:test";
import {
  BINANCE_CRYPTO_ASSETS,
  MarketUniverseService,
  buildMarketHeatmap,
  createBinanceProvider,
  createFredProvider,
  createTradingViewUniverseLoader,
  parseFredCsv,
  screenMarketUniverse,
  type MarketHeatmapSnapshot,
  type MarketMacroIndicator,
  type MarketMacroSnapshot,
  type MarketUniverseRow,
} from "../src/index.ts";

test("Markets public entry exports macro, crypto, screener, and heatmap primitives", () => {
  assert.equal(typeof createBinanceProvider, "function");
  assert.equal(typeof createFredProvider, "function");
  assert.equal(typeof parseFredCsv, "function");
  assert.equal(typeof createTradingViewUniverseLoader, "function");
  assert.equal(typeof MarketUniverseService, "function");
  assert.equal(typeof screenMarketUniverse, "function");
  assert.equal(typeof buildMarketHeatmap, "function");
  assert.ok(BINANCE_CRYPTO_ASSETS.some((asset) => asset.symbol === "BTC/USDT"));

  const indicator: MarketMacroIndicator = {
    id: "treasury-10y",
    label: "U.S. Treasury 10Y",
    value: 4.1,
    unit: "percent",
    asOf: "2026-09-09",
    source: "fixture",
  };
  const snapshot: MarketMacroSnapshot = {
    generatedAt: "2026-09-10T00:00:00.000Z",
    indicators: [indicator],
    markets: [],
    errors: [],
  };
  assert.equal(snapshot.indicators[0]?.id, "treasury-10y");

  const row: MarketUniverseRow = {
    symbol: "NVDA",
    name: "NVIDIA",
    price: 100,
    changePercent: 2,
    volume: 1_000_000,
    marketCap: 1_000_000_000,
    sector: "Technology",
    exchange: "NASDAQ",
    source: "fixture",
  };
  assert.equal(screenMarketUniverse([row]).rows[0]?.symbol, "NVDA");
  const heatmap: MarketHeatmapSnapshot = {
    ...buildMarketHeatmap([row], { limit: 25 }),
    generatedAt: "2026-09-10T00:00:00.000Z",
    cache: "fresh",
    revalidating: false,
  };
  assert.equal(heatmap.cells[0]?.symbol, "NVDA");
});
