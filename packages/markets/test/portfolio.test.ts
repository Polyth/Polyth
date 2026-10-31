import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceStorage } from "@polyth/contracts";
import {
  DEFAULT_PORTFOLIO,
  loadPortfolio,
  parsePortfolio,
  savePortfolio,
  snapshotPortfolio,
} from "../src/portfolio.ts";
import type { MarketsService } from "../src/service.ts";

const storage = async (): Promise<SpaceStorage> => {
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-portfolio-"));
  return {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
};

test("portfolio parser normalizes holdings and rejects unsafe values", () => {
  assert.deepEqual(parsePortfolio({
    version: 1,
    holdings: [{ symbol: " aapl ", quantity: 2, averageCost: 100 }],
  }), {
    version: 1,
    holdings: [{ symbol: "AAPL", quantity: 2, averageCost: 100 }],
  });
  assert.throws(() => parsePortfolio({ version: 1, holdings: [{ symbol: "AAPL", quantity: 0 }] }), /positive number/);
  assert.throws(() => parsePortfolio({
    version: 1,
    holdings: [{ symbol: "AAPL", quantity: 1 }, { symbol: "aapl", quantity: 2 }],
  }), /duplicate holding/);
});

test("portfolio storage defaults empty and round-trips per space", async () => {
  const target = await storage();
  assert.deepEqual(await loadPortfolio(target), DEFAULT_PORTFOLIO);
  const saved = await savePortfolio(target, {
    version: 1,
    holdings: [{ symbol: "NVDA", quantity: 3.5, averageCost: 120 }],
  });
  assert.deepEqual(await loadPortfolio(target), saved);
});

test("portfolio snapshot groups currencies without inventing cross-currency totals", async () => {
  const markets: Pick<MarketsService, "quote"> = {
    async quote(symbol) {
      if (symbol === "BAD") throw new Error("missing quote");
      const eur = symbol === "SAP";
      return {
        data: {
          symbol,
          currency: eur ? "EUR" : "USD",
          price: eur ? 150 : symbol === "AAPL" ? 125 : 250,
          change: eur ? 2 : 1,
          asOf: "2026-09-10T00:00:00.000Z",
          source: "fixture",
          freshness: "delayed",
        },
        cache: "refreshed",
        cachedAt: "2026-09-10T00:00:00.000Z",
        revalidating: false,
      };
    },
  };

  const result = await snapshotPortfolio(markets, {
    version: 1,
    holdings: [
      { symbol: "AAPL", quantity: 2, averageCost: 100 },
      { symbol: "MSFT", quantity: 1 },
      { symbol: "SAP", quantity: 2, averageCost: 120 },
      { symbol: "BAD", quantity: 1 },
    ],
  }, () => Date.UTC(2026, 8, 10));

  assert.equal(result.positions.length, 4);
  assert.deepEqual(result.errors, [{ symbol: "BAD", message: "missing quote" }]);
  assert.deepEqual(result.currencies.map((item) => item.currency), ["EUR", "USD"]);
  const eur = result.currencies[0]!;
  assert.equal(eur.marketValue, 300);
  assert.equal(eur.costBasis, 240);
  assert.equal(eur.unrealizedGain, 60);
  const usd = result.currencies[1]!;
  assert.equal(usd.marketValue, 500);
  assert.equal(usd.costBasis, undefined);
  assert.equal(usd.dailyChange, 3);
});
