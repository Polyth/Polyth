import type { MarketProvider } from "../providers.ts";
import type { MarketMacroIndicator } from "../types.ts";
import { createLimiter, fetchText, type FetchLike } from "./http.ts";

interface FredPoint {
  date: string;
  value: number;
}

export interface FredProviderOptions {
  fetch?: FetchLike;
  now?: () => number;
}

export function parseFredCsv(csv: string): FredPoint[] {
  const points: FredPoint[] = [];
  const lines = csv.trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const comma = line.indexOf(",");
    if (comma <= 0) continue;
    const date = line.slice(0, comma).trim();
    const raw = line.slice(comma + 1).trim();
    const value = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === "." || !Number.isFinite(value)) continue;
    points.push({ date, value });
  }
  return points;
}

const latest = (points: readonly FredPoint[]): FredPoint | undefined => points.at(-1);

function latestCommon(left: readonly FredPoint[], right: readonly FredPoint[]): [FredPoint, FredPoint] | undefined {
  const rightByDate = new Map(right.map((point) => [point.date, point]));
  for (let index = left.length - 1; index >= 0; index -= 1) {
    const l = left[index];
    if (!l) continue;
    const r = rightByDate.get(l.date);
    if (r) return [l, r];
  }
  return undefined;
}

function indicator(
  id: MarketMacroIndicator["id"],
  label: string,
  point: FredPoint | undefined,
): MarketMacroIndicator | undefined {
  return point ? { id, label, value: point.value, unit: "percent", asOf: point.date, source: "fred" } : undefined;
}

export function createFredProvider(options: FredProviderOptions = {}): MarketProvider {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const limit = createLimiter(3);
  const start = () => {
    const date = new Date(now());
    date.setUTCMonth(date.getUTCMonth() - 15);
    return date.toISOString().slice(0, 10);
  };
  const series = (id: string, signal: AbortSignal): Promise<FredPoint[]> => limit(async () => {
    const csv = await fetchText(
      fetchImpl,
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${start()}`,
      { headers: { Accept: "text/csv" }, signal },
      `fred ${id}`,
    );
    const points = parseFredCsv(csv);
    if (points.length === 0) throw new Error(`fred ${id}: empty series`);
    return points;
  });

  return {
    id: "fred",
    async macro(signal) {
      const [twoYearResult, tenYearResult, fedFundsResult, cpiResult, unemploymentResult] = await Promise.allSettled([
        series("DGS2", signal),
        series("DGS10", signal),
        series("DFF", signal),
        series("CPIAUCSL", signal),
        series("UNRATE", signal),
      ]);
      const twoYear = twoYearResult.status === "fulfilled" ? twoYearResult.value : [];
      const tenYear = tenYearResult.status === "fulfilled" ? tenYearResult.value : [];
      const fedFunds = fedFundsResult.status === "fulfilled" ? fedFundsResult.value : [];
      const cpi = cpiResult.status === "fulfilled" ? cpiResult.value : [];
      const unemployment = unemploymentResult.status === "fulfilled" ? unemploymentResult.value : [];
      const indicators: MarketMacroIndicator[] = [];

      const values = [
        indicator("fed-funds", "Effective fed funds", latest(fedFunds)),
        indicator("treasury-2y", "U.S. Treasury 2Y", latest(twoYear)),
        indicator("treasury-10y", "U.S. Treasury 10Y", latest(tenYear)),
        indicator("unemployment", "U.S. unemployment", latest(unemployment)),
      ];
      for (const value of values) if (value) indicators.push(value);

      const commonYield = latestCommon(twoYear, tenYear);
      if (commonYield) {
        indicators.push({
          id: "yield-curve-10y2y",
          label: "10Y − 2Y spread",
          value: commonYield[1].value - commonYield[0].value,
          unit: "percentage-point",
          asOf: commonYield[0].date,
          source: "fred",
        });
      }

      const currentCpi = latest(cpi);
      const yearAgoCpi = cpi.length >= 13 ? cpi.at(-13) : undefined;
      if (currentCpi && yearAgoCpi && yearAgoCpi.value !== 0) {
        indicators.push({
          id: "cpi-yoy",
          label: "U.S. CPI YoY",
          value: ((currentCpi.value / yearAgoCpi.value) - 1) * 100,
          unit: "percent",
          asOf: currentCpi.date,
          source: "fred",
        });
      }

      if (indicators.length === 0) throw new Error("fred: no macro indicators available");
      return indicators;
    },
  };
}
