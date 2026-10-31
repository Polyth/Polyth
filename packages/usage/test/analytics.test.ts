import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import { collectSessionObservations } from "../src/analytics/collect.ts";
import { addLocalDays, startOfLocalDay, zonedTimeToUtc } from "../src/analytics/time.ts";
import type { UsageObservation, UsageStatsQuery } from "../src/analytics/contracts.ts";

const DAY = 86_400_000;
const projection = (over: Partial<SessionProjection> = {}): SessionProjection => ({
  id: "session-1",
  projectId: "project-a",
  title: "Session one",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const event = (
  seq: number,
  time: number,
  type: string,
  data: JsonObject,
): SessionEvent => ({ id: `event-${seq}`, sessionId: "session-1", seq, time, type, data, v: 1 });
const observation = (over: Partial<UsageObservation> = {}): UsageObservation => ({
  id: "observation",
  timestamp: Date.UTC(2026, 6, 1, 12),
  projectId: "project-a",
  sessionId: "session-1",
  turnId: "turn-1",
  providerId: "anthropic",
  modelId: "sonnet",
  harnessId: "claude",
  agentKind: "main",
  tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
  cost: 0.01,
  quality: "exact",
  ...over,
});
const report = (
  observations: UsageObservation[],
  query: UsageStatsQuery,
  now = Date.UTC(2026, 6, 10, 12),
  projects = [{ id: "project-a", name: "Project A", path: "/a" }, { id: "project-b", name: "Project B", path: "/b" }],
) => buildUsageStatsReport({
  serverInstanceId: "server-test",
  spaceId: "space-test",
  query,
  observations,
  projects,
  sessions: new Map([...new Set(observations.map((item) => item.sessionId))].map((id) => [id, { id, title: id, status: "idle" as const }])),
  now,
});

test("legacy assistant telemetry becomes one derived observation with turn context", () => {
  const events = [
    event(1, 1_000, "turn/started", {
      turnId: "turn-1",
      model: { providerID: "claude", modelID: "sonnet" },
      harnessId: "claude",
    }),
    event(2, 1_100, "assistant/message", {
      partId: "message-1:text:0",
      text: "done",
      tokens: { input: 10, output: 2 },
      cost: 0.1,
    }),
    event(3, 1_200, "turn/stopped", { turnId: "turn-1", reason: "completed", retry: { attempt: 2 } }),
  ];
  const [result] = collectSessionObservations(projection({ model: { providerID: "claude", modelID: "sonnet" }, resolvedHarnessId: "claude" }), events);
  assert.ok(result);
  assert.equal(result.id, "assistant:event-2");
  assert.equal(result.quality, "derived");
  assert.equal(result.providerId, "anthropic");
  assert.equal(result.modelId, "sonnet");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.status, "completed");
  assert.equal(result.retries, 2);
  assert.equal(result.timing?.totalMs, 200);
  assert.equal(result.cost, 0.1);
});

test("legacy assistant fallback does not duplicate canonical usage or repeated message parts", () => {
  const events = [
    event(1, 1_000, "turn/started", { turnId: "turn-1", model: { providerID: "openai", modelID: "gpt-5" }, harnessId: "codex" }),
    event(2, 1_100, "assistant/message", { partId: "message-1:text:0", text: "a", tokens: { input: 10, output: 1 } }),
    event(3, 1_200, "assistant/message", { partId: "message-1:text:1", text: "b", tokens: { input: 10, output: 1 } }),
    event(4, 1_300, "usage/recorded", { model: { providerID: "openai", modelID: "gpt-5" }, tokens: { input: 10, output: 1 } }),
    event(5, 1_400, "turn/stopped", { turnId: "turn-1", reason: "completed" }),
    event(6, 1_500, "turn/started", { turnId: "turn-2", model: { providerID: "openai", modelID: "gpt-5" }, harnessId: "codex" }),
    event(7, 1_600, "assistant/message", { partId: "message-2:text:0", text: "c", tokens: { input: 4, output: 2 } }),
    event(8, 1_700, "turn/stopped", { turnId: "turn-2", reason: "completed" }),
  ];
  const results = collectSessionObservations(projection({ model: { providerID: "openai", modelID: "gpt-5" }, resolvedHarnessId: "codex" }), events);
  assert.deepEqual(results.map((item) => item.turnId), ["turn-1", "turn-2"]);
  assert.deepEqual(results.map((item) => item.tokens.input), [10, 4]);
  assert.equal(results[0]?.id, "usage:event-4");
  assert.equal(results[1]?.id, "assistant:event-7");
});

test("a placeholder unknown usage model inherits the turn model", () => {
  const events = [
    event(1, 1_000, "turn/started", { turnId: "turn-1", model: { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", variant: "max" }, harnessId: "opencode" }),
    event(2, 1_100, "usage/recorded", { model: { providerID: "opencode", modelID: "unknown" }, tokens: { input: 10, output: 1 }, turnId: "turn-1", harnessId: "opencode" }),
    event(3, 1_200, "turn/stopped", { turnId: "turn-1", reason: "completed" }),
  ];
  const [result] = collectSessionObservations(projection({ resolvedHarnessId: "opencode" }), events);
  assert.equal(result?.modelId, "deepseek-v4.1-flash-free");
  assert.equal(result?.modelVariant, "max");
});

test("empty usage events do not suppress usable assistant fallback telemetry", () => {
  const events = [
    event(1, 1_000, "turn/started", { turnId: "turn-1", model: { providerID: "openai", modelID: "gpt-5" } }),
    event(2, 1_100, "assistant/message", { partId: "message-1:text:0", tokens: { input: 9, output: 3 }, cost: 0.02 }),
    event(3, 1_150, "usage/recorded", { tokens: {} }),
    event(4, 1_200, "turn/stopped", { turnId: "turn-1", reason: "completed" }),
  ];
  const results = collectSessionObservations(projection({ model: { providerID: "openai", modelID: "gpt-5" } }), events);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "assistant:event-2");
  assert.equal(results[0]?.tokens.input, 9);
  assert.equal(results[0]?.tokens.output, 3);
});

test("a multi-day session is attributed to each observation day, never its latest turn", () => {
  const events = [
    event(1, Date.UTC(2026, 6, 1, 10), "turn/started", { turnId: "turn-1", harnessId: "claude" }),
    event(2, Date.UTC(2026, 6, 1, 11), "usage/recorded", { model: { providerID: "claude", modelID: "sonnet" }, tokens: { input: 100, output: 10 }, cost: 0.1 }),
    event(3, Date.UTC(2026, 6, 1, 12), "turn/stopped", { turnId: "turn-1", reason: "completed" }),
    event(4, Date.UTC(2026, 6, 3, 10), "turn/started", { turnId: "turn-2", harnessId: "claude" }),
    event(5, Date.UTC(2026, 6, 3, 11), "usage/recorded", { model: { providerID: "claude", modelID: "sonnet" }, tokens: { input: 200, output: 20 }, cost: 0.2 }),
    event(6, Date.UTC(2026, 6, 3, 12), "turn/stopped", { turnId: "turn-2", reason: "completed" }),
  ];
  const observations = collectSessionObservations(projection({ updatedAt: Date.UTC(2026, 6, 3, 12) }), events);
  const result = report(observations, { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 4), timezone: "UTC" });
  assert.equal(result.totals.tokens.total, 330);
  assert.equal(result.totals.cost, 0.30000000000000004);
  assert.deepEqual(result.chart.buckets.map((bucket) => bucket.values.tokens), [110, null, 220]);
  assert.equal(result.totals.turns, 2);
});

test("project filters are non-overlapping and A plus B equals All", () => {
  const observations = [
    observation({ id: "a", projectId: "project-a", sessionId: "a", tokens: { input: 10, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "b", projectId: "project-b", sessionId: "b", tokens: { input: 20, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
  ];
  const all = report(observations, { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC" });
  const a = report(observations, { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC", projectIds: ["project-a"] });
  const b = report(observations, { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC", projectIds: ["project-b"] });
  assert.equal(all.totals.tokens.total, 30);
  assert.equal(a.totals.tokens.total, 10);
  assert.equal(b.totals.tokens.total, 20);
  assert.equal(a.totals.tokens.total! + b.totals.tokens.total!, all.totals.tokens.total);
  assert.equal(new Set([...a.sessions, ...b.sessions].map((item) => item.id)).size, all.sessions.length);
});

test("range boundaries are from-inclusive and to-exclusive", () => {
  const from = Date.UTC(2026, 6, 1);
  const to = Date.UTC(2026, 6, 2);
  const observations = [
    observation({ id: "before", timestamp: from - 1, tokens: { input: 1, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "at-from", timestamp: from, tokens: { input: 2, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "before-to", timestamp: to - 1, tokens: { input: 3, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "at-to", timestamp: to, tokens: { input: 4, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
  ];
  const result = report(observations, { range: "custom", from, to, timezone: "UTC" });
  assert.equal(result.totals.tokens.total, 5);
  assert.deepEqual(result.sessions.map((item) => item.id).sort(), ["session-1"]);
  assert.equal(result.sessions[0]?.metrics.tokens.total, 5);
});

test("calendar bucketing remains correct through a DST transition", () => {
  const timezoneName = "America/New_York";
  const first = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 12, minute: 0, second: 0 }, timezoneName);
  const firstMidnight = startOfLocalDay(first, timezoneName);
  const next = addLocalDays(firstMidnight, 1, timezoneName);
  const observations = [
    observation({ id: "dst-before", timestamp: zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 12, minute: 0, second: 0 }, timezoneName), tokens: { input: 7, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "dst-after", timestamp: zonedTimeToUtc({ year: 2026, month: 3, day: 9, hour: 12, minute: 0, second: 0 }, timezoneName), tokens: { input: 11, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } }),
  ];
  const result = report(observations, { range: "custom", from: startOfLocalDay(first, timezoneName), to: addLocalDays(next, 1, timezoneName), timezone: timezoneName, bucket: "day" });
  assert.equal(result.chart.buckets.length, 2);
  assert.equal(result.chart.buckets[0]?.values.tokens, 7);
  assert.equal(result.chart.buckets[1]?.values.tokens, 11);
  assert.equal((next - firstMidnight) / 3_600_000, 23);
});

test("named calendar ranges compare with the preceding equivalent range", () => {
  const now = zonedTimeToUtc({ year: 2026, month: 7, day: 10, hour: 12, minute: 0, second: 0 }, "UTC");
  const current = observation({ id: "current", timestamp: now - DAY, tokens: { input: 120, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } });
  const previous = observation({ id: "previous", timestamp: now - 8 * DAY, tokens: { input: 60, output: 0, reasoning: null, cacheRead: null, cacheWrite: null } });
  const result = report([current, previous], { range: "7d", timezone: "UTC" }, now);
  assert.equal(result.totals.tokens.total, 120);
  assert.equal(result.trends.tokens?.previous, 60);
  assert.equal(result.trends.tokens?.percent, 100);
});

test("token composition remains internally consistent and cache is not double counted", () => {
  const result = report([observation()], { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC" });
  assert.equal(result.totals.tokens.input, 10);
  assert.equal(result.totals.tokens.output, 5);
  assert.equal(result.totals.tokens.reasoning, 2);
  assert.equal(result.totals.tokens.cacheRead, 3);
  assert.equal(result.totals.tokens.cacheWrite, 1);
  assert.equal(result.totals.tokens.total, 19);
  assert.equal(result.totals.cacheHitPercent, 3 / 13 * 100);
});

test("model variants stay distinct while provider aliases normalize model attribution", () => {
  const observations = [
    observation({ id: "alias", providerId: "claude", modelId: "sonnet" }),
    observation({ id: "variant", providerId: "anthropic", modelId: "sonnet", modelVariant: "high" }),
    observation({ id: "other", providerId: "codex", modelId: "gpt-5" }),
  ];
  const result = report(observations, { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC" });
  assert.equal(result.models.length, 3);
  assert.equal(result.models.filter((item) => item.label.startsWith("sonnet")).length, 2);
  assert.deepEqual([...new Set(result.models.map((item) => item.detail).filter(Boolean))].sort(), ["Claude", "OpenAI"]);
});

test("harness breakdown partitions the scope and keeps unattributed usage visible", () => {
  const tokens = (input: number) => ({ input, output: 0, reasoning: null, cacheRead: null, cacheWrite: null });
  const observations = [
    observation({ id: "claude-a", harnessId: "claude", sessionId: "s1", turnId: "t1", tokens: tokens(10), cost: 0.5 }),
    observation({ id: "claude-b", harnessId: " Claude ", sessionId: "s2", turnId: "t2", tokens: tokens(20) }),
    observation({ id: "codex", harnessId: "codex", sessionId: "s3", turnId: "t3", tokens: tokens(40) }),
    observation({ id: "missing", harnessId: undefined, sessionId: "s4", turnId: "t4", tokens: tokens(5) }),
    observation({ id: "blank", harnessId: "   ", sessionId: "s4", turnId: "t5", tokens: tokens(3) }),
    observation({ id: "elsewhere", projectId: "project-b", harnessId: "cursor", sessionId: "s5", turnId: "t6", tokens: tokens(99) }),
  ];
  const range = { range: "custom" as const, from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC" };
  const result = report(observations, { ...range, projectIds: ["project-a"] });

  const byId = new Map(result.harnesses.map((group) => [group.id, group]));
  assert.deepEqual([...byId.keys()].sort(), ["claude", "codex", "unknown"]);
  assert.equal(byId.get("claude")?.label, "Claude Code");
  assert.equal(byId.get("codex")?.label, "Codex");
  assert.equal(byId.get("unknown")?.label, "Unknown harness");

  assert.equal(byId.get("claude")?.metrics.tokens.total, 30);
  assert.equal(byId.get("claude")?.metrics.sessions, 2);
  assert.equal(byId.get("claude")?.metrics.turns, 2);
  assert.equal(byId.get("codex")?.metrics.tokens.total, 40);
  assert.equal(byId.get("unknown")?.metrics.tokens.total, 8);
  assert.equal(byId.get("unknown")?.metrics.observations, 2);

  // Every selected observation lands in exactly one harness, and another project's harness is out of scope.
  assert.equal(
    result.harnesses.reduce((sum, group) => sum + (group.metrics.tokens.total ?? 0), 0),
    result.totals.tokens.total,
  );
  assert.equal(
    result.harnesses.reduce((sum, group) => sum + group.metrics.observations, 0),
    result.totals.observations,
  );
  assert.equal(byId.has("cursor"), false);

  // Without a project filter the other project's harness joins the breakdown.
  assert.ok(report(observations, range).harnesses.some((group) => group.id === "cursor"));
});

test("harness groups carry a trend against the preceding equivalent range", () => {
  const now = zonedTimeToUtc({ year: 2026, month: 7, day: 10, hour: 12, minute: 0, second: 0 }, "UTC");
  const tokens = (input: number) => ({ input, output: 0, reasoning: null, cacheRead: null, cacheWrite: null });
  // Cost is compared first when known; leave it out so the token trend is what is asserted.
  const result = report([
    observation({ id: "now", harnessId: "codex", timestamp: now - DAY, tokens: tokens(150), cost: undefined }),
    observation({ id: "before", harnessId: "codex", timestamp: now - 8 * DAY, tokens: tokens(100), cost: undefined }),
    observation({ id: "new", harnessId: "claude", timestamp: now - DAY, tokens: tokens(10), cost: undefined }),
  ], { range: "7d", timezone: "UTC" }, now);
  const byId = new Map(result.harnesses.map((group) => [group.id, group]));
  assert.equal(byId.get("codex")?.trend?.percent, 50);
  assert.equal(byId.get("claude")?.trend, undefined);
});

test("drilldown session and turn rows reconcile with the filtered aggregate", () => {
  const observations = [
    observation({ id: "one", sessionId: "s1", turnId: "t1", tokens: { input: 10, output: 2, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "two", sessionId: "s1", turnId: "t2", tokens: { input: 20, output: 3, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "three", sessionId: "s2", turnId: "t3", projectId: "project-b", tokens: { input: 30, output: 4, reasoning: null, cacheRead: null, cacheWrite: null } }),
  ];
  const result = report(observations, { range: "custom", from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 2), timezone: "UTC", detailLimit: 10 });
  assert.equal(result.sessions.reduce((sum, item) => sum + (item.metrics.tokens.total ?? 0), 0), result.totals.tokens.total);
  assert.equal(result.turns.reduce((sum, item) => sum + (item.metrics.tokens.total ?? 0), 0), result.totals.tokens.total);
});


test("session scope isolates one session without changing project scope", () => {
  const observations = [
    observation({ id: "s1", sessionId: "session-1", tokens: { input: 10, output: 2, reasoning: null, cacheRead: null, cacheWrite: null } }),
    observation({ id: "s2", sessionId: "session-2", tokens: { input: 20, output: 4, reasoning: null, cacheRead: null, cacheWrite: null } }),
  ];
  const scoped = report(observations, {
    range: "custom",
    from: Date.UTC(2026, 6, 1),
    to: Date.UTC(2026, 6, 2),
    timezone: "UTC",
    sessionIds: ["session-2"],
  });
  assert.equal(scoped.totals.sessions, 1);
  assert.equal(scoped.totals.tokens.total, 24);
  assert.deepEqual(scoped.sessions.map((item) => item.id), ["session-2"]);
});

test("turn timing, steps, retries, and token rates are counted once per turn", () => {
  const shared = {
    sessionId: "session-1",
    turnId: "turn-1",
    timing: { totalMs: 2_000, modelMs: 1_000, toolMs: 1_000, ttftMs: 100 },
    steps: 3,
    retries: 1,
  };
  const result = report([
    observation({
      ...shared,
      id: "turn-sample-a",
      tokens: { input: 10, output: 10, reasoning: null, cacheRead: null, cacheWrite: null },
    }),
    observation({
      ...shared,
      id: "turn-sample-b",
      tokens: { input: 15, output: 15, reasoning: null, cacheRead: null, cacheWrite: null },
    }),
    observation({
      id: "untimed-legacy-sample",
      sessionId: "session-2",
      turnId: "turn-2",
      tokens: { input: 100, output: 100, reasoning: null, cacheRead: null, cacheWrite: null },
      timing: undefined,
      steps: undefined,
      retries: undefined,
    }),
  ], {
    range: "custom",
    from: Date.UTC(2026, 6, 1),
    to: Date.UTC(2026, 6, 2),
    timezone: "UTC",
  });

  assert.equal(result.totals.tokens.output, 125);
  assert.equal(result.totals.steps, 3);
  assert.equal(result.totals.retries, 1);
  assert.equal(result.totals.timing?.totalMs, 2_000);
  assert.equal(result.totals.timing?.modelMs, 1_000);
  assert.equal(result.totals.timing?.toolMs, 1_000);
  assert.equal(result.totals.timing?.ttftMs, 100);
  assert.equal(result.totals.rates?.responseTokPerSec, 25);
  assert.equal(result.totals.rates?.wholeTurnTokPerSec, 12.5);
});
