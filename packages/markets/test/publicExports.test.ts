import assert from "node:assert/strict";
import test from "node:test";
import {
  BINANCE_CRYPTO_ASSETS,
  MarketCalendarService,
  MarketUniverseService,
  buildMarketHeatmap,
  calculateMarketTechnicals,
  calendarSymbolSupported,
  createBinanceProvider,
  createForexFactoryEconomicCalendarLoader,
  createFredProvider,
  createTradingViewEarningsCalendarLoader,
  createTradingViewUniverseLoader,
  normalizeCalendarSymbols,
  parseFredCsv,
  screenMarketUniverse,
  type MarketCandleSeries,
  type MarketEconomicEvent,
  type MarketEarningsCalendarEntry,
  type MarketHeatmapSnapshot,
  type MarketMacroIndicator,
  type MarketMacroSnapshot,
  type MarketTechnicalSnapshot,
  type MarketUniverseRow,
} from "../src/index.ts";

test("Markets public entry exports macro, crypto, screener, heatmap, technical, and calendar primitives", () => {
  assert.equal(typeof createBinanceProvider, "function");
  assert.equal(typeof createFredProvider, "function");
  assert.equal(typeof parseFredCsv, "function");
  assert.equal(typeof createTradingViewUniverseLoader, "function");
  assert.equal(typeof createTradingViewEarningsCalendarLoader, "function");
  assert.equal(typeof createForexFactoryEconomicCalendarLoader, "function");
  assert.equal(typeof MarketCalendarService, "function");
  assert.equal(typeof MarketUniverseService, "function");
  assert.equal(typeof screenMarketUniverse, "function");
  assert.equal(typeof buildMarketHeatmap, "function");
  assert.equal(typeof calculateMarketTechnicals, "function");
  assert.equal(calendarSymbolSupported("NVDA"), true);
  assert.deepEqual(normalizeCalendarSymbols(["NVDA", "BMW.DE"]), ["NVDA"]);
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

  const economic: MarketEconomicEvent = {
    title: "CPI y/y",
    currency: "USD",
    date: "2026-09-10T12:30:00.000Z",
    impact: "High",
    source: "fixture",
  };
  const earnings: MarketEarningsCalendarEntry = {
    symbol: "NVDA",
    nextEarningsAt: "2026-11-18T21:00:00.000Z",
    source: "fixture",
  };
  assert.equal(economic.impact, "High");
  assert.equal(earnings.symbol, "NVDA");

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

  const candleSeries: MarketCandleSeries = {
    symbol: "NVDA",
    range: "6M",
    candles: Array.from({ length: 60 }, (_, index) => ({
      time: 1_700_000_000 + index * 86_400,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    })),
    asOf: "2026-09-10T00:00:00.000Z",
    source: "fixture",
    freshness: "delayed",
  };
  const technicals: MarketTechnicalSnapshot = calculateMarketTechnicals(candleSeries);
  assert.equal(technicals.latest?.rsi14, 50);
});
