import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionProjection } from "@polyth/contracts";
import { providerUsageDistribution } from "../widgets/usageShare.ts";

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
  const source = await readFile(new URL("../widgets/usage/UsageDashboard.tsx", import.meta.url), "utf8");
  const quota = await readFile(new URL("../src/usage/quotaUi.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/api.ts", import.meta.url), "utf8");
  const registration = await readFile(new URL("../src/packages/usage.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /function ProviderSpendDonut/);
  assert.match(source, /className="usage-spend-donut"[\s\S]*?<svg/);
  assert.match(source, /function ModelBreakdown/);
  assert.match(source, /function CostPulse/);
  assert.match(source, /aria-label=\{tr\("usage\.usagedashboard\.dashboardDensity"\)\}/);
  assert.match(source, /setUsageDashboardPrefs/);
  assert.match(source, /tr\("usage\.usagedashboard\.sessionCohortsByLatestTurn"\)/);
  assert.match(source, /tr\("usage\.usagedashboard\.eachSessionAppearsOnceInBucket"\)/);
  assert.match(source, /<table className="sr-only">/);
  assert.match(source, /<th scope="col">\{tr\("usage\.usagedashboard\.provider"\)\}<\/th>/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /className="usage-quota-alert" role="alert"/);
  assert.match(source, /className="usage-chart-empty" role="status"/);
  assert.match(source, /aria-label=\{hidden \? tr\("usage\.usagedashboard\.showValueInBreakdowns"/);
  assert.match(source, /: tr\("usage\.usagedashboard\.hideValueInBreakdowns"/);
  assert.match(source, /value > 0 && value < \.0001 \? "<\$0\.0001"/);
  assert.match(source, /const formatChartMoney[\s\S]*?value < \.001 \? 5 : value < 1 \? 4 : 2/);
  assert.match(source, /tr\("usage\.usagedashboard\.rangesUseEachSessions"\)/);
  assert.match(source, /new ResizeObserver/);
  assert.doesNotMatch(source, /role="(?:tab|radio)"/);
  assert.doesNotMatch(source, /usage-dashboard-sidebar/);
  assert.match(quota, /loading: boolean/);
  assert.match(quota, /error: string \| null/);
  assert.match(quota, /useSyncExternalStore/);
  assert.match(quota, /quotaListeners\.size === 1/);
  assert.equal(quota.match(/setInterval/g)?.length, 1, "quota polling has one shared timer");
  assert.doesNotMatch(api, /usageQuotas:[\s\S]{0,120}\.catch\(/);
  assert.match(registration, /component: UsageDashboard/);
  assert.match(registration, /id: "usage.dashboard"/);
  assert.doesNotMatch(styles, /\.settings-page-usage > \.settings-nav \{ display: flex; \}/);
  assert.match(styles, /\.settings-mobile-page \.settings-nav \{ display: none; \}/);
  assert.match(styles, /--usage-bg: var\(--bg\)/);
  assert.doesNotMatch(styles, /full dark analytics workspace/);
  assert.doesNotMatch(styles, /--usage-bg: #0d0e10/);
  assert.match(styles, /\.usage-status-pill\.session-only/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.usage-providers-card tbody tr/);
  assert.match(styles, /\.usage-spend-legend > \.usage-card-empty \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;[\s\S]*?align-self: stretch;/);
  assert.match(styles, /\.usage-spend-legend > \.usage-card-empty strong \{[\s\S]*?overflow-wrap: normal;[\s\S]*?word-break: normal;[\s\S]*?white-space: normal;/);
  assert.match(styles, /\.usage-provider-error \{[\s\S]*?padding: 9px 10px;/);
  assert.match(styles, /@media \(min-width: 701px\) and \(max-width: 760px\) \{[\s\S]*?\.usage-view-tabs \{ width: 100%; margin: 0; \}/);

  const usageMobileStart = styles.indexOf(
    "@media (max-width: 480px), (max-height: 480px) and (pointer: coarse) {",
    styles.indexOf(".usage-dashboard {"),
  );
  const usageMobileEnd = styles.indexOf("@media (prefers-reduced-motion: reduce)", usageMobileStart);
  const usageMobileStyles = styles.slice(usageMobileStart, usageMobileEnd);
  assert.match(usageMobileStyles, /\.usage-eyebrow \{ font-size: 9\.5px; letter-spacing: \.075em; line-height: 1\.35; \}/);
  assert.match(usageMobileStyles, /\.usage-spend-legend \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;[\s\S]*?max-width: none;/);
  assert.match(styles, /\.usage-view-tabs button \{ flex: 1; min-height: var\(--tap\); \}/);
  assert.match(styles, /\.usage-layout-compact \.usage-cohort-chart \{ height: 174px; \}/);
});
