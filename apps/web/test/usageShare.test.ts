import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionProjection } from "@polyth/contracts";
import { providerUsageDistribution } from "../src/usageShare.ts";

const session = (
  id: string,
  providerID: string | undefined,
  tokens: number,
  cost = 0,
): SessionProjection => ({
  id,
  projectId: "p",
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...(providerID ? { model: { providerID, modelID: `${providerID}-model` } } : {}),
  tokenTotals: { input: tokens, output: 0 },
  costTotal: cost,
});

test("provider usage distribution groups project tokens into bounded shares", () => {
  const distribution = providerUsageDistribution([
    session("a", "anthropic", 60, .06),
    session("b", "openai", 30, .03),
    session("c", "anthropic", 10, .01),
  ]);

  assert.equal(distribution.metric, "tokens");
  assert.equal(distribution.total, 100);
  assert.deepEqual(distribution.providers.map((provider) => ({
    id: provider.providerId,
    sessions: provider.sessions,
    tokens: provider.tokens,
    share: provider.share,
  })), [
    { id: "anthropic", sessions: 2, tokens: 70, share: .7 },
    { id: "openai", sessions: 1, tokens: 30, share: .3 },
  ]);
});

test("provider usage distribution uses a human default label and session fallback", () => {
  const distribution = providerUsageDistribution([
    session("a", undefined, 0),
    session("b", "openai", 0),
  ]);

  assert.equal(distribution.metric, "sessions");
  assert.equal(distribution.total, 2);
  assert.deepEqual(distribution.providers.map(({ providerId, share }) => ({ providerId, share })), [
    { providerId: "Default", share: .5 },
    { providerId: "openai", share: .5 },
  ]);
  assert.doesNotMatch(JSON.stringify(distribution), /__default__/);
});

test("provider usage distribution clamps invalid counters before drawing shares", () => {
  const malformed = session("a", "openai", -100, Number.NaN);
  malformed.tokenTotals = { input: Number.NaN, output: -20 };
  const distribution = providerUsageDistribution([malformed, session("b", "anthropic", 25)]);
  assert.equal(distribution.metric, "tokens");
  assert.equal(distribution.total, 25);
  assert.deepEqual(distribution.providers.map(({ providerId, share }) => ({ providerId, share })), [
    { providerId: "anthropic", share: 1 },
    { providerId: "openai", share: 0 },
  ]);
});

test("Usage settings keeps the Polyth shell and offers rich dashboard views", async () => {
  const source = await readFile(new URL("../src/usage/UsageDashboard.tsx", import.meta.url), "utf8");
  const registration = await readFile(new URL("../src/packages/usage.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /function ProviderSpendDonut/);
  assert.match(source, /className="usage-spend-donut"[\s\S]*?<svg/);
  assert.match(source, /function ModelBreakdown/);
  assert.match(source, /function CostPulse/);
  assert.match(source, /aria-label="Dashboard density"/);
  assert.doesNotMatch(source, /usage-dashboard-sidebar/);
  assert.match(registration, /component: UsageDashboard/);
  assert.match(registration, /id: "usage.dashboard"/);
  assert.match(styles, /\.settings-page-usage > \.settings-nav \{ display: flex; \}/);
  assert.match(styles, /--usage-bg: var\(--bg\)/);
});
