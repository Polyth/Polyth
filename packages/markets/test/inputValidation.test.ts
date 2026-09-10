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
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-validation-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const space = { storageDir: root } as SpaceContext;
  const url = new URL(pathAndQuery, "http://localhost");
  let status = 0;
  let responseBody: unknown;
  const route = marketsRoutes({ spaceStorage: () => storage }, new MarketsService());
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

test("market routes reject malformed symbols before provider execution", async () => {
  for (const path of [
    "/api/markets/quote?symbols=../../etc/passwd",
    "/api/markets/fundamentals?symbol=bad%20symbol",
    "/api/markets/news?symbol=%25%25%25",
    "/api/markets/earnings?symbol=bad%20symbol",
    "/api/markets/filings?symbol=bad%20symbol",
  ]) {
    const response = await invoke(path);
    assert.equal(response.handled, true);
    assert.equal(response.status, 400, path);
    assert.equal((response.body as { error: string }).error, "invalid-input");
  }
});

test("market routes reject invalid ranges as client input", async () => {
  assert.equal((await invoke("/api/markets/candles?symbol=AAPL&range=NOPE")).status, 400);
  assert.equal((await invoke("/api/markets/context?symbol=AAPL&range=NOPE")).status, 400);
  assert.equal((await invoke("/api/markets/compare?symbols=AAPL,MSFT&range=NOPE")).status, 400);
});

test("compare requires two unique normalized symbols", async () => {
  const response = await invoke("/api/markets/compare?symbols=aapl,AAPL");
  assert.equal(response.status, 400);
  assert.match((response.body as { message: string }).message, /unique symbols/);
});
