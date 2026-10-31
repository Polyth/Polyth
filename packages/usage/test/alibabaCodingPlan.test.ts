import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject, Project, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  ALIBABA_CODING_PLAN_LIMITS,
  computeAlibabaCodingPlanQuota,
  createAlibabaCodingPlanSource,
  createUsageAnalyticsService,
  createUsageLimitService,
} from "../src/index.ts";
import { usageRoutes } from "../src/serverEntry.ts";
import type { UsageObservation } from "../src/analytics/contracts.ts";

const H = 60 * 60 * 1000;
const now = Date.UTC(2026, 0, 15, 12);

const observation = (id: string, timestamp: number, patch: Partial<UsageObservation> = {}): UsageObservation => ({
  id,
  timestamp,
  projectId: "p",
  sessionId: "s",
  providerId: "alibaba-coding-plan",
  modelId: "qwen",
  tokens: { input: 1, output: 1, reasoning: null, cacheRead: null, cacheWrite: null },
  quality: "exact",
  status: "completed",
  ...patch,
});

test("Alibaba Coding Plan computes rolling 5h, weekly and monthly estimates", () => {
  const quota = computeAlibabaCodingPlanQuota({
    tier: "lite",
    now,
    timestamps: [
      now - 1 * H,
      now - 6 * H,
      now - 8 * 24 * H,
      now - 40 * 24 * H,
    ],
  });
  assert.deepEqual(
    [quota.fiveHour.used, quota.weekly.used, quota.monthly.used],
    [1, 2, 3],
  );
  assert.deepEqual(
    [quota.fiveHour.limit, quota.weekly.limit, quota.monthly.limit],
    [ALIBABA_CODING_PLAN_LIMITS.lite.fiveHour, ALIBABA_CODING_PLAN_LIMITS.lite.weekly, ALIBABA_CODING_PLAN_LIMITS.lite.monthly],
  );
  assert.equal(quota.fiveHour.resetsAt, now - 1 * H + 5 * H);

  const pro = computeAlibabaCodingPlanQuota({ tier: "pro", now, timestamps: [] });
  assert.deepEqual(
    [pro.fiveHour.limit, pro.weekly.limit, pro.monthly.limit],
    [ALIBABA_CODING_PLAN_LIMITS.pro.fiveHour, ALIBABA_CODING_PLAN_LIMITS.pro.weekly, ALIBABA_CODING_PLAN_LIMITS.pro.monthly],
  );
  assert.equal(pro.fiveHour.resetsAt, undefined);
});

test("Alibaba Coding Plan counts only completed non-derived observations of its own provider and dedupes ids", async () => {
  const source = createAlibabaCodingPlanSource({
    runtime: {
      readAuth: () => ({ "alibaba-coding-plan": { type: "api", key: "key", tier: "pro" } }),
      env: {},
    } as never,
    now: () => now,
    observations: async (space) => {
      assert.equal(space.spaceId, "space-a");
      return [
        observation("one", now - 1 * H),
        observation("one", now - 1 * H),
        observation("estimated", now - 6 * H, { quality: "estimated" }),
        observation("failed", now - 2 * H, { status: "failed" }),
        observation("cancelled", now - 2 * H, { status: "cancelled" }),
        observation("running", now - 2 * H, { status: undefined }),
        observation("derived", now - 2 * H, { quality: "derived" }),
        observation("other", now - 1 * H, { providerId: "claude" }),
        observation("old", now - 40 * 24 * H),
      ];
    },
  });
  assert.equal(source.isConfigured(), true);
  const snapshot = await source.snapshot({ spaceId: "space-a" } as SpaceContext);
  assert.equal(snapshot.accountLabel, "Alibaba Coding Plan (Pro)");
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["5h", 1, ALIBABA_CODING_PLAN_LIMITS.pro.fiveHour, "requests"],
    ["weekly", 2, ALIBABA_CODING_PLAN_LIMITS.pro.weekly, "requests"],
    ["monthly", 2, ALIBABA_CODING_PLAN_LIMITS.pro.monthly, "requests"],
  ]);
});

const space = (spaceId: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

const projects: Project[] = [{ id: "project-a", name: "Project A", path: "/a", createdAt: 1 }];

const projection = (id: string): SessionProjection => ({
  id,
  projectId: "project-a",
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt: now,
  lastTurnAt: now,
  model: { providerID: "alibaba-coding-plan", modelID: "qwen" },
  resolvedHarnessId: "alibaba-coding-plan",
});

// Each request is its own completed turn; a trailing usage event without a
// stop is a turn still running and must not count.
const usageEvents = (sessionId: string, count: number): SessionEvent[] => {
  const events: SessionEvent[] = [];
  const push = (type: string, time: number, data: JsonObject) => events.push({
    id: `${sessionId}-${events.length}`,
    sessionId,
    seq: events.length + 2,
    time,
    type,
    data,
    v: 1,
  } as SessionEvent);
  for (let index = 0; index <= count; index += 1) {
    const turnId = `${sessionId}-turn-${index}`;
    const time = now - (count + 1 - index) * (H / 2);
    push("turn/started", time, { turnId });
    push("usage/recorded", time + 1, {
      turnId,
      model: { providerID: "alibaba-coding-plan", modelID: "qwen" },
      tokens: { input: 1, output: 1 },
    });
    if (index < count) push("turn/stopped", time + 2, { turnId, reason: "completed" });
  }
  return events;
};

test("Alibaba Coding Plan route estimates only the requesting Space", async () => {
  const analytics = createUsageAnalyticsService({
    now: () => now,
    serverInstanceId: "alibaba-route",
    source: {
      projections: async (ctx) => [projection(`session-${ctx.spaceId}`)],
      events: async (ctx, sessionId) => usageEvents(sessionId, ctx.spaceId === "space-a" ? 2 : 5),
    },
  });
  const limits = createUsageLimitService({ now: () => now });
  const source = createAlibabaCodingPlanSource({
    runtime: {
      readAuth: () => ({ alibaba: { type: "api", key: "key", tier: "lite" } }),
      env: {},
    } as never,
    observations: (ctx, from) => analytics.observations(ctx, from),
    now: () => now,
  });
  const route = usageRoutes(analytics, { forSpace: () => ({ projects: { list: async () => projects } }) } as never, limits, source);

  const read = async (ctx: SpaceContext) => {
    let response: { status: number; body: unknown } | null = null;
    const handled = await route({
      path: "/api/usage/limits",
      method: "GET",
      space: ctx,
      body: async () => ({}),
      json: (status: number, body: unknown) => { response = { status, body }; },
    } as never);
    assert.equal(handled, true);
    assert.equal(response!.status, 200);
    return response!.body as { providers: Array<{ providerId: string; windows: Array<{ used: number }> }> };
  };

  const first = await read(space("space-a")) as Awaited<ReturnType<typeof read>> & {
    serverInstanceId?: string;
    spaceId?: string;
    providers: Array<{ scope?: string }>;
  };
  assert.equal(first.providers[0]?.providerId, "alibaba-coding-plan");
  assert.equal(first.providers[0]?.windows[0]?.used, 2);
  assert.equal(first.providers[0]?.scope, "space");
  assert.equal(first.serverInstanceId, "alibaba-route");
  assert.equal(first.spaceId, "space-a");
  const second = await read(space("space-b")) as Awaited<ReturnType<typeof read>> & { spaceId?: string };
  assert.equal(second.providers[0]?.windows[0]?.used, 5);
  assert.equal(second.spaceId, "space-b");

  let refreshed: { status: number; body: unknown } | null = null;
  await route({
    path: "/api/usage/limits/refresh",
    method: "POST",
    space: space("space-a"),
    body: async () => ({ providerId: "alibaba-coding-plan" }),
    json: (status: number, body: unknown) => { refreshed = { status, body }; },
  } as never);
  assert.equal((refreshed!.body as { providers: Array<{ windows: Array<{ used: number }> }> }).providers[0]?.windows[0]?.used, 2);
  analytics.stop();
});

test("Alibaba Coding Plan refresh tells an unconfigured source from an unavailable estimate", async () => {
  const limits = createUsageLimitService({ now: () => now });
  const analytics = { serverInstanceId: "refresh-route" } as never;
  const refresh = async (source: Parameters<typeof usageRoutes>[3]) => {
    let response: { status: number; body: unknown } | null = null;
    const route = usageRoutes(analytics, {} as never, limits, source);
    await route({
      path: "/api/usage/limits/refresh",
      method: "POST",
      space: space("space-a"),
      body: async () => ({ providerId: "alibaba-coding-plan" }),
      json: (status: number, body: unknown) => { response = { status, body }; },
    } as never);
    return response!;
  };
  const runtime = (configured: boolean) => ({
    readAuth: () => configured ? { alibaba: { type: "api", key: "key" } } : {},
    env: {},
  }) as never;

  const unconfigured = await refresh(createAlibabaCodingPlanSource({
    runtime: runtime(false),
    observations: async () => [],
    now: () => now,
  }));
  assert.equal(unconfigured.status, 404);
  assert.equal((unconfigured.body as { error: string }).error, "not-found");

  const failing = await refresh(createAlibabaCodingPlanSource({
    runtime: runtime(true),
    observations: async () => { throw new Error("analytics index unavailable"); },
    now: () => now,
  }));
  assert.equal(failing.status, 500);
  assert.equal((failing.body as { error: string }).error, "limits-unavailable");
});
