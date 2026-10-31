import assert from "node:assert/strict";
import test from "node:test";
import { createNasdaqProvider } from "../src/providers/nasdaq.ts";
import type { FetchLike } from "../src/providers/http.ts";

test("Nasdaq earnings adapter parses earnings surprise rows", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.match(url, /\/api\/company\/AAPL\/earnings-surprise$/);
    return new Response(JSON.stringify({
      data: {
        earningsSurpriseTable: {
          rows: [
            {
              fiscalQtrEnd: "Jun-26",
              dateReported: "7/30/2026",
              eps: "$1.57",
              consensusForecast: "$1.43",
              percentageSurprise: "9.79%",
            },
            {
              fiscalQtrEnd: "Mar-26",
              dateReported: "4/30/2026",
              eps: 1.65,
              consensusForecast: "1.62",
              percentageSurprise: "1.85",
            },
          ],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchLike;

  const provider = createNasdaqProvider({ fetch: fetchImpl, now: () => Date.UTC(2026, 8, 10) });
  const earnings = await provider.earnings!("AAPL", AbortSignal.timeout(1_000));

  assert.deepEqual(earnings, [
    {
      symbol: "AAPL",
      fiscalQuarterEnd: "Jun-26",
      reportedAt: "7/30/2026",
      actualEps: 1.57,
      consensusEps: 1.43,
      surprisePercent: 9.79,
      source: "nasdaq",
    },
    {
      symbol: "AAPL",
      fiscalQuarterEnd: "Mar-26",
      reportedAt: "4/30/2026",
      actualEps: 1.65,
      consensusEps: 1.62,
      surprisePercent: 1.85,
      source: "nasdaq",
    },
  ]);
});
