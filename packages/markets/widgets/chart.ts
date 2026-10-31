import type { MarketCandle } from "../src/types.ts";

export interface CloseLine {
  path: string;
  minimum: number;
  maximum: number;
  first: number;
  last: number;
}

export function buildCloseLine(
  candles: readonly MarketCandle[],
  width = 1_000,
  height = 260,
  padding = 8,
): CloseLine | null {
  const values = candles.map((candle) => candle.close).filter(Number.isFinite);
  if (values.length < 2) return null;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, Math.abs(maximum) * 0.001, 1e-9);
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const lastIndex = values.length - 1;
  const points = values.map((value, index) => {
    const x = padding + (index / lastIndex) * usableWidth;
    const y = padding + ((maximum - value) / range) * usableHeight;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return {
    path: points.join(" "),
    minimum,
    maximum,
    first: values[0]!,
    last: values[lastIndex]!,
  };
}
