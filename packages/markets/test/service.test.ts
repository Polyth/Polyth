import assert from "node:assert/strict";
import test from "node:test";
import { MarketsService, normalizeSymbol } from "../src/service.ts";

test("market symbols are normalized and validated", () => {
  assert.equal(normalizeSymbol(" nvda "), "NVDA");
  assert.equal(normalizeSymbol("btc/usd"), "BTC/USD");
  assert.throws(() => normalizeSymbol("../../etc/passwd"), /invalid market symbol/);
});

test("markets service caches normalized quote requests", async () => {
  let calls = 0;
  const service = new MarketsService({ now: () => 0 });
  service.registerProvider({
    id: "fixture",
    quote: async (symbol) => {
      calls += 1;
      return {
        symbol,
        currency: "USD",
        price: 181.42,
        asOf: "2026-09-09T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
  });

  const first = await service.quote("nvda");
  const second = await service.quote(" NVDA ");
  assert.equal(first.data.symbol, "NVDA");
  assert.equal(second.cache, "fresh");
  assert.equal(calls, 1);
});

test("market comparison normalizes symbols and skips news work", async () => {
  let newsCalls = 0;
  const service = new MarketsService({ now: () => Date.UTC(2026, 8, 10) });
  service.registerProvider({
    id: "fixture",
    async quote(symbol) {
      return {
        symbol,
        currency: "USD",
        price: symbol === "AAPL" ? 230 : 510,
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async fundamentals(symbol) {
      return {
        symbol,
        pe: symbol === "AAPL" ? 31 : 36,
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async candles(symbol, range) {
      return {
        symbol,
        range,
        candles: [
          { time: 1, open: 100, high: 101, low: 99, close: 100 },
          { time: 2, open: 124, high: 126, low: 123, close: 125 },
        ],
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async news() {
      newsCalls += 1;
      return [];
    },
  });

  const comparison = await service.compare([" aapl ", "msft", "AAPL"], "1M");
  assert.deepEqual(comparison.items.map((item) => item.symbol), ["AAPL", "MSFT"]);
  assert.equal(comparison.items[0]?.performance?.changePercent, 25);
  assert.equal(comparison.range, "1M");
  assert.equal(newsCalls, 0);
});
