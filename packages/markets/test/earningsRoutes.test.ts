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

async function invoke(pathAndQuery: string) {
  const markets = new MarketsService({ now: () => Date.UTC(2026, 8, 10) });
  markets.registerProvider({
    id: "fixture",
    async earnings(symbol) {
      return [{
        symbol,
        fiscalQuarterEnd: "Jun-26",
        reportedAt: "7/30/2026",
        actualEps: 1.57,
        consensusEps: 1.43,
        surprisePercent: 9.79,
        source: "fixture",
      }];
    },
  });
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-earnings-routes-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const space = { storageDir: root } as SpaceContext;
  const url = new URL(pathAndQuery, "http://localhost");
  let status = 0;
  let responseBody: unknown;
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

test("earnings route exposes normalized provider history", async () => {
  const response = await invoke("/api/markets/earnings?symbol=aapl");
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as { data: Array<{ symbol: string; surprisePercent?: number }> };
  assert.deepEqual(body.data, [{
    symbol: "AAPL",
    fiscalQuarterEnd: "Jun-26",
    reportedAt: "7/30/2026",
    actualEps: 1.57,
    consensusEps: 1.43,
    surprisePercent: 9.79,
    source: "fixture",
  }]);
});

test("earnings route requires a symbol", async () => {
  assert.equal((await invoke("/api/markets/earnings")).status, 400);
});
