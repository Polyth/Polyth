import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import {
  cacheCountdown,
  mergeCacheHealth,
  scanCacheHealth,
  sessionCacheHealth,
} from "../src/analytics/cacheHealth.ts";
import { collectSessionObservations } from "../src/analytics/collect.ts";
import type { UsageCacheHealth, UsageObservation } from "../src/analytics/contracts.ts";
import { cacheTickMs, cacheWarmthDisplay } from "../widgets/usage/cacheWarmth.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 12);

let serial = 0;
const obs = (
  minute: number,
  cacheRead: number | null,
  cacheWrite: number | null,
  over: Partial<UsageObservation> = {},
): UsageObservation => ({
  id: `o-${serial += 1}`,
  timestamp: T0 + minute * MIN,
  projectId: "project-a",
  sessionId: "session-1",
  turnId: `turn-${serial}`,
  providerId: "anthropic",
  modelId: "claude-sonnet",
  harnessId: "claude",
  agentKind: "main",
  tokens: { input: 10, output: 50, reasoning: null, cacheRead, cacheWrite },
  quality: "exact",
  ...over,
});

test("a miss after an idle gap past the lifetime is burn; a warm follow-up is not", () => {
  const warm = [obs(0, 0, 20_000), obs(2, 20_000, 1_000), obs(4, 21_000, 500)];
  const cold = obs(15, 0, 22_000);
  const health = sessionCacheHealth([...warm, cold]);
  assert.ok(health);
  assert.equal(health.ttlMs, 5 * MIN);
  assert.equal(health.ttlBasis, "provider-default");
  assert.equal(health.providerId, "anthropic");
  assert.equal(health.lastActivityAt, cold.timestamp);
  assert.equal(health.cachedTokens, 22_000);
  // The previous request left 21.5k cached; the miss re-wrote all of it.
  assert.deepEqual(health.burn, { rewrites: 1, tokens: 21_500 });
  assert.deepEqual([...scanCacheHealth([cold, ...warm]).rewrites], [[cold.id, 21_500]]);
});

test("a quick miss is not expiry, and a model switch is not burn", () => {
  const quick = sessionCacheHealth([obs(0, 0, 20_000), obs(3, 0, 20_000)]);
  assert.deepEqual(quick?.burn, { rewrites: 0, tokens: 0 });
  const switched = sessionCacheHealth([obs(0, 0, 20_000), obs(30, 0, 20_000, { modelId: "claude-opus" })]);
  assert.deepEqual(switched?.burn, { rewrites: 0, tokens: 0 });
  assert.equal(switched?.modelId, "claude-opus");
});

test("a hit well past the default lifetime proves the extended one", () => {
  const sequence = [obs(0, 0, 20_000), obs(20, 20_000, 300), obs(45, 0, 21_000)];
  const health = sessionCacheHealth(sequence);
  assert.equal(health?.ttlMs, 60 * MIN);
  assert.equal(health?.ttlBasis, "observed");
  // 25 idle minutes is within the proven hour, so that miss is not counted as expiry.
  assert.deepEqual(health?.burn, { rewrites: 0, tokens: 0 });
  // A hit only slightly past five minutes may be the next response's own
  // generation time, so it proves nothing.
  assert.equal(sessionCacheHealth([obs(0, 0, 20_000), obs(8, 20_000, 0)])?.ttlBasis, "provider-default");
});

test("an unknown lifetime is never invented, but observed misses still count", () => {
  const openai = (minute: number, read: number | null, write: number | null) =>
    obs(minute, read, write, { providerId: "openai", modelId: "gpt", harnessId: "codex" });
  const readsOnly = sessionCacheHealth([openai(0, 0, null), openai(1, 8_000, null), openai(30, 0, null)]);
  assert.equal(readsOnly?.ttlMs, null);
  assert.equal(readsOnly?.ttlBasis, "unknown");
  assert.equal(readsOnly?.providerId, "openai");
  assert.deepEqual(readsOnly?.burn, { rewrites: 0, tokens: 0 });

  const other = (minute: number, read: number, write: number) =>
    obs(minute, read, write, { providerId: "someone", modelId: "m", harnessId: "x" });
  assert.deepEqual(sessionCacheHealth([other(0, 0, 9_000), other(4, 0, 9_000)])?.burn, { rewrites: 0, tokens: 0 });
  assert.deepEqual(sessionCacheHealth([other(0, 0, 9_000), other(6, 0, 9_000)])?.burn, { rewrites: 1, tokens: 9_000 });
});

test("sessions without cache telemetry have no cache health", () => {
  assert.equal(sessionCacheHealth([obs(0, null, null), obs(1, 0, 0)]), null);
  assert.equal(scanCacheHealth([obs(0, null, null)]).health.size, 0);
});

const health = (over: Partial<UsageCacheHealth> = {}): UsageCacheHealth => ({
  lastActivityAt: T0,
  providerId: "anthropic",
  ttlMs: 5 * MIN,
  ttlBasis: "provider-default",
  cachedTokens: 40_000,
  burn: { rewrites: 0, tokens: 0 },
  ...over,
});

test("the countdown warns near expiry and reports expiry only with a known lifetime", () => {
  assert.deepEqual(cacheCountdown(health(), T0 + MIN), { state: "warm", idleMs: MIN, remainingMs: 4 * MIN });
  assert.equal(cacheCountdown(health(), T0 + 4.5 * MIN).state, "expiring");
  assert.deepEqual(cacheCountdown(health(), T0 + 6 * MIN), { state: "expired", idleMs: 6 * MIN, remainingMs: 0 });
  // A one-hour cache warns in its last 12 minutes.
  assert.equal(cacheCountdown(health({ ttlMs: 60 * MIN, ttlBasis: "observed" }), T0 + 49 * MIN).state, "expiring");
  assert.equal(cacheCountdown(health({ ttlMs: 60 * MIN, ttlBasis: "observed" }), T0 + 47 * MIN).state, "warm");
  assert.deepEqual(cacheCountdown(health({ ttlMs: null, ttlBasis: "unknown" }), T0 + 90 * MIN),
    { state: "unknown", idleMs: 90 * MIN, remainingMs: null });
});

test("the card shows tone only for expiring or expired caches and pauses during a turn", () => {
  assert.equal(cacheWarmthDisplay(health(), T0 + MIN).tone, undefined);
  assert.equal(cacheWarmthDisplay(health(), T0 + 4.5 * MIN).tone, "warning");
  const expired = cacheWarmthDisplay(health(), T0 + 6 * MIN);
  assert.equal(expired.state, "expired");
  assert.equal(expired.tone, "critical");
  assert.equal(cacheWarmthDisplay(health({ ttlMs: null, ttlBasis: "unknown" }), T0 + 90 * MIN).tone, undefined);
  assert.equal(cacheWarmthDisplay(health(), T0 + 6 * MIN, true).state, "active");

  assert.equal(cacheTickMs(health(), T0 + MIN), 15_000);
  assert.equal(cacheTickMs(health(), T0 + 4 * MIN), 1_000);
  assert.equal(cacheTickMs(health(), T0 + 6 * MIN), null);
  assert.equal(cacheTickMs(health(), T0, true), null);
  assert.equal(cacheTickMs(health({ ttlMs: null, ttlBasis: "unknown" }), T0), 30_000);
  assert.equal(cacheTickMs(null, T0), null);
});

test("live and reported health merge by newest activity and largest burn", () => {
  const reported = health({ burn: { rewrites: 3, tokens: 90_000 } });
  const live = health({ lastActivityAt: T0 + MIN, cachedTokens: 41_000, burn: { rewrites: 0, tokens: 0 } });
  assert.deepEqual(mergeCacheHealth(live, reported), { ...live, burn: reported.burn });
  assert.equal(mergeCacheHealth(null, reported), reported);
  assert.equal(mergeCacheHealth(live, undefined), live);
});

test("reports carry burn in totals and groups, and cache health per session", () => {
  const beforeRange = obs(-60 * 24 * 40, 0, 30_000);
  const inRange = obs(-60 * 24 * 40 + 30, 0, 31_000);
  const other = obs(0, 5_000, 100, { sessionId: "session-2", providerId: "openai", modelId: "gpt" });
  const report = buildUsageStatsReport({
    serverInstanceId: "server",
    spaceId: "space",
    query: { range: "custom", from: inRange.timestamp - MIN, to: T0 + MIN, timezone: "UTC" },
    observations: [inRange, other, beforeRange],
    projects: [{ id: "project-a", name: "A" }],
    sessions: new Map([
      ["session-1", { id: "session-1", title: "One", status: "idle" }],
      ["session-2", { id: "session-2", title: "Two", status: "idle" }],
    ]),
    now: T0 + MIN,
  });
  // The request that proves the miss lies before the range; the burn still counts.
  assert.deepEqual(report.totals.cacheBurn, { rewrites: 1, tokens: 30_000 });
  assert.deepEqual(report.models.find((model) => model.label === "claude-sonnet")?.metrics.cacheBurn, { rewrites: 1, tokens: 30_000 });
  const one = report.sessions.find((session) => session.id === "session-1");
  assert.equal(one?.cache?.ttlBasis, "provider-default");
  assert.equal(one?.cache?.lastActivityAt, inRange.timestamp);
  assert.equal(report.sessions.find((session) => session.id === "session-2")?.cache?.ttlBasis, "unknown");

  const noCache = buildUsageStatsReport({
    serverInstanceId: "server",
    spaceId: "space",
    query: { range: "all", timezone: "UTC" },
    observations: [obs(0, null, null)],
    projects: [],
    sessions: new Map(),
    now: T0 + MIN,
  });
  assert.equal(noCache.totals.cacheBurn, null);
  assert.equal(noCache.sessions[0]?.cache, undefined);
});

test("health follows canonical usage events collected from a session log", () => {
  const projection: SessionProjection = {
    id: "session-1", projectId: "project-a", title: "S", status: "idle", createdAt: 1, updatedAt: 1,
    model: { providerID: "anthropic", modelID: "claude-sonnet" }, resolvedHarnessId: "claude",
  };
  const usage = (seq: number, minute: number, cacheRead: number, cacheWrite: number): SessionEvent => ({
    id: `e-${seq}`, sessionId: "session-1", seq, v: 1, type: "usage/recorded", time: T0 + minute * MIN,
    data: { tokens: { input: 5, output: 20, cacheRead, cacheWrite } } as JsonObject,
  });
  const result = sessionCacheHealth(collectSessionObservations(projection, [
    usage(1, 0, 0, 12_000), usage(2, 1, 12_000, 400), usage(3, 20, 0, 12_600),
  ]));
  assert.equal(result?.ttlMs, 5 * MIN);
  assert.deepEqual(result?.burn, { rewrites: 1, tokens: 12_400 });
});
