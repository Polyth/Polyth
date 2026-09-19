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

test("Usage surface is provider-first, compact, theme-native, and progressively disclosed", async () => {
  const source = await readFile(new URL("../widgets/usage/UsageDashboard.tsx", import.meta.url), "utf8");
  const settingsSource = await readFile(new URL("../widgets/usage/UsageSettings.tsx", import.meta.url), "utf8");
  const prefsSource = await readFile(new URL("../widgets/usagePrefs.ts", import.meta.url), "utf8");
  const quota = await readFile(new URL("../widgets/usage/quotaUi.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../../session/src/webApi.ts", import.meta.url), "utf8");
  const registration = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  const settingsSync = await readFile(new URL("../../../apps/web/src/settingsSync.ts", import.meta.url), "utf8");
  const surfaceStyles = await readFile(new URL("../widgets/dashboardSurface.css", import.meta.url), "utf8");
  const coreStyles = await readFile(new URL("../../../apps/web/src/styles.css", import.meta.url), "utf8");

  assert.match(source, /import Chart from "chart\.js\/auto"/);
  assert.match(source, /function UsageTimeChart/);
  assert.match(source, /new Chart\(canvas/);
  assert.match(source, /function ProviderCard/);
  assert.match(source, /className="usage-provider-card/);
  assert.match(source, /formatQuotaReset\(window\.resetsAt\)/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /className="usage-quota-alert" role="alert"/);
  assert.match(source, /chartGrouping/);
  assert.match(source, /distributionGrouping/);
  assert.match(source, /Top consumers/);
  assert.match(source, /CustomRangePopover/);
  assert.match(source, /rangeMode: "custom"/);
  assert.doesNotMatch(source, /setProviderPinned/);
  assert.doesNotMatch(source, /DragHandleIcon|HideIcon|ShowIcon/);
  assert.doesNotMatch(source, /usage-dashboard-hero|workspaceTelemetry/);

  const tabsIndex = source.indexOf('{ id: "providers", label: "Providers" }');
  const overviewIndex = source.indexOf('{ id: "overview", label: "Overview" }');
  assert.ok(tabsIndex >= 0 && tabsIndex < overviewIndex, "Providers is the first tab");

  assert.match(settingsSource, /data-settings-item="usage\.appearance"/);
  assert.match(settingsSource, /data-settings-item="usage\.charts"/);
  assert.match(settingsSource, /data-settings-item="usage\.statistics"/);
  assert.match(settingsSource, /data-settings-item="usage\.providers"/);
  assert.match(settingsSource, /data-settings-item="usage\.costs"/);
  assert.match(settingsSource, /monthlyBudget/);
  assert.match(settingsSource, /performanceStatistic/);
  assert.match(settingsSource, /setProviderCostProfile/);

  assert.match(prefsSource, /view: "providers"/);
  assert.match(prefsSource, /layout: "compact"/);
  assert.match(prefsSource, /subscribeUsagePrefs/);
  assert.match(prefsSource, /replaceUsagePrefs/);
  assert.doesNotMatch(prefsSource, /\/api\/usage\/preferences/);
  assert.match(settingsSync, /packagePrefs:\s*packagePrefsSnapshot\(\)/);
  assert.match(settingsSync, /subscribeClientSettingsContributions\(syncContributionSubscriptions\)/);
  assert.doesNotMatch(settingsSync, /@polyth\/usage/);

  assert.match(quota, /loading: boolean/);
  assert.match(quota, /error: string \| null/);
  assert.match(quota, /useSyncExternalStore/);
  assert.match(quota, /quotaListeners\.size === 1/);
  assert.equal(quota.match(/setInterval/g)?.length, 1, "quota polling has one shared timer");
  assert.doesNotMatch(api, /usageQuotas:[\s\S]{0,120}\.catch\(/);

  assert.doesNotMatch(registration, /host\.settings\.registerPage|UsageSettings/);
  assert.match(registration, /registerClientSettingsContribution\(\{/);
  assert.match(registration, /id: "usage"/);
  assert.match(registration, /get: getUsagePrefs/);
  assert.match(registration, /subscribe: subscribeUsagePrefs/);
  assert.match(source, /import UsageSettings from "\.\/UsageSettings\.tsx"/);
  assert.match(source, /<UsageSettings \/>/);
  assert.match(registration, /host\.surfaces\.register\([\s\S]*?component: UsageDashboard/);
  assert.match(registration, /host\.widgets\.registerPlugin\(USAGE_WIDGET_PLUGIN\)/);

  assert.match(surfaceStyles, /background:\s*var\(--material-glass-medium\)/);
  assert.match(surfaceStyles, /background:\s*var\(--accent\)/);
  assert.match(surfaceStyles, /@container usage-dashboard \(max-width: 700px\)/);
  assert.match(surfaceStyles, /min-height:\s*var\(--tap\)/);
  assert.match(surfaceStyles, /env\(safe-area-inset-bottom/);
  assert.match(surfaceStyles, /prefers-reduced-motion/);
  assert.match(surfaceStyles, /body:not\(\[data-glass="off"\]\)/);
  assert.doesNotMatch(surfaceStyles, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(coreStyles, /\.settings-mobile-page \.settings-nav \{ display: none; \}/);
});
