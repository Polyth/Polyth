import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import {
  alertLedgerAnnouncements,
  emptyAlertLedger,
  LEDGER_RETENTION_MS,
  mergeAlertLedgers,
  type UsageAlertLedger,
} from "../src/alertLedger.ts";
import { createUsageAnalyticsService } from "../src/index.ts";
import { usageRoutes } from "../src/serverEntry.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 23, 12);

const ledger = (windows: UsageAlertLedger["windows"], sources: Record<string, string> = {}, at = NOW): UsageAlertLedger =>
  ({ version: 1, windows, sources, at });

test("a merge keeps what either copy announced in the same period", () => {
  const phone = ledger({ "claude/5h": { remaining: .08, low: 10, resetsAt: NOW + 2 * HOUR, at: NOW } });
  const desktop = ledger({ "claude/5h": { remaining: .07, pace: 2, resetsAt: NOW + 2 * HOUR + 60_000, at: NOW + 60_000 } });
  const merged = mergeAlertLedgers(phone, desktop);
  assert.deepEqual(merged.windows["claude/5h"], { remaining: .07, resetsAt: NOW + 2 * HOUR + 60_000, at: NOW + 60_000, low: 10, pace: 2 });
  assert.deepEqual(mergeAlertLedgers(desktop, phone).windows, merged.windows, "the order of the copies does not matter");
});

test("a later period replaces the earlier one, whichever device clock is ahead", () => {
  const exhausted = ledger({ "claude/7d": { remaining: 0, exhausted: true, low: 5, resetsAt: NOW + HOUR, at: NOW + 5 * HOUR } });
  const fresh = ledger({ "claude/7d": { remaining: .9, resetsAt: NOW + 7 * 24 * HOUR, at: NOW + 2 * HOUR } });
  assert.deepEqual(mergeAlertLedgers(exhausted, fresh).windows["claude/7d"], fresh.windows["claude/7d"]);

  // Without reset times a refill marks the newer period.
  const low = ledger({ "x/w": { remaining: .05, low: 10, at: NOW } });
  const refilled = ledger({ "x/w": { remaining: 1, at: NOW + HOUR } });
  assert.deepEqual(mergeAlertLedgers(low, refilled).windows["x/w"], refilled.windows["x/w"]);
});

test("source problems come from the newer copy and old memos are forgotten", () => {
  const announced = ledger({}, { claude: "sign-in" }, NOW);
  const recovered = ledger({}, {}, NOW + HOUR);
  assert.deepEqual(mergeAlertLedgers(announced, recovered).sources, {}, "a recovered source is not kept as announced");
  assert.deepEqual(mergeAlertLedgers(recovered, ledger({}, { claude: "key" }, NOW + 2 * HOUR)).sources, { claude: "key" });

  const stale = ledger({ "gone/5h": { remaining: .1, low: 10, at: NOW - LEDGER_RETENTION_MS } });
  assert.deepEqual(mergeAlertLedgers(stale, emptyAlertLedger(), NOW).windows, {});
});

test("only announcements count as a change worth writing", () => {
  const base = ledger({ "claude/5h": { remaining: .5, resetsAt: NOW + HOUR, at: NOW }, "claude/7d": { remaining: .2, low: 25, resetsAt: NOW + 50 * HOUR, at: NOW } });
  const moved = ledger({ "claude/5h": { remaining: .4, resetsAt: NOW + HOUR + 1_000, at: NOW + 120_000 }, "claude/7d": { remaining: .19, low: 25, resetsAt: NOW + 50 * HOUR + 1_000, at: NOW + 120_000 } });
  assert.equal(alertLedgerAnnouncements(moved), alertLedgerAnnouncements(base));
  const lower = ledger({ ...moved.windows, "claude/7d": { ...moved.windows["claude/7d"]!, low: 10 } });
  assert.notEqual(alertLedgerAnnouncements(lower), alertLedgerAnnouncements(base));
});

// ---- the route ----

const spaceFor = (userId: string, spaceId = "space-a"): SpaceContext => ({
  spaceId, spaceSlug: spaceId, userId, role: "member", deployment: "local-trusted", storageDir: `/tmp/${spaceId}`,
});

const call = async (route: ReturnType<typeof usageRoutes>, space: SpaceContext, method: string, input?: unknown) => {
  let response: { status: number; body: Record<string, unknown> } | null = null;
  const handled = await route({
    path: "/api/usage/alerts/ledger",
    method,
    url: new URL("http://polyth.test/api/usage/alerts/ledger"),
    body: async () => input as Record<string, unknown>,
    json: (status: number, body: unknown) => { response = { status, body: body as Record<string, unknown> }; },
    space,
  } as never);
  assert.equal(handled, true);
  return response!;
};

test("the route keeps each person's ledger in their Space and merges writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "usage-alert-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const analytics = createUsageAnalyticsService({
    source: { projections: async () => [], events: async () => [] },
    serverInstanceId: "server-1",
  });
  const route = usageRoutes(analytics, {
    spaceStorage: (space: SpaceContext) => ({ packageDir: () => join(root, space.spaceId) }),
  } as never);
  const ana = spaceFor("ana");

  const empty = await call(route, ana, "GET");
  assert.deepEqual(empty, { status: 200, body: { serverInstanceId: "server-1", spaceId: "space-a", host: null, space: null } });

  const phone = ledger({ "claude/5h": { remaining: 0, exhausted: true, low: 5, pace: 2, resetsAt: NOW + HOUR, at: NOW } });
  assert.equal((await call(route, ana, "PUT", { host: phone })).status, 200);
  const desktop = ledger({ "codex/7d": { remaining: .1, low: 10, resetsAt: NOW + 90 * HOUR, at: NOW + 1_000 } }, {}, NOW + 1_000);
  const merged = await call(route, ana, "PUT", { host: desktop });
  const host = merged.body.host as UsageAlertLedger;
  assert.equal(host.windows["claude/5h"]?.exhausted, true, "a second device's write keeps the first one's announcement");
  assert.equal(host.windows["codex/7d"]?.low, 10);

  // Another person, and the same person in another Space, start from nothing.
  assert.equal((await call(route, spaceFor("ben"), "GET")).body.host, null);
  assert.equal((await call(route, spaceFor("ana", "space-b"), "GET")).body.host, null);

  // A per-Space ledger is kept only when it names this server and Space.
  const estimate = ledger({ "alibaba-coding-plan/5h": { remaining: .08, low: 10, at: NOW } });
  await call(route, ana, "PUT", { space: estimate, serverInstanceId: "server-1", spaceId: "space-b" });
  assert.equal((await call(route, ana, "GET")).body.space, null);
  await call(route, ana, "PUT", { space: estimate, serverInstanceId: "server-1", spaceId: "space-a" });
  assert.equal(((await call(route, ana, "GET")).body.space as UsageAlertLedger).windows["alibaba-coding-plan/5h"]?.low, 10);

  assert.equal((await call(route, ana, "PUT", ["nope"])).status, 400);
});
