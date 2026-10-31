import test from "node:test";
import assert from "node:assert/strict";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import type { UsageObservation } from "../src/analytics/contracts.ts";

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
