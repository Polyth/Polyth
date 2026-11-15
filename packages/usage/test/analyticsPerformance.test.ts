import test from "node:test";
import assert from "node:assert/strict";
import { buildUsageStatsReport, createUsageReportBuild, createUsageSessionRollup } from "../src/analytics/aggregate.ts";
import type { UsageObservation, UsageStatsQuery } from "../src/analytics/contracts.ts";

test("large observation sets stay bounded and aggregate without chart-bar explosion", () => {
  const observations: UsageObservation[] = [];
  const start = Date.UTC(2020, 0, 1);
  for (let index = 0; index < 100_000; index += 1) {
    const project = `project-${index % 100}`;
    observations.push({
      id: `observation-${index}`,
      timestamp: start + (index % 2_000) * 86_400_000,
      projectId: project,
      sessionId: `session-${index % 5_000}`,
      turnId: `turn-${index % 20_000}`,
      providerId: index % 2 === 0 ? "anthropic" : "openai",
      modelId: index % 2 === 0 ? "sonnet" : "gpt-5",
      tokens: { input: 10, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 1 },
      cost: .001,
      quality: "exact",
    });
  }
  const projects = Array.from({ length: 100 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, path: `/${index}` }));
  const sessions = new Map([...new Set(observations.map((item) => item.sessionId))].map((id) => [id, { id, title: id, status: "idle" as const }]));
  const report = buildUsageStatsReport({
    serverInstanceId: "perf",
    spaceId: "space",
    query: { range: "all", timezone: "UTC", detailLimit: 50 },
    observations,
    projects,
    sessions,
    now: Date.UTC(2026, 0, 1),
  });
  assert.equal(report.totals.observations, 100_000);
  assert.ok(report.chart.buckets.length <= 120);
  assert.equal(report.sessions.length, 50);
  assert.equal(report.detailCoverage.sessionsTruncated, true);
});

test("an explicitly tiny bucket is downgraded before a long custom range can explode", () => {
  const from = Date.UTC(2000, 0, 1);
  const to = Date.UTC(2020, 0, 1);
  const report = buildUsageStatsReport({
    serverInstanceId: "perf",
    spaceId: "space",
    query: { range: "custom", from, to, timezone: "UTC", bucket: "hour" },
    observations: [{
      id: "long-range",
      timestamp: from + 1,
      projectId: "project",
      sessionId: "session",
      turnId: "turn",
      tokens: { input: 10, output: 0, reasoning: null, cacheRead: null, cacheWrite: null },
      quality: "exact",
    }],
    projects: [{ id: "project", name: "Project" }],
    sessions: new Map([["session", { id: "session", title: "Session", status: "idle" }]]),
    now: to + 1,
  });
  assert.equal(report.chart.bucket, "month");
  assert.ok(report.chart.buckets.length <= 120);
  assert.equal(report.totals.tokens.total, 10);
});

test("large reports format each observation date once across all breakdowns", () => {
  const now = Date.UTC(2026, 8, 30);
  const observations: UsageObservation[] = Array.from({ length: 21_000 }, (_, index) => ({
    id: String(index),
    timestamp: now - 86_400_000 + index * 1000,
    projectId: "project",
    sessionId: `session-${index % 100}`,
    turnId: String(index),
    tokens: { input: 10, output: 2, reasoning: null, cacheRead: 1, cacheWrite: 0 },
    quality: "exact",
  }));
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    const report = buildUsageStatsReport({
      serverInstanceId: "dates", spaceId: "space", query: { range: "30d", timezone: "UTC" },
      observations, projects: [{ id: "project", name: "Project" }], sessions: new Map(), now,
    });
    assert.equal(report.totals.observations, observations.length);
    assert.ok(calls < observations.length + 2_000, `${calls} date conversions should cover observations plus calendar boundaries`);
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original;
  }
});

test("a report merged from stored session shares equals one built from scratch", () => {
  let seed = 41;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const start = Date.UTC(2026, 0, 1);
  const models = [["anthropic", "sonnet"], ["openai", "gpt-5"], ["claude", "sonnet"]] as const;
  const bySession = new Map<string, UsageObservation[]>();
  for (let session = 0; session < 60; session += 1) {
    const list: UsageObservation[] = [];
    let at = start + Math.floor(next() * 150 * 86_400_000);
    for (let index = 0; index < 5 + Math.floor(next() * 60); index += 1) {
      at += Math.floor(next() * 6 * 3_600_000);
      const model = models[next() < .8 ? session % 3 : Math.floor(next() * 3)]!;
      list.push({
        id: `${session}-${index}`,
        timestamp: at,
        // Session 7 spans two projects: a filter narrows it by observation.
        projectId: session === 7 ? `project-${index % 2}` : `project-${session % 4}`,
        sessionId: `session-${session}`,
        ...(next() < .9 ? { turnId: `turn-${Math.floor(index / 4)}` } : {}),
        providerId: model[0],
        modelId: model[1],
        harnessId: session % 5 === 0 ? "codex" : "claude",
        ...(session % 6 === 0 ? { agentKind: "subagent" as const } : {}),
        tokens: {
          input: Math.floor(next() * 5_000),
          output: next() < .95 ? Math.floor(next() * 900) : null,
          reasoning: null,
          cacheRead: next() < .9 ? Math.floor(next() * 40_000) : null,
          cacheWrite: next() < .9 ? Math.floor(next() * 8_000) : null,
        },
        ...(next() < .8 ? { cost: Math.floor(next() * 1_000) / 1_024 } : {}),
        ...(next() < .5 ? { timing: { totalMs: 4_000, modelMs: 2_500, toolMs: 500, ttftMs: 300 }, steps: 2, retries: 0 } : {}),
        status: next() < .9 ? "completed" : "failed",
        quality: "exact",
      });
    }
    bySession.set(`session-${session}`, list);
  }
  const sessions = new Map([...bySession.keys()].map((id) => [id, { id, title: id, status: "idle" as const }]));
  const projects = Array.from({ length: 4 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, path: `/${index}` }));
  const rollups = new Map([...bySession].map(([id, list]) => [id, createUsageSessionRollup(id, list)]));
  const queries: UsageStatsQuery[] = [
    { range: "all", timezone: "Europe/Kyiv" },
    { range: "90d", timezone: "Europe/Kyiv", detailSort: "cost", detailLimit: 7 },
    { range: "30d", timezone: "America/St_Johns", projectIds: ["project-1"] },
    { range: "all", timezone: "UTC", projectIds: ["project-0", "project-3"], detailSort: "tokens" },
    { range: "custom", from: start + 20 * 86_400_000, to: start + 70 * 86_400_000, timezone: "UTC", bucket: "week", detailSort: "turns" },
    { range: "7d", timezone: "UTC", sessionIds: ["session-3", "session-7"] },
  ];
  let now = start + 120 * 86_400_000;
  for (let round = 0; round < 4; round += 1) {
    // Each round one session gains an observation and the clock moves on; every
    // other session's share comes from the round before.
    const id = `session-${round * 9}`;
    const grown = [...bySession.get(id)!, {
      ...bySession.get(id)![0]!, id: `${id}-late-${round}`, timestamp: now - 1_000, turnId: `late-${round}`,
    }];
    bySession.set(id, grown);
    rollups.set(id, createUsageSessionRollup(id, grown));
    for (const query of queries) {
      const base = { serverInstanceId: "perf", spaceId: "space", query, projects, sessions, now };
      const build = createUsageReportBuild({ ...base, rollups: rollups.values() });
      // Prepared one session at a time, as the server does for a cold range.
      while (!build.warm(() => true)) { /* next slice */ }
      assert.deepEqual(
        build.finish(),
        buildUsageStatsReport({ ...base, observations: [...bySession.values()].flat() }),
        `round ${round} ${JSON.stringify(query)}`,
      );
    }
    now += 86_400_000 + 3_600_000;
  }
});

test("an all-time report over a large history costs a merge once its sessions are prepared", () => {
  const observations: UsageObservation[] = [];
  const start = Date.UTC(2025, 0, 1);
  for (let index = 0; index < 200_000; index += 1) {
    observations.push({
      id: `observation-${index}`,
      timestamp: start + Math.floor(index / 4_000) * 86_400_000 + (index % 4_000) * 1_000,
      projectId: `project-${index % 4_000 % 20}`,
      sessionId: `session-${index % 4_000}`,
      turnId: `turn-${Math.floor(index / 8_000)}`,
      providerId: "anthropic",
      modelId: index % 3 === 0 ? "opus" : "sonnet",
      tokens: { input: 10, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 1 },
      cost: .001,
      quality: "exact",
    });
  }
  const bySession = new Map<string, UsageObservation[]>();
  for (const observation of observations) {
    const list = bySession.get(observation.sessionId);
    if (list) list.push(observation);
    else bySession.set(observation.sessionId, [observation]);
  }
  const rollups = [...bySession].map(([id, list]) => createUsageSessionRollup(id, list));
  const sessions = new Map([...bySession.keys()].map((id) => [id, { id, title: id, status: "idle" as const }]));
  const base = { serverInstanceId: "perf", spaceId: "space", projects: [], sessions, rollups };
  const query = { range: "all", timezone: "Europe/Kyiv" } as const;
  const now = start + 60 * 86_400_000;
  const first = createUsageReportBuild({ ...base, query, now }).finish();
  assert.equal(first.totals.observations, 200_000);
  // A later clock and one changed session: 3,999 sessions are only merged.
  rollups[0] = createUsageSessionRollup(rollups[0]!.sessionId, [...rollups[0]!.observations]);
  const started = performance.now();
  const again = createUsageReportBuild({ ...base, query, now: now + 5_000 }).finish();
  const elapsed = performance.now() - started;
  assert.equal(again.totals.observations, 200_000);
  assert.deepEqual(again.totals, first.totals);
  assert.ok(elapsed < 400, `a warm all-time report took ${elapsed.toFixed(0)} ms`);
});
