import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceContext, SpaceRole, SpaceStorage } from "@polyth/contracts";
import type { ServerPackage } from "@polyth/plugins";
import { marketsRoutes } from "../src/serverEntry.ts";
import { MarketsService } from "../src/service.ts";
import { fakePeople } from "./fakePeople.ts";

type RouteRequest = Parameters<NonNullable<ServerPackage["routes"]>>[0];

async function fixture(withPeople = true) {
  const root = await mkdtemp(join(tmpdir(), "polyth-markets-people-"));
  const storage: SpaceStorage = {
    root,
    packageDir: (packageId) => join(root, "packages", packageId),
    path: (relative) => join(root, relative),
  };
  const route = marketsRoutes(
    { spaceStorage: () => storage, ...(withPeople ? { people: fakePeople(root) } : {}) },
    new MarketsService(),
  );
  const call = async (
    userId: string,
    path: string,
    opts: { method?: "GET" | "PUT"; body?: unknown; spaceId?: string; role?: SpaceRole } = {},
  ) => {
    let status = 0;
    let responseBody: unknown;
    const url = new URL(path, "http://localhost");
    const request = {
      path: url.pathname,
      method: opts.method ?? "GET",
      url,
      space: { storageDir: root, spaceId: opts.spaceId ?? "space-a", userId, role: opts.role ?? "member" } as SpaceContext,
      body: async () => opts.body,
      json(nextStatus: number, nextBody: unknown) { status = nextStatus; responseBody = nextBody; },
    } as RouteRequest;
    await route(request);
    return { status, body: responseBody as Record<string, unknown> };
  };
  return { root, storage, call };
}

const holdings = (symbol: string) => ({ version: 1, holdings: [{ symbol, quantity: 1 }] });
const lists = (symbol: string) => ({
  version: 1,
  activeId: "mine",
  items: [{ id: "mine", name: "Mine", symbols: [symbol] }],
});

test("two people in a Space keep separate portfolios and watchlists", async () => {
  const { call } = await fixture();
  await call("alice", "/api/markets/portfolio", { method: "PUT", body: holdings("AAPL") });
  await call("alice", "/api/markets/watchlists", { method: "PUT", body: lists("NVDA") });
  const bobPortfolio = await call("bob", "/api/markets/portfolio");
  assert.deepEqual(bobPortfolio.body, { version: 1, holdings: [] });
  const bobLists = await call("bob", "/api/markets/watchlists");
  assert.equal((bobLists.body.items as Array<{ id: string }>)[0]!.id, "default");
  const alicePortfolio = await call("alice", "/api/markets/portfolio");
  assert.equal((alicePortfolio.body.holdings as Array<{ symbol: string }>)[0]!.symbol, "AAPL");
});

test("the same person has separate data in a foreign Space", async () => {
  const { call } = await fixture();
  await call("alice", "/api/markets/portfolio", { method: "PUT", body: holdings("AAPL") });
  const other = await call("alice", "/api/markets/portfolio", { spaceId: "space-b" });
  assert.deepEqual(other.body, { version: 1, holdings: [] });
});

test("legacy Space files move to the owner on first access; members start empty", async () => {
  const { root, storage, call } = await fixture();
  const dir = storage.packageDir("markets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "portfolio.json"), JSON.stringify(holdings("MSFT")));
  await writeFile(join(dir, "watchlists.json"), JSON.stringify(lists("TSLA")));

  const member = await call("bob", "/api/markets/portfolio", { role: "member" });
  assert.deepEqual(member.body, { version: 1, holdings: [] });
  const admin = await call("carol", "/api/markets/watchlists", { role: "admin" });
  assert.equal((admin.body.items as Array<{ id: string }>)[0]!.id, "default");
  assert.ok(existsSync(join(dir, "portfolio.json")), "stays until the owner arrives");

  const owner = await call("alice", "/api/markets/portfolio", { role: "owner" });
  assert.equal((owner.body.holdings as Array<{ symbol: string }>)[0]!.symbol, "MSFT");
  const ownerLists = await call("alice", "/api/markets/watchlists", { role: "owner" });
  assert.deepEqual((ownerLists.body.items as Array<{ symbols: string[] }>)[0]!.symbols, ["TSLA"]);
  assert.equal(existsSync(join(dir, "portfolio.json")), false);
  assert.equal(existsSync(join(dir, "watchlists.json")), false);
  // Members still see nothing of it.
  assert.deepEqual((await call("bob", "/api/markets/portfolio")).body, { version: 1, holdings: [] });
  assert.ok(existsSync(join(root, "people", "alice", "packages", "markets", "spaces", "space-a", "portfolio.json")));
});

test("an owner's existing file is not overwritten by legacy data", async () => {
  const { storage, call } = await fixture();
  await call("alice", "/api/markets/portfolio", { method: "PUT", body: holdings("AAPL"), role: "owner" });
  const dir = storage.packageDir("markets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "portfolio.json"), JSON.stringify(holdings("MSFT")));
  const read = await call("alice", "/api/markets/portfolio", { role: "owner" });
  assert.equal((read.body.holdings as Array<{ symbol: string }>)[0]!.symbol, "AAPL");
  assert.ok(existsSync(join(dir, "portfolio.json")));
});

test("system work is refused and a host without person storage fails closed", async () => {
  const { call } = await fixture();
  for (const path of ["/api/markets/portfolio", "/api/markets/watchlists", "/api/markets/portfolio/snapshot"]) {
    await assert.rejects(() => call("system:schedule", path), (cause: Error & { code?: string }) => cause.code === "forbidden");
  }
  const bare = await fixture(false);
  await assert.rejects(() => bare.call("alice", "/api/markets/portfolio"), (cause: Error & { code?: string }) => cause.code === "unavailable");
});
