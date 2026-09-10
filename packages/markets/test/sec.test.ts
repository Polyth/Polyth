import assert from "node:assert/strict";
import test from "node:test";
import { createSecProvider } from "../src/providers/sec.ts";
import type { FetchLike } from "../src/providers/http.ts";

test("SEC provider maps ticker to CIK, parses recent filings, and declares its User-Agent", async () => {
  const requests: Array<{ url: string; userAgent: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      userAgent: new Headers(init?.headers).get("user-agent"),
    });
    if (url.endsWith("/files/company_tickers.json")) {
      return new Response(JSON.stringify({
        "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/submissions/CIK0000320193.json")) {
      return new Response(JSON.stringify({
        name: "Apple Inc.",
        filings: {
          recent: {
            accessionNumber: ["0000320193-26-000001", "0000320193-26-000002"],
            filingDate: ["2026-08-01", "2026-07-01"],
            reportDate: ["2026-06-30", "2026-06-30"],
            form: ["10-Q", "8-K"],
            primaryDocument: ["aapl-20260630.htm", "aapl-8k.htm"],
            primaryDocDescription: ["Quarterly report", "Current report"],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike;

  const provider = createSecProvider({
    fetch: fetchImpl,
    userAgent: "Polyth Markets test@example.com",
    now: () => Date.UTC(2026, 8, 10),
  });
  const filings = await provider.filings!("AAPL", AbortSignal.timeout(1_000));

  assert.equal(filings.length, 2);
  assert.deepEqual(filings[0], {
    symbol: "AAPL",
    cik: "0000320193",
    companyName: "Apple Inc.",
    form: "10-Q",
    filedAt: "2026-08-01",
    reportDate: "2026-06-30",
    accessionNumber: "0000320193-26-000001",
    primaryDocument: "aapl-20260630.htm",
    description: "Quarterly report",
    url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260630.htm",
    source: "sec",
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.userAgent === "Polyth Markets test@example.com"));
});

test("SEC provider caches the ticker map", async () => {
  let tickerCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("company_tickers")) {
      tickerCalls += 1;
      return new Response(JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL" } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      filings: {
        recent: {
          accessionNumber: ["0000320193-26-000001"],
          filingDate: ["2026-08-01"],
          reportDate: [""],
          form: ["10-Q"],
          primaryDocument: ["aapl.htm"],
          primaryDocDescription: [""],
        },
      },
    }), { status: 200 });
  }) as FetchLike;
  const provider = createSecProvider({ fetch: fetchImpl, userAgent: "Polyth test@example.com", now: () => 1_000 });
  await provider.filings!("AAPL", AbortSignal.timeout(1_000));
  await provider.filings!("AAPL", AbortSignal.timeout(1_000));
  assert.equal(tickerCalls, 1);
});
