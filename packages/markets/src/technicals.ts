import type { MarketCandleSeries, MarketDataFreshness, MarketRange } from "./types.ts";

export interface MarketTechnicalPoint {
  time: number;
  close: number;
  sma20?: number;
  sma50?: number;
  ema20?: number;
  rsi14?: number;
  macd?: number;
  macdSignal?: number;
  macdHistogram?: number;
  bollingerUpper?: number;
  bollingerMiddle?: number;
  bollingerLower?: number;
}

export type MarketTechnicalSignal = "bullish" | "bearish" | "neutral" | "unknown";
export type MarketRsiSignal = "overbought" | "oversold" | "neutral" | "unknown";
export type MarketBandSignal = "above" | "below" | "inside" | "unknown";

export interface MarketTechnicalSignals {
  trend: MarketTechnicalSignal;
  momentum: MarketRsiSignal;
  macd: MarketTechnicalSignal;
  bollinger: MarketBandSignal;
}

export interface MarketTechnicalSnapshot {
  symbol: string;
  range: MarketRange;
  asOf: string;
  source: string;
  freshness: MarketDataFreshness;
  points: MarketTechnicalPoint[];
  latest?: MarketTechnicalPoint;
  signals: MarketTechnicalSignals;
}

const MAX_POINTS = 500;

function requirePeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new Error("indicator period must be a positive integer");
}

export function simpleMovingAverage(values: readonly number[], period: number): Array<number | undefined> {
  requirePeriod(period);
  const output: Array<number | undefined> = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) sum -= values[index - period]!;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

export function exponentialMovingAverage(values: readonly number[], period: number): Array<number | undefined> {
  requirePeriod(period);
  const output: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (values.length < period) return output;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = seed;
  const alpha = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = values[index]! * alpha + previous * (1 - alpha);
    output[index] = previous;
  }
  return output;
}

export function relativeStrengthIndex(values: readonly number[], period = 14): Array<number | undefined> {
  requirePeriod(period);
  const output: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (values.length <= period) return output;

  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    if (change > 0) gain += change;
    else loss -= change;
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  const rsi = (): number => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;
    const rs = averageGain / averageLoss;
    return 100 - (100 / (1 + rs));
  };
  output[period] = rsi();

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    const currentGain = Math.max(change, 0);
    const currentLoss = Math.max(-change, 0);
    averageGain = ((averageGain * (period - 1)) + currentGain) / period;
    averageLoss = ((averageLoss * (period - 1)) + currentLoss) / period;
    output[index] = rsi();
  }
  return output;
}

export interface MacdSeries {
  macd: Array<number | undefined>;
  signal: Array<number | undefined>;
  histogram: Array<number | undefined>;
}

export function movingAverageConvergenceDivergence(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeries {
  requirePeriod(fastPeriod);
  requirePeriod(slowPeriod);
  requirePeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) throw new Error("MACD fast period must be less than slow period");

  const fast = exponentialMovingAverage(values, fastPeriod);
  const slow = exponentialMovingAverage(values, slowPeriod);
  const macd = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return fastValue === undefined || slowValue === undefined ? undefined : fastValue - slowValue;
  });
  const signal: Array<number | undefined> = new Array(values.length).fill(undefined);
  const histogram: Array<number | undefined> = new Array(values.length).fill(undefined);
  const seed: number[] = [];
  let previousSignal: number | undefined;
  const alpha = 2 / (signalPeriod + 1);

  for (let index = 0; index < macd.length; index += 1) {
    const value = macd[index];
    if (value === undefined) continue;
    if (previousSignal === undefined) {
      seed.push(value);
      if (seed.length < signalPeriod) continue;
      previousSignal = seed.reduce((sum, item) => sum + item, 0) / signalPeriod;
    } else {
      previousSignal = value * alpha + previousSignal * (1 - alpha);
    }
    signal[index] = previousSignal;
    histogram[index] = value - previousSignal;
  }
  return { macd, signal, histogram };
}

export interface BollingerSeries {
  upper: Array<number | undefined>;
  middle: Array<number | undefined>;
  lower: Array<number | undefined>;
}

export function bollingerBands(values: readonly number[], period = 20, deviations = 2): BollingerSeries {
  requirePeriod(period);
  if (!Number.isFinite(deviations) || deviations <= 0) throw new Error("Bollinger deviations must be positive");
  const middle = simpleMovingAverage(values, period);
  const upper: Array<number | undefined> = new Array(values.length).fill(undefined);
  const lower: Array<number | undefined> = new Array(values.length).fill(undefined);
  for (let index = period - 1; index < values.length; index += 1) {
    const mean = middle[index]!;
    let variance = 0;
    for (let offset = index - period + 1; offset <= index; offset += 1) {
      const delta = values[offset]! - mean;
      variance += delta * delta;
    }
    const sigma = Math.sqrt(variance / period);
    upper[index] = mean + deviations * sigma;
    lower[index] = mean - deviations * sigma;
  }
  return { upper, middle, lower };
}

function technicalSignals(latest?: MarketTechnicalPoint): MarketTechnicalSignals {
  if (!latest) return { trend: "unknown", momentum: "unknown", macd: "unknown", bollinger: "unknown" };
  const trend = latest.sma20 === undefined || latest.sma50 === undefined
    ? "unknown"
    : latest.close > latest.sma20 && latest.sma20 > latest.sma50
      ? "bullish"
      : latest.close < latest.sma20 && latest.sma20 < latest.sma50
        ? "bearish"
        : "neutral";
  const momentum = latest.rsi14 === undefined
    ? "unknown"
    : latest.rsi14 >= 70 ? "overbought" : latest.rsi14 <= 30 ? "oversold" : "neutral";
  const macd = latest.macdHistogram === undefined
    ? "unknown"
    : latest.macdHistogram > 0 ? "bullish" : latest.macdHistogram < 0 ? "bearish" : "neutral";
  const bollinger = latest.bollingerUpper === undefined || latest.bollingerLower === undefined
    ? "unknown"
    : latest.close > latest.bollingerUpper ? "above" : latest.close < latest.bollingerLower ? "below" : "inside";
  return { trend, momentum, macd, bollinger };
}

export function calculateMarketTechnicals(series: MarketCandleSeries): MarketTechnicalSnapshot {
  const closes = series.candles.map((candle) => candle.close);
  const sma20 = simpleMovingAverage(closes, 20);
  const sma50 = simpleMovingAverage(closes, 50);
  const ema20 = exponentialMovingAverage(closes, 20);
  const rsi14 = relativeStrengthIndex(closes, 14);
  const macd = movingAverageConvergenceDivergence(closes);
  const bands = bollingerBands(closes, 20, 2);
  const points = series.candles.map((candle, index): MarketTechnicalPoint => ({
    time: candle.time,
    close: candle.close,
    ...(sma20[index] !== undefined ? { sma20: sma20[index] } : {}),
    ...(sma50[index] !== undefined ? { sma50: sma50[index] } : {}),
    ...(ema20[index] !== undefined ? { ema20: ema20[index] } : {}),
    ...(rsi14[index] !== undefined ? { rsi14: rsi14[index] } : {}),
    ...(macd.macd[index] !== undefined ? { macd: macd.macd[index] } : {}),
    ...(macd.signal[index] !== undefined ? { macdSignal: macd.signal[index] } : {}),
    ...(macd.histogram[index] !== undefined ? { macdHistogram: macd.histogram[index] } : {}),
    ...(bands.upper[index] !== undefined ? { bollingerUpper: bands.upper[index] } : {}),
    ...(bands.middle[index] !== undefined ? { bollingerMiddle: bands.middle[index] } : {}),
    ...(bands.lower[index] !== undefined ? { bollingerLower: bands.lower[index] } : {}),
  })).slice(-MAX_POINTS);
  const latest = points.at(-1);
  return {
    symbol: series.symbol,
    range: series.range,
    asOf: series.asOf,
    source: series.source,
    freshness: series.freshness,
    points,
    ...(latest ? { latest } : {}),
    signals: technicalSignals(latest),
  };
}
