import assert from "node:assert/strict";
import test from "node:test";
import { MarketsService } from "../src/service.ts";

test("macro snapshot preserves market quotes when the macro provider fails", async () => {
  const service = new MarketsService({ now: () => Date.UTC(2026, 8, 10) });
  service.registerProvider({
    id: "fixture",
    async quote(symbol) {
      return {
        symbol,
        assetType: "index",
        currency: "USD",
        price: symbol === "^VIX" ? 15 : 100,
        changePercent: 1,
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
    async macro() {
      throw new Error("macro feed unavailable");
    },
  });

  const snapshot = await service.macro();
  assert.deepEqual(snapshot.indicators, []);
  assert.deepEqual(snapshot.markets.map((quote) => quote.symbol), ["^GSPC", "^IXIC", "^VIX"]);
  assert.equal(snapshot.errors.length, 1);
  assert.match(snapshot.errors[0] ?? "", /macro feed unavailable/);
});
