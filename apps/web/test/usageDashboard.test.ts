import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import type { QuotaSnapshotDto } from "../src/api.ts";
import { buildUsageDashboardData } from "../src/usage/dashboardData.ts";

const DAY_MS = 24 * 60 * 60_000;
const now = Date.UTC(2026, 7, 23, 12);

const session = (
  id: string,
  providerID: string,
  updatedAt: number,
  tokens: number,
  cost: number,
): SessionProjection => ({
  id,
  projectId: "project",
  title: id,
  status: "idle",
  createdAt: updatedAt,
  updatedAt,
  model: { providerID, modelID: `${providerID}-model` },
  tokenTotals: { input: tokens, output: 0 },
  costTotal: cost,
});

const anthropicQuota: QuotaSnapshotDto = {
  providerId: "anthropic",
  accountLabel: "Team",
  fetchedAt: now,
  stale: false,
  pace: {},
  windows: [
    { id: "weekly", label: "Weekly tokens", used: 75, limit: 100, unit: "tokens" },
  ],
};

test("dashboard derives current-period totals, trends, and provider quota health", () => {
  const dashboard = buildUsageDashboardData([
    session("current-claude", "anthropic", now - DAY_MS, 1_000, .02),
    session("current-openai", "openai", now - 2 * DAY_MS, 3_000, .03),
    session("previous-claude", "anthropic", now - 9 * DAY_MS, 500, .01),
  ], [anthropicQuota], 7, now);

  assert.deepEqual(dashboard.totals, {
    sessions: 2,
    tokens: 4_000,
    cost: .05,
    averageCostPerThousand: .0125,
  });
  assert.equal(Math.round(dashboard.trends.cost!.percent), 400);
  assert.equal(dashboard.trends.averageCostPerThousand!.direction, "down");
  assert.equal(dashboard.chart.labels.length, 7);
  assert.equal(
    dashboard.chart.tokens.flatMap((provider) => provider.values).reduce((sum, value) => sum + value, 0),
    4_000,
  );

  const claude = dashboard.providers.find((provider) => provider.id === "anthropic");
  assert.equal(claude?.label, "Claude");
  assert.equal(claude?.remainingPercent, 25);
  assert.equal(claude?.stale, false);
});

test("dashboard keeps configured providers visible without fabricating activity", () => {
  const dashboard = buildUsageDashboardData([], [{
    ...anthropicQuota,
    providerId: "openrouter",
    stale: true,
    windows: [],
  }], 30, now);

  assert.equal(dashboard.totals.sessions, 0);
  assert.equal(dashboard.trends.tokens, null);
  assert.deepEqual(dashboard.chart.tokens, []);
  assert.deepEqual(dashboard.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    remaining: provider.remainingPercent,
    stale: provider.stale,
  })), [{
    id: "openrouter",
    label: "OpenRouter",
    remaining: null,
    stale: true,
  }]);
});

test("dashboard merges provider aliases used by sessions and quota adapters", () => {
  const dashboard = buildUsageDashboardData([
    session("claude-session", "anthropic", now - DAY_MS, 1_000, .02),
  ], [{
    ...anthropicQuota,
    providerId: "claude",
  }], 7, now);

  assert.equal(dashboard.providers.length, 1);
  assert.equal(dashboard.providers[0]?.id, "anthropic");
  assert.equal(dashboard.providers[0]?.label, "Claude");
  assert.equal(dashboard.providers[0]?.snapshot?.providerId, "claude");
  assert.equal(dashboard.providers[0]?.remainingPercent, 25);
});
