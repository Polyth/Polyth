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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-portfolio-routes-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const markets = new MarketsService({ now: () => Date.UTC(2026, 8, 10) });
  markets.registerProvider({
    id: "fixture",
    async quote(symbol) {
      return {
        symbol,
        currency: "USD",
        price: 125,
        change: 2,
        asOf: "2026-09-10T00:00:00.000Z",
        source: "fixture",
        freshness: "delayed",
      };
    },
  });
  const route = marketsRoutes({ spaceStorage: () => storage }, markets);
  const space = { storageDir: root } as SpaceContext;

  const invoke = async (path: string, method: "GET" | "PUT" = "GET", requestBody?: unknown) => {
    let status = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    const request = {
      path: url.pathname,
      method,
      url,
      space,
      body: async () => requestBody,
      json(nextStatus: number, nextBody: unknown) {
        status = nextStatus;
        responseBody = nextBody;
      },
    } as RouteRequest;
    return { handled: await route(request), status, body: responseBody };
  };

  return { invoke };
}

test("portfolio routes persist normalized holdings and expose valuation snapshot", async () => {
  const { invoke } = await fixture();
  const empty = await invoke("/api/markets/portfolio");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { version: 1, holdings: [] });

  const saved = await invoke("/api/markets/portfolio", "PUT", {
    version: 1,
    holdings: [{ symbol: " aapl ", quantity: 2, averageCost: 100 }],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, {
    version: 1,
    holdings: [{ symbol: "AAPL", quantity: 2, averageCost: 100 }],
  });

  const snapshot = await invoke("/api/markets/portfolio/snapshot");
  assert.equal(snapshot.status, 200);
  const body = snapshot.body as {
    positions: Array<{ marketValue?: number; unrealizedGain?: number; dailyChange?: number }>;
    currencies: Array<{ currency: string; marketValue: number }>;
  };
  assert.equal(body.positions[0]?.marketValue, 250);
  assert.equal(body.positions[0]?.unrealizedGain, 50);
  assert.equal(body.positions[0]?.dailyChange, 4);
  assert.deepEqual(body.currencies, [{ currency: "USD", marketValue: 250, costBasis: 200, unrealizedGain: 50, dailyChange: 4 }]);
});

test("portfolio PUT rejects invalid holdings", async () => {
  const { invoke } = await fixture();
  const response = await invoke("/api/markets/portfolio", "PUT", {
    version: 1,
    holdings: [{ symbol: "AAPL", quantity: 0 }],
  });
  assert.equal(response.handled, true);
  assert.equal(response.status, 400);
  assert.match((response.body as { message: string }).message, /positive number/);
});
