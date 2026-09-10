import assert from "node:assert/strict";
import test from "node:test";
import { MarketCalendarService, normalizeCalendarSymbols } from "../src/calendar.ts";
import { createForexFactoryEconomicCalendarLoader } from "../src/providers/economicCalendar.ts";
import { createTradingViewEarningsCalendarLoader } from "../src/providers/tradingviewCalendar.ts";
import type { FetchLike } from "../src/providers/http.ts";

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const fetchFrom = (handler: (url: string, init?: RequestInit) => Response): FetchLike =>
  (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as FetchLike;

test("earnings calendar normalizes symbol sets into one stable cache key", async () => {
  let calls = 0;
  let requested: readonly string[] = [];
  const service = new MarketCalendarService(
    async () => [],
    async (symbols) => {
      calls += 1;
      requested = symbols;
      return symbols.map((symbol) => ({ symbol, source: "fixture" }));
    },
    () => 1_000,
  );

  await service.earnings(["nvda", "MSFT"]);
  await service.earnings(["MSFT", "NVDA", "NVDA"]);
  assert.equal(calls, 1);
  assert.deepEqual(requested, ["MSFT", "NVDA"]);
});

test("calendar symbol validation is bounded and tolerates mixed watchlists", () => {
  assert.deepEqual(normalizeCalendarSymbols([" nvda ", "MSFT", "NVDA"]), ["MSFT", "NVDA"]);
  assert.deepEqual(normalizeCalendarSymbols(["NVDA", "BMW.DE", "BTC/USDT", "^GSPC"]), ["NVDA"]);
  assert.throws(() => normalizeCalendarSymbols([]), /1-100 symbols/);
  assert.throws(() => normalizeCalendarSymbols(["BMW.DE", "BTC\/USDT"]), /no supported US symbols/);
});

test("TradingView earnings calendar uses one batch request and preserves missing symbols", async () => {
  let calls = 0;
  let body = "";
  const loader = createTradingViewEarningsCalendarLoader({
    fetch: fetchFrom((_url, init) => {
      calls += 1;
      body = String(init?.body ?? "");
      return json({ data: [
        { s: "NASDAQ:NVDA", d: [1_800_000_000, 1_790_000_000, 1.25] },
      ] });
    }),
  });

  const rows = await loader(["MSFT", "NVDA"]);
  assert.equal(calls, 1);
  assert.match(body, /NASDAQ:MSFT/);
  assert.match(body, /NYSE:MSFT/);
  assert.match(body, /AMEX:NVDA/);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { symbol: "MSFT", source: "tradingview" });
  assert.equal(rows[1]?.symbol, "NVDA");
  assert.equal(rows[1]?.nextEarningsAt, new Date(1_800_000_000_000).toISOString());
  assert.equal(rows[1]?.epsForecast, 1.25);
});

test("Forex Factory loader validates, bounds, and sorts weekly events", async () => {
  const longTitle = "x".repeat(200);
  const loader = createForexFactoryEconomicCalendarLoader({
    fetch: fetchFrom(() => json([
      { title: "CPI y/y", country: "usd", date: "2026-09-11T12:30:00-04:00", impact: "High", forecast: "2.7%", previous: "2.8%" },
      { title: longTitle, country: "EUR", date: "2026-09-10T08:00:00Z", impact: "Unexpected", forecast: "", previous: "1.0%", actual: "1.1%" },
      { title: "bad", country: "USD", date: "not-a-date", impact: "High" },
    ])),
  });

  const events = await loader();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.currency, "EUR");
  assert.equal(events[0]?.impact, "Low");
  assert.equal(events[0]?.title.length, 160);
  assert.equal(events[0]?.actual, "1.1%");
  assert.equal(events[1]?.title, "CPI y/y");
  assert.equal(events[1]?.impact, "High");
});

test("economic calendar shares one long-lived cache entry", async () => {
  let calls = 0;
  const service = new MarketCalendarService(
    async () => {
      calls += 1;
      return [{ title: "CPI", currency: "USD", date: "2026-09-10T12:00:00.000Z", impact: "High", source: "fixture" }];
    },
    async () => [],
    () => 5_000,
  );

  await service.economic();
  await service.economic();
  assert.equal(calls, 1);
});
