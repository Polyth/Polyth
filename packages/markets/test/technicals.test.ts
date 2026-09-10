import assert from "node:assert/strict";
import test from "node:test";
import {
  bollingerBands,
  calculateMarketTechnicals,
  exponentialMovingAverage,
  movingAverageConvergenceDivergence,
  relativeStrengthIndex,
  simpleMovingAverage,
} from "../src/technicals.ts";
import type { MarketCandleSeries } from "../src/types.ts";

const seriesFrom = (closes: number[]): MarketCandleSeries => ({
  symbol: "TEST",
  range: "6M",
  candles: closes.map((close, index) => ({
    time: 1_700_000_000 + index * 86_400,
    open: close,
    high: close,
    low: close,
    close,
  })),
  asOf: "2026-09-10T00:00:00.000Z",
  source: "fixture",
  freshness: "delayed",
});

test("moving averages preserve explicit warm-up and expected values", () => {
  const values = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(simpleMovingAverage(values, 3), [undefined, undefined, 2, 3, 4, 5]);
  const ema = exponentialMovingAverage(values, 3);
  assert.deepEqual(ema.slice(0, 3), [undefined, undefined, 2]);
  assert.equal(ema[3], 3);
  assert.equal(ema[5], 5);
});

test("RSI handles flat, rising, and falling series without infinities", () => {
  const flat = relativeStrengthIndex(new Array(20).fill(100), 14);
  const rising = relativeStrengthIndex(Array.from({ length: 20 }, (_, index) => index + 1), 14);
  const falling = relativeStrengthIndex(Array.from({ length: 20 }, (_, index) => 20 - index), 14);
  assert.equal(flat.at(-1), 50);
  assert.equal(rising.at(-1), 100);
  assert.equal(falling.at(-1), 0);
});

test("MACD signal starts only after slow and signal warm-up", () => {
  const values = new Array(50).fill(100);
  const result = movingAverageConvergenceDivergence(values, 12, 26, 9);
  assert.equal(result.macd[24], undefined);
  assert.equal(result.macd[25], 0);
  assert.equal(result.signal[32], undefined);
  assert.equal(result.signal[33], 0);
  assert.equal(result.histogram[33], 0);
});

test("Bollinger bands collapse to the mean for a flat series", () => {
  const bands = bollingerBands(new Array(25).fill(42), 20, 2);
  assert.equal(bands.middle[19], 42);
  assert.equal(bands.upper[24], 42);
  assert.equal(bands.lower[24], 42);
});

test("technical snapshot derives signals and caps serialized history", () => {
  const rising = calculateMarketTechnicals(seriesFrom(Array.from({ length: 80 }, (_, index) => index + 1)));
  assert.equal(rising.latest?.sma20, 70.5);
  assert.equal(rising.latest?.sma50, 55.5);
  assert.equal(rising.latest?.rsi14, 100);
  assert.equal(rising.signals.trend, "bullish");
  assert.equal(rising.signals.momentum, "overbought");

  const flat = calculateMarketTechnicals(seriesFrom(new Array(80).fill(100)));
  assert.equal(flat.signals.trend, "neutral");
  assert.equal(flat.signals.momentum, "neutral");
  assert.equal(flat.signals.macd, "neutral");
  assert.equal(flat.signals.bollinger, "inside");

  const long = calculateMarketTechnicals(seriesFrom(new Array(600).fill(100)));
  assert.equal(long.points.length, 500);
  assert.equal(long.points[0]?.time, 1_700_000_000 + 100 * 86_400);
});
