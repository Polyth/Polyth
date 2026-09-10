import assert from "node:assert/strict";
import test from "node:test";
import { createBinanceProvider } from "../src/providers/binance.ts";
import { createFredProvider, parseFredCsv } from "../src/providers/fred.ts";
import type { FetchLike } from "../src/providers/http.ts";

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const fetchFrom = (handler: (url: string, init?: RequestInit) => Response): FetchLike =>
  (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as FetchLike;

const ticker = (symbol: string, lastPrice: string) => ({
  symbol,
  priceChange: "100",
  priceChangePercent: "2.5",
  prevClosePrice: "3900",
  openPrice: "4000",
  highPrice: "4200",
  lowPrice: "3800",
  lastPrice,
  volume: "123.4",
  closeTime: 1_788_912_000_000,
});

test("binance crypto board uses one batch request", async () => {
  let calls = 0;
  let requested = "";
  const provider = createBinanceProvider({
    fetch: fetchFrom((url) => {
      calls += 1;
      requested = url;
      return json([ticker("BTCUSDT", "110000"), ticker("ETHUSDT", "4500")]);
    }),
  });

  const board = await provider.crypto!(new AbortController().signal);
  assert.equal(calls, 1);
  assert.match(requested, /ticker\/24hr\?symbols=/);
  assert.deepEqual(board.map((item) => item.symbol), ["BTC/USDT", "ETH/USDT"]);
  assert.equal(board[0]?.currency, "USDT");
  assert.equal(board[0]?.assetType, "crypto");
});

test("binance quote and candles keep explicit USDT symbols", async () => {
  const provider = createBinanceProvider({
    now: () => 1_788_912_000_000,
    fetch: fetchFrom((url) => url.includes("/klines")
      ? json([[1_788_900_000_000, "100", "110", "90", "105", "12", 1_788_903_599_999, "0", 1, "0", "0", "0"]])
      : json(ticker("BTCUSDT", "110000"))),
  });

  const quote = await provider.quote!("BTC/USDT", new AbortController().signal);
  assert.equal(quote.symbol, "BTC/USDT");
  assert.equal(quote.exchange, "Binance");
  const candles = await provider.candles!("BTC/USDT", "1D", new AbortController().signal);
  assert.equal(candles.symbol, "BTC/USDT");
  assert.equal(candles.candles[0]?.close, 105);
});

test("binance ignores equity symbols before network", async () => {
  let calls = 0;
  const provider = createBinanceProvider({
    fetch: fetchFrom(() => {
      calls += 1;
      return json({});
    }),
  });
  await assert.rejects(
    provider.quote!("NVDA", new AbortController().signal),
    (cause: unknown) => (cause as { code?: string }).code === "not-found",
  );
  assert.equal(calls, 0);
});

test("FRED CSV parser drops missing observations", () => {
  assert.deepEqual(parseFredCsv("observation_date,DGS10\n2026-09-01,4.1\n2026-09-02,.\n2026-09-03,4.2\n"), [
    { date: "2026-09-01", value: 4.1 },
    { date: "2026-09-03", value: 4.2 },
  ]);
});

test("FRED macro derives CPI YoY and yield spread from bounded series", async () => {
  const cpi = Array.from({ length: 13 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 8 + index, 1)).toISOString().slice(0, 10);
    return `${date},${100 + index}`;
  }).join("\n");
  const calls: string[] = [];
  const provider = createFredProvider({
    now: () => Date.UTC(2026, 8, 10),
    fetch: fetchFrom((rawUrl) => {
      calls.push(rawUrl);
      const url = new URL(rawUrl);
      const id = url.searchParams.get("id");
      assert.equal(url.searchParams.get("cosd"), "2025-06-10");
      const body = id === "DGS2"
        ? "observation_date,DGS2\n2026-09-08,3.50\n2026-09-09,3.60\n"
        : id === "DGS10"
          ? "observation_date,DGS10\n2026-09-08,4.00\n2026-09-09,4.10\n"
          : id === "DFF"
            ? "observation_date,DFF\n2026-09-09,5.25\n"
            : id === "CPIAUCSL"
              ? `observation_date,CPIAUCSL\n${cpi}\n`
              : "observation_date,UNRATE\n2026-08-01,4.20\n";
      return new Response(body, { status: 200 });
    }),
  });

  const macro = await provider.macro!(new AbortController().signal);
  assert.equal(calls.length, 5);
  assert.equal(macro.find((item) => item.id === "treasury-10y")?.value, 4.1);
  assert.ok(Math.abs((macro.find((item) => item.id === "yield-curve-10y2y")?.value ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs((macro.find((item) => item.id === "cpi-yoy")?.value ?? 0) - 12) < 1e-9);
  assert.equal(macro.find((item) => item.id === "unemployment")?.value, 4.2);
});
