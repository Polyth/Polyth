import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { ServerPackage } from "@polyth/plugins";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketsService } from "../src/service.ts";

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(markets: MarketsService, pathAndQuery: string) {
  let status = 0;
  let responseBody: unknown;
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-filings-routes-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const space = { storageDir: root } as SpaceContext;
  const url = new URL(pathAndQuery, "http://localhost");
  const route = marketsRoutes({ spaceStorage: () => storage }, markets);
  const request = {
    path: url.pathname,
    method: "GET",
    url,
    space,
    json(nextStatus: number, nextBody: unknown) {
      status = nextStatus;
      responseBody = nextBody;
    },
  } as RouteRequest;
  return { handled: await route(request), status, body: responseBody };
}

test("filings route reports required SEC identity when provider is not configured", async () => {
  const response = await invoke(new MarketsService(), "/api/markets/filings?symbol=AAPL");
  assert.equal(response.handled, true);
  assert.equal(response.status, 503);
  assert.equal((response.body as { error: string }).error, "configuration-required");
});

test("filings route filters forms and limit after provider fetch", async () => {
  const markets = new MarketsService({ now: () => Date.UTC(2026, 8, 10) });
  markets.registerProvider({
    id: "fixture-sec",
    async filings(symbol) {
      return [
        {
          symbol,
          cik: "0000320193",
          form: "10-Q",
          filedAt: "2026-08-01",
          accessionNumber: "one",
          url: "https://example.com/10q",
          source: "fixture-sec",
        },
        {
          symbol,
          cik: "0000320193",
          form: "8-K",
          filedAt: "2026-07-01",
          accessionNumber: "two",
          url: "https://example.com/8k",
          source: "fixture-sec",
        },
      ];
    },
  });
  const response = await invoke(markets, "/api/markets/filings?symbol=AAPL&forms=8-k&limit=1");
  assert.equal(response.status, 200);
  const body = response.body as { data: Array<{ form: string }> };
  assert.deepEqual(body.data.map((item) => item.form), ["8-K"]);
});

test("filings route validates forms and limit", async () => {
  const markets = new MarketsService();
  assert.equal((await invoke(markets, "/api/markets/filings?symbol=AAPL&forms=bad%20form")).status, 400);
  assert.equal((await invoke(markets, "/api/markets/filings?symbol=AAPL&limit=0")).status, 400);
});
