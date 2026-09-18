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

test("provider usage distribution resolves placeholder providers and skips unattributed sessions", () => {
  const unresolved = session("a", undefined, 0);
  unresolved.resolvedHarnessId = "claude";
  const distribution = providerUsageDistribution([
    unresolved,
    session("b", "default", 0),
    session("c", "openai", 0),
  ]);

  assert.equal(distribution.metric, "sessions");
  assert.equal(distribution.total, 2);
  assert.deepEqual(distribution.providers.map(({ providerId, share }) => ({ providerId, share })), [
    { providerId: "anthropic", share: .5 },
    { providerId: "openai", share: .5 },
  ]);
  assert.doesNotMatch(JSON.stringify(distribution), /default|Default|__default__/i);
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

test("narrow Usage summaries retain themed block surfaces", async () => {
  const styles = await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\.usage-widget-stat-grid > div\s*\{[^}]*background:\s*var\(--surface-activity\)[^}]*box-shadow:\s*var\(--material-glass-highlight\),\s*var\(--shadow-sm\)/s,
  );
  assert.match(
    styles,
    /\.provider-share-card\s*\{[^}]*border:\s*1px solid var\(--material-glass-border\)[^}]*background:\s*var\(--surface-activity\)/s,
  );
  assert.match(styles, /@container usage-dashboard \(max-width: 520px\)/);
  assert.match(styles, /\.usage-widget-stat-grid > div:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1\s*\/\s*-1;/);
});

test("Usage surface keeps the Polyth shell while settings configure presentation", async () => {
  const source = await readFile(new URL("../widgets/usage/UsageDashboard.tsx", import.meta.url), "utf8");
  const settingsSource = await readFile(new URL("../widgets/usage/UsageSettings.tsx", import.meta.url), "utf8");
  const quota = await readFile(new URL("../widgets/usage/quotaUi.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../../session/src/webApi.ts", import.meta.url), "utf8");
  const registration = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  const styles = [
    await readFile(new URL("../../../apps/web/src/styles.css", import.meta.url), "utf8"),
    await readFile(new URL("../widgets/styles.css", import.meta.url), "utf8"),
  ].join("\n");
  assert.match(source, /function ProviderSpendDonut/);
  assert.match(source, /import Chart from "chart\.js\/auto"/);
  assert.match(source, /function UsageDoughnutChart/);
  assert.match(source, /new Chart\(canvas, config\)/);
  assert.match(source, /function ModelBreakdown/);
  assert.match(source, /function CostPulse/);
  assert.match(source, /label=\{tr\("usage\.usagedashboard\.dashboardDensity"\)\}/);
  assert.match(source, /setUsageDashboardPrefs/);
  assert.match(source, /setProviderPinned/);
  assert.match(source, /formatQuotaReset\(quota\.resetsAt\)/);
  assert.doesNotMatch(source, /resetsValue", \{ date:/);
  assert.match(source, /tr\("usage\.usagedashboard\.sessionCohortsByLatestTurn"\)/);
  assert.match(source, /tr\("usage\.usagedashboard\.eachSessionAppearsOnceInBucket"\)/);
  assert.match(source, /<table className="sr-only">/);
  assert.match(source, /<th scope="col">\{tr\("usage\.usagedashboard\.provider"\)\}<\/th>/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /className="usage-quota-alert" role="alert"/);
  assert.match(source, /className="usage-chart-empty" role="status"/);
  assert.match(source, /className="usage-inline-empty" role="status"/);
  assert.match(styles, /\.usage-inline-empty\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(source, /aria-label=\{hidden \? tr\("usage\.usagedashboard\.showValueInBreakdowns"/);
  assert.match(source, /: tr\("usage\.usagedashboard\.hideValueInBreakdowns"/);
  assert.match(source, /value > 0 && value < \.0001 \? "<\$0\.0001"/);
  assert.match(source, /const formatChartMoney[\s\S]*?value < \.001 \? 5 : value < 1 \? 4 : 2/);
  assert.ok(
    source.indexOf('className="usage-provider-detail-grid"')
      < source.indexOf('className="usage-provider-view-intro"'),
    "provider summary follows the provider cards",
  );
  assert.match(source, /new ResizeObserver/);
  assert.doesNotMatch(source, /role="(?:tab|radio)"/);
  assert.doesNotMatch(source, /usage-dashboard-sidebar/);
  assert.match(quota, /loading: boolean/);
  assert.match(quota, /error: string \| null/);
  assert.match(quota, /useSyncExternalStore/);
  assert.match(quota, /quotaListeners\.size === 1/);
  assert.equal(quota.match(/setInterval/g)?.length, 1, "quota polling has one shared timer");
  assert.doesNotMatch(api, /usageQuotas:[\s\S]{0,120}\.catch\(/);
  assert.match(registration, /component: UsageSettings/);
  assert.match(registration, /host\.surfaces\.register\([\s\S]*?component: UsageDashboard/);
  assert.match(registration, /host\.widgets\.registerPlugin\(USAGE_WIDGET_PLUGIN\)/);
  assert.doesNotMatch(source, /data-settings-item="usage\.dashboard"/);
  assert.match(settingsSource, /data-settings-item="usage\.appearance"/);
  assert.match(settingsSource, /data-settings-item="usage\.charts"/);
  assert.match(settingsSource, /data-settings-item="usage\.statistics"/);
  assert.match(settingsSource, /data-settings-item="usage\.costs"/);
  assert.match(settingsSource, /setProviderCostProfile/);
  assert.match(settingsSource, /Subscription/);
  assert.doesNotMatch(styles, /\.settings-page-usage > \.settings-nav \{ display: flex; \}/);
  assert.match(styles, /\.settings-mobile-page \.settings-nav \{ display: none; \}/);
  assert.match(styles, /--usage-bg: var\(--bg\)/);
  assert.match(styles, /--usage-card-bg: color-mix\(in srgb, var\(--elevated\)/);
  assert.match(styles, /\.usage-provider-detail-card\.pinned/);
  assert.doesNotMatch(styles, /full dark analytics workspace/);
  assert.doesNotMatch(styles, /--usage-bg: #0d0e10/);
  assert.match(styles, /\.usage-status-pill\.session-only/);
  assert.match(styles, /@container usage-dashboard \(max-width: 700px\)[\s\S]*?\.usage-providers-card tbody tr/);
  assert.match(styles, /@container usage-dashboard \(max-width: 700px\)[\s\S]*?\.usage-dashboard-toolbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(styles, /@container usage-dashboard \(max-width: 700px\)[\s\S]*?\.usage-toolbar-controls\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;/);
  assert.match(styles, /\.usage-provider-error \{[\s\S]*?padding: 9px 10px;/);
  assert.match(styles, /@container usage-dashboard \(min-width: 701px\) and \(max-width: 760px\)\s*\{[\s\S]*?\.usage-view-tabs\s*\{[^}]*width:\s*100%;\s*margin:\s*0;/);

  assert.doesNotMatch(source, /usage-dashboard-hero|usage-hero-status|workspaceTelemetry/);
  const usageMobileStart = styles.indexOf(
    "@container usage-dashboard (max-width: 480px) {",
    styles.indexOf(".usage-dashboard {"),
  );
  const usageMobileEnd = styles.indexOf("@media (prefers-reduced-motion: reduce)", usageMobileStart);
  const usageMobileStyles = styles.slice(usageMobileStart, usageMobileEnd);
  assert.match(usageMobileStyles, /\.usage-spend-legend \{[\s\S]*?width: 100%;[\s\S]*?min-width: 0;[\s\S]*?max-width: none;/);
  assert.match(styles, /\.usage-view-tabs \.ui-tab\s*\{\s*flex:\s*1;\s*\}/);
  assert.match(styles, /\.usage-layout-compact \.usage-cohort-chart\s*\{\s*height:\s*150px;/);
});
