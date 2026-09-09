import assert from "node:assert/strict";
import test from "node:test";
import { registerDefaultMarketProviders } from "../src/defaultProviders.ts";
import { createNasdaqProvider } from "../src/providers/nasdaq.ts";
import { createStooqProvider } from "../src/providers/stooq.ts";
import { createTradingViewProvider } from "../src/providers/tradingview.ts";
import { createYahooProvider } from "../src/providers/yahoo.ts";
import { MarketsService } from "../src/service.ts";
import type { FetchLike } from "../src/providers/http.ts";

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const fetchFrom = (handler: (url: string, init?: RequestInit) => Response): FetchLike =>
  (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as FetchLike;

test("default providers preserve fallback priority by capability", () => {
  const service = new MarketsService();
  registerDefaultMarketProviders(service, { fetch: fetchFrom(() => json({})) });
  assert.deepEqual(service.providers.providerIds("quote"), ["nasdaq", "yahoo", "stooq"]);
  assert.deepEqual(service.providers.providerIds("candles"), ["nasdaq", "yahoo", "stooq"]);
  assert.deepEqual(service.providers.providerIds("search"), ["tradingview", "yahoo"]);
  assert.deepEqual(service.providers.providerIds("fundamentals"), ["tradingview"]);
});

test("nasdaq adapter normalizes quote data", async () => {
  const provider = createNasdaqProvider({
    now: () => Date.UTC(2026, 8, 9),
    fetch: fetchFrom((url) => url.includes("/summary")
      ? json({ data: { summaryData: { MarketCap: { value: "$4,400,000" } } } })
      : json({ data: {
        companyName: "NVIDIA Corporation",
        exchange: "NASDAQ-GS",
        primaryData: {
          lastSalePrice: "$181.42",
          netChange: "+5.64",
          percentageChange: "+3.21%",
          previousClose: "$175.78",
          volume: "1000000",
        },
        keyStats: { dayrange: { value: "$178.00 - $182.00" } },
      } })),
  });
  const quote = await provider.quote!("NVDA", new AbortController().signal);
  assert.equal(quote.price, 181.42);
  assert.equal(quote.changePercent, 3.21);
  assert.equal(quote.marketCap, 4_400_000);
  assert.equal(quote.source, "nasdaq");
});

test("yahoo adapter uses chart metadata without crumb state", async () => {
  const provider = createYahooProvider({
    fetch: fetchFrom(() => json({ chart: { result: [{ meta: {
      symbol: "AAPL",
      currency: "USD",
      regularMarketPrice: 230,
      chartPreviousClose: 225,
      regularMarketTime: 1_788_912_000,
    } }] } })),
  });
  const quote = await provider.quote!("AAPL", new AbortController().signal);
  assert.equal(quote.price, 230);
  assert.equal(quote.change, 5);
  assert.ok(Math.abs((quote.changePercent ?? 0) - 2.222222) < 0.00001);
});

test("stooq adapter parses quote CSV", async () => {
  const provider = createStooqProvider({
    now: () => Date.UTC(2026, 8, 9),
    fetch: fetchFrom(() => new Response(
      "Symbol,Date,Time,Open,High,Low,Close,Volume\nNVDA.US,2026-09-09,20:00,178,182,177,181.42,1000000\n",
      { status: 200 },
    )),
  });
  const quote = await provider.quote!("NVDA", new AbortController().signal);
  assert.equal(quote.price, 181.42);
  assert.equal(quote.high, 182);
  assert.equal(quote.freshness, "indicative");
});

test("tradingview adapter normalizes search and fundamentals", async () => {
  const provider = createTradingViewProvider({
    now: () => Date.UTC(2026, 8, 9),
    fetch: fetchFrom((url, init) => {
      if (init?.method === "POST") {
        return json({ data: [{ s: "NASDAQ:NVDA", d: [4.4e12, 54.2, 3.34, 0.03, 1.7, 24e9, "Technology", "Semiconductors"] }] });
      }
      assert.match(url, /symbol_search/);
      return json({ symbols: [{ symbol: "NVDA", description: "NVIDIA Corporation", exchange: "NASDAQ", type: "stock" }] });
    }),
  });
  const search = await provider.search!("nvidia", new AbortController().signal);
  assert.equal(search[0]?.symbol, "NVDA");
  assert.equal(search[0]?.assetType, "equity");
  const fundamentals = await provider.fundamentals!("NVDA", new AbortController().signal);
  assert.equal(fundamentals.pe, 54.2);
  assert.equal(fundamentals.dividendYield, 0.0003);
  assert.equal(fundamentals.exchange, "NASDAQ");
});
