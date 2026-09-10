import assert from "node:assert/strict";
import test from "node:test";
import {
  BINANCE_CRYPTO_ASSETS,
  createBinanceProvider,
  createFredProvider,
  parseFredCsv,
  type MarketMacroIndicator,
  type MarketMacroSnapshot,
} from "../src/index.ts";

test("Markets public entry exports macro and crypto primitives", () => {
  assert.equal(typeof createBinanceProvider, "function");
  assert.equal(typeof createFredProvider, "function");
  assert.equal(typeof parseFredCsv, "function");
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
});
