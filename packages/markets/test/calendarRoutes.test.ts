import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import type { ServerPackage } from "@polyth/plugins";
import { MarketCalendarService } from "../src/calendar.ts";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketsService } from "../src/service.ts";

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function invoke(pathAndQuery: string, calendar: MarketCalendarService) {
  let status = 0;
  let responseBody: unknown;
  const url = new URL(pathAndQuery, "http://localhost");
  const route = marketsRoutes({
    spaceStorage: () => {
      throw new Error("calendar routes should not use space storage");
    },
  }, new MarketsService(), undefined, calendar);
  const request = {
    path: url.pathname,
    method: "GET",
    url,
    space: {} as SpaceContext,
    json(nextStatus: number, nextBody: unknown) {
      status = nextStatus;
      responseBody = nextBody;
    },
  } as RouteRequest;
  return { handled: await route(request), status, body: responseBody };
}

test("economic calendar route returns cached market data result", async () => {
  const calendar = new MarketCalendarService(
    async () => [{
      title: "CPI y/y",
      currency: "USD",
      date: "2026-09-10T12:30:00.000Z",
      impact: "High",
      forecast: "2.7%",
      previous: "2.8%",
      source: "fixture",
    }],
    async () => [],
    () => 1_000,
  );
  const response = await invoke("/api/markets/calendar/economic", calendar);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const body = response.body as { data: Array<{ title: string }>; cache: string };
  assert.equal(body.data[0]?.title, "CPI y/y");
  assert.equal(body.cache, "refreshed");
});

test("earnings calendar route batches normalized symbols", async () => {
  let requested: readonly string[] = [];
  const calendar = new MarketCalendarService(
    async () => [],
    async (symbols) => {
      requested = symbols;
      return symbols.map((symbol) => ({ symbol, source: "fixture" }));
    },
    () => 1_000,
  );
  const response = await invoke("/api/markets/calendar/earnings?symbols=NVDA,msft,NVDA", calendar);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, ["MSFT", "NVDA"]);
  const body = response.body as { data: Array<{ symbol: string }> };
  assert.deepEqual(body.data.map((item) => item.symbol), ["MSFT", "NVDA"]);
});

test("invalid earnings calendar symbols return 400 before loader execution", async () => {
  let loads = 0;
  const calendar = new MarketCalendarService(
    async () => [],
    async () => {
      loads += 1;
      return [];
    },
    () => 1_000,
  );
  const missing = await invoke("/api/markets/calendar/earnings", calendar);
  assert.equal(missing.status, 400);
  const invalid = await invoke("/api/markets/calendar/earnings?symbols=BMW.DE", calendar);
  assert.equal(invalid.status, 400);
  assert.equal(loads, 0);
});
