import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  peekCachedUsageStats,
  canonicalUsageQuery,
  createUsageStatsRequestGate,
  ensureUsageIdentity,
  requestUsageStats,
  usageErrorMessage,
  usageQueryCacheKey,
} from "../widgets/usage/usageStatsClient.ts";
import type { UsageStatsRequestState } from "../widgets/usage/usageStatsClient.ts";
import type { UsageStatsQuery, UsageStatsReport } from "../src/analytics/contracts.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  sessionStorage: dom.sessionStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const query: UsageStatsQuery = { range: "7d", timezone: "UTC", projectIds: ["b", "a"] };
const report = (serverInstanceId: string, value: number, requested: UsageStatsQuery = query): UsageStatsReport => ({
  schemaVersion: 1,
  serverInstanceId,
  spaceId: "space-a",
  query: requested,
  effective: { range: "7d", from: 0, to: 1, timezone: "UTC" },
  generatedAt: value,
  totals: {
    observations: 1,
    sessions: 1,
    turns: 1,
    turnsComplete: true,
    subagents: 0,
    tokens: { input: value, output: 0, reasoning: null, cacheRead: null, cacheWrite: null, total: value, totalComplete: false },
    cacheHitPercent: null,
    cost: null,
    costComplete: false,
    averageCostPerSession: null,
    averageCostPerThousand: null,
    activeDays: 1,
    longestActivityStreak: 1,
    steps: null,
    retries: null,
    timing: null,
    rates: null,
    quality: { exact: 1, derived: 0, estimated: 0 },
    status: { completed: 1, failed: 0, cancelled: 0, unknown: 0 },
  },
  trends: { tokens: null, cost: null, sessions: null, turns: null },
  chart: { bucket: "day", buckets: [] },
  projects: [], models: [], harnesses: [], sessions: [], turns: [],
  detailCoverage: { sessionsTotal: 0, turnsTotal: 0, sessionsTruncated: false, turnsTruncated: false },
  coverage: { exactObservations: 1, derivedObservations: 0, estimatedObservations: 0, backfilledSessions: 0, syncedSessions: 1, syncedAt: value },
});

test("query serialization and cache keys are stable across filter order", () => {
  assert.deepEqual(canonicalUsageQuery({ ...query, projectIds: ["a", "b"] }), canonicalUsageQuery(query));
  const identity = { serverInstanceId: "server-a", spaceId: "space-a" };
  assert.equal(
    usageQueryCacheKey(identity, { ...query, projectIds: ["a", "b"] }),
    usageQueryCacheKey(identity, { ...query, projectIds: ["b", "a"] }),
  );
});

test("a rejected transport request has actionable copy without hiding server errors", () => {
  assert.equal(
    usageErrorMessage(new TypeError("Load failed")),
    "Connection to Polyth was interrupted. Retry when it is available.",
  );
  assert.equal(usageErrorMessage(new TypeError("Failed to fetch")), "Connection to Polyth was interrupted. Retry when it is available.");
  assert.equal(
    usageErrorMessage(Object.assign(new TypeError("Load failed"), { status: 0 })),
    "Connection to Polyth was interrupted. Retry when it is available.",
  );
  assert.equal(
    usageErrorMessage(Object.assign(new Error("usage query unavailable"), { status: 500 })),
    "usage query unavailable",
  );
});

test("request gate prevents a slow Project A response from becoming current after Project B", () => {
  const gate = createUsageStatsRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first.generation), false);
  assert.equal(gate.isCurrent(second.generation), true);
  assert.equal(first.signal.aborted, true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second.generation), false);
});

test("last successful data survives refresh failure and runtime identity changes clear it", async () => {
  let identityCalls = 0;
  let statsCalls = 0;
  let fail = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/usage/identity") {
      identityCalls += 1;
      return new Response(JSON.stringify({ serverInstanceId: identityCalls === 1 ? "server-a" : "server-b", spaceId: "space-a" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    statsCalls += 1;
    if (fail) return new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(report("server-a", 42)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const identity = await ensureUsageIdentity(true);
    assert.equal(identity.serverInstanceId, "server-a");
    await requestUsageStats(query);
    assert.equal(peekCachedUsageStats(identity, query)?.generatedAt, 42);
    fail = true;
    await assert.rejects(() => requestUsageStats(query), /offline/);
    assert.equal(peekCachedUsageStats(identity, query)?.generatedAt, 42, "failed refresh preserves last-good data");
    const nextIdentity = await ensureUsageIdentity(true);
    assert.equal(nextIdentity.serverInstanceId, "server-b");
    assert.equal(peekCachedUsageStats(nextIdentity, query), null, "old-runtime data is isolated");
    // The response remains from server-a; with a successful HTTP response the
    // client must reject it before it can enter the new runtime's cache.
    fail = false;
    await assert.rejects(() => requestUsageStats(query), /different runtime/);
    assert.ok(statsCalls >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a warm scope switch renders its cached report without a loading frame", async () => {
  const warm: UsageStatsQuery = { range: "30d", timezone: "UTC", detailLimit: 50, detailSort: "activity" };
  const cold: UsageStatsQuery = { range: "7d", timezone: "UTC", detailLimit: 50, detailSort: "activity" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/usage/identity") {
      return new Response(JSON.stringify({ serverInstanceId: "server-warm", spaceId: "space-a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const requested = init?.body ? JSON.parse(String(init.body)) as UsageStatsQuery : query;
    return new Response(JSON.stringify(report("server-warm", 99, requested)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const { useUsageStats } = await import("../widgets/usage/usageStatsClient.ts");
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");

    await ensureUsageIdentity(true);
    await requestUsageStats(warm);

    const seen: UsageStatsRequestState[] = [];
    function Probe({ scope }: { scope: UsageStatsQuery }) {
      const stats = useUsageStats(scope);
      seen.push(stats);
      return null;
    }

    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(createElement(Probe, { scope: cold })); });
      seen.length = 0;
      await act(async () => { root.render(createElement(Probe, { scope: warm })); });
      assert.ok(seen.length > 0, "the scope switch rendered");
      assert.equal(seen[0]!.loading, false, "a warm scope renders without a loading frame");
      assert.equal(seen[0]!.report?.query.range, "30d", "the first render already shows the new scope's report");
      assert.ok(!seen.some((frame) => frame.loading), "no loading frame is painted during the switch");
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identical consumers share transport while cancelling one leaves the other active", async () => {
  await ensureUsageIdentityWithMock("shared");
  let calls = 0;
  let release!: (response: Response) => void;
  let transportSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    transportSignal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const first = requestUsageStats(query, controller.signal);
    const second = requestUsageStats(query);
    await Promise.resolve();
    assert.equal(calls, 1);
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(transportSignal?.aborted, false);
    release(new Response(JSON.stringify(report("shared", 123))));
    assert.equal((await second).generatedAt, 123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function ensureUsageIdentityWithMock(serverInstanceId: string): Promise<void> {
  globalThis.fetch = (async () => new Response(JSON.stringify({ serverInstanceId, spaceId: "space-a" }))) as typeof fetch;
  await ensureUsageIdentity(true);
}

test("late aborted responses cannot repopulate the report cache", async () => {
  await ensureUsageIdentityWithMock("cancelled");
  let release!: (response: Response) => void;
  globalThis.fetch = (async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = requestUsageStats(query, controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    release(new Response(JSON.stringify(report("cancelled", 999))));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(peekCachedUsageStats({ serverInstanceId: "cancelled", spaceId: "space-a" }, query), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clearing the cache fences an in-flight response and permits a fresh request", async () => {
  await ensureUsageIdentityWithMock("cleared");
  const { clearUsageStatsCache } = await import("../widgets/usage/usageStatsClient.ts");
  const releases: Array<(response: Response) => void> = [];
  globalThis.fetch = (async () => new Promise<Response>((resolve) => { releases.push(resolve); })) as typeof fetch;
  try {
    const old = requestUsageStats(query);
    await Promise.resolve();
    clearUsageStatsCache();
    const fresh = requestUsageStats(query);
    await Promise.resolve();
    assert.equal(releases.length, 2);
    releases[0]!(new Response(JSON.stringify(report("cleared", 1))));
    await assert.rejects(old, { name: "AbortError" });
    releases[1]!(new Response(JSON.stringify(report("cleared", 2))));
    await fresh;
    assert.equal(peekCachedUsageStats({ serverInstanceId: "cleared", spaceId: "space-a" }, query)?.generatedAt, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persisted identity and report paint the first frame of a fresh tab, then revalidate", async () => {
  // A fresh module instance stands in for a new tab or reload: only localStorage carries over.
  const fresh = () => import(`../widgets/usage/usageStatsClient.ts?tab=${Math.random()}`) as Promise<typeof import("../widgets/usage/usageStatsClient.ts")>;
  const local = dom.localStorage;
  Object.assign(globalThis, { localStorage: local });
  const stats: UsageStatsQuery = { range: "30d", timezone: "UTC", detailLimit: 50, detailSort: "activity" };
  let statsCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/usage/identity") return Response.json({ serverInstanceId: "durable", spaceId: "space-a" });
    statsCalls += 1;
    const requested = init?.body ? JSON.parse(String(init.body)) as UsageStatsQuery : stats;
    return Response.json(report("durable", 7 + statsCalls, requested));
  }) as typeof fetch;
  try {
    const firstTab = await fresh();
    await firstTab.ensureUsageIdentity(true);
    await firstTab.requestUsageStats(stats);
    assert.ok(local.getItem("polyth.usageStats.2.identity"), "the confirmed identity is persisted");
    assert.ok([...Array(local.length).keys()].some((index) => local.key(index)?.startsWith("polyth.usageStats.2.report.")), "the report is persisted");

    const secondTab = await fresh();
    const identity = secondTab.getUsageIdentity();
    assert.deepEqual(identity, { serverInstanceId: "durable", spaceId: "space-a" }, "a new tab knows the identity before any request");
    assert.equal(secondTab.peekCachedUsageStats(identity!, stats)?.generatedAt, 8, "and finds the report without a round trip");

    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const seen: UsageStatsRequestState[] = [];
    function Probe() {
      seen.push(secondTab.useUsageStats(stats));
      return null;
    }
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(createElement(Probe)); });
      assert.equal(seen[0]!.loading, false, "the first frame is not a skeleton");
      assert.equal(seen[0]!.report?.generatedAt, 8, "it shows the persisted report");
      assert.equal(seen[0]!.refreshing, true, "while a revalidation runs");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await act(async () => undefined);
      assert.equal(seen.at(-1)!.report?.generatedAt, 9, "and the fresh report replaces it");
      assert.equal(seen.at(-1)!.refreshing, false);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }

    // A server on another data directory invalidates everything that was persisted.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "/api/usage/identity") return Response.json({ serverInstanceId: "elsewhere", spaceId: "space-a" });
      return Response.json(report("elsewhere", 1, stats));
    }) as typeof fetch;
    const thirdTab = await fresh();
    const moved = await thirdTab.ensureUsageIdentity(true);
    assert.equal(moved.serverInstanceId, "elsewhere");
    assert.equal(thirdTab.peekCachedUsageStats({ serverInstanceId: "durable", spaceId: "space-a" }, stats), null, "the old runtime's reports are gone");
    assert.equal(JSON.parse(local.getItem("polyth.usageStats.2.identity") ?? "{}").serverInstanceId, "elsewhere");
  } finally {
    globalThis.fetch = originalFetch;
    local.clear();
  }
});
