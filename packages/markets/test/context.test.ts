import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketHandoffText } from "../widgets/context.ts";

test("market handoff context stays compact and labels time-sensitive evidence", () => {
  const text = buildMarketHandoffText({
    symbol: "NVDA",
    range: "1M",
    quote: {
      symbol: "NVDA",
      currency: "USD",
      price: 181.42,
      change: 5.64,
      changePercent: 3.21,
      previousClose: 175.78,
      asOf: "2026-09-09T20:00:00.000Z",
      source: "nasdaq",
      freshness: "delayed",
    },
    fundamentals: {
      symbol: "NVDA",
      marketCap: 4.4e12,
      pe: 54.2,
      eps: 3.34,
      sector: "Technology",
      asOf: "2026-09-09T20:00:00.000Z",
      source: "tradingview",
      freshness: "delayed",
    },
    candles: {
      symbol: "NVDA",
      range: "1M",
      candles: [
        { time: 1, open: 160, high: 162, low: 159, close: 160 },
        { time: 2, open: 180, high: 182, low: 179, close: 180 },
      ],
      asOf: "2026-09-09T20:00:00.000Z",
      source: "yahoo",
      freshness: "delayed",
    },
  });
  assert.match(text, /Market research context — NVDA/);
  assert.match(text, /Today: \+3\.21%/);
  assert.match(text, /1M return from available candles: \+12\.50%/);
  assert.match(text, /Data sources: nasdaq, tradingview, yahoo/);
  assert.match(text, /Use current web research/);
  assert.doesNotMatch(text, /160,162,159/);
});
