import assert from "node:assert/strict";
import test from "node:test";
import { createSecProvider } from "../src/providers/sec.ts";
import type { FetchLike } from "../src/providers/http.ts";

test("aborting one filing request does not poison the shared SEC ticker map load", async () => {
  let tickerCalls = 0;
  let releaseTicker!: () => void;
  const tickerGate = new Promise<void>((resolve) => {
    releaseTicker = resolve;
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("company_tickers")) {
      tickerCalls += 1;
      await tickerGate;
      return new Response(JSON.stringify({
        "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
      }), { status: 200 });
    }
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(JSON.stringify({
      name: "Apple Inc.",
      filings: {
        recent: {
          accessionNumber: ["0000320193-26-000001"],
          filingDate: ["2026-08-01"],
          reportDate: ["2026-06-30"],
          form: ["10-Q"],
          primaryDocument: ["aapl.htm"],
          primaryDocDescription: ["Quarterly report"],
        },
      },
    }), { status: 200 });
  }) as FetchLike;

  const provider = createSecProvider({
    fetch: fetchImpl,
    userAgent: "Polyth Markets test@example.com",
    now: () => Date.UTC(2026, 8, 10),
  });
  const firstController = new AbortController();
  const first = provider.filings!("AAPL", firstController.signal);
  const second = provider.filings!("AAPL", AbortSignal.timeout(1_000));
  firstController.abort();
  releaseTicker();

  await assert.rejects(first, (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError");
  const secondResult = await second;
  assert.equal(secondResult[0]?.form, "10-Q");
  assert.equal(tickerCalls, 1);
});
