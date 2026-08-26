import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import type { QuotaSnapshotDto } from "@polyth/session/web-api";
import { buildUsageDashboardData } from "../widgets/usage/dashboardData.ts";

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
  assert.equal(dashboard.chart.bucketHours, 24);
  assert.equal(
    dashboard.chart.tokens.flatMap((provider) => provider.values).reduce((sum, value) => sum + value, 0),
    4_000,
  );
  assert.equal(
    dashboard.chart.sessions.flatMap((provider) => provider.values).reduce((sum, value) => sum + value, 0),
    2,
  );
  assert.deepEqual(dashboard.models.map((model) => ({
    id: model.id,
    sessions: model.sessions,
    tokens: model.tokens,
    cost: model.cost,
  })), [
    { id: "openai/openai-model", sessions: 1, tokens: 3_000, cost: .03 },
    { id: "anthropic/anthropic-model", sessions: 1, tokens: 1_000, cost: .02 },
  ]);

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
  assert.equal(dashboard.chart.bucketHours, 72);
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

test("dashboard cohorts assign each cumulative session total to latest turn once", () => {
  const dashboard = buildUsageDashboardData([
    session("older", "openai", now - 5.5 * DAY_MS, 1_000, .01),
    session("newer", "openai", now - .5 * DAY_MS, 4_000, .04),
  ], [], 7, now);

  const tokens = dashboard.chart.tokens[0]!.values;
  const costs = dashboard.chart.cost[0]!.values;
  assert.equal(tokens.filter((value) => value > 0).length, 2);
  assert.equal(tokens.reduce((sum, value) => sum + value, 0), 5_000);
  assert.equal(costs.reduce((sum, value) => sum + value, 0), .05);
  assert.ok(dashboard.chart.labels.every((label) => label.length > 0));
});

test("dashboard uses latest turn time instead of later metadata updates", () => {
  const metadataUpdated = session("metadata-update", "openai", now - .5 * DAY_MS, 2_000, .02);
  metadataUpdated.lastTurnAt = now - 8 * DAY_MS;

  const dashboard = buildUsageDashboardData([metadataUpdated], [], 7, now);
  assert.equal(dashboard.totals.sessions, 0);
  assert.equal(dashboard.providers[0]?.sessions, 0);
  assert.equal(dashboard.providers[0]?.trends.sessions?.direction, "down");
  assert.deepEqual(dashboard.chart.sessions, []);
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

test("dashboard groups model activity within canonical providers", () => {
  const one = session("one", "claude", now - DAY_MS, 1_000, .01);
  const two = session("two", "anthropic", now - DAY_MS, 2_000, .02);
  const three = session("three", "anthropic", now - DAY_MS, 500, .005);
  one.model = { providerID: "claude", modelID: "sonnet" };
  two.model = { providerID: "anthropic", modelID: "sonnet" };
  three.model = { providerID: "anthropic", modelID: "haiku" };

  const dashboard = buildUsageDashboardData([one, two, three], [], 7, now);

  assert.deepEqual(dashboard.models.map((model) => ({
    id: model.id,
    provider: model.providerLabel,
    sessions: model.sessions,
    tokens: model.tokens,
  })), [
    { id: "anthropic/sonnet", provider: "Claude", sessions: 2, tokens: 3_000 },
    { id: "anthropic/haiku", provider: "Claude", sessions: 1, tokens: 500 },
  ]);
});

test("dashboard keeps OpenCode variants distinct with accurate labels", () => {
  const dashboard = buildUsageDashboardData([
    session("go-session", "opencode-go", now - DAY_MS, 1_000, .02),
    session("zen-session", "opencode-zen", now - DAY_MS, 2_000, .03),
    session("generic-session", "opencode", now - DAY_MS, 500, .01),
  ], [], 7, now);

  assert.deepEqual(
    dashboard.providers
      .map(({ id, label }) => ({ id, label }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "opencode", label: "OpenCode" },
      { id: "opencode-go", label: "OpenCode Go" },
      { id: "opencode-zen", label: "OpenCode Zen" },
    ],
  );
});
