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
