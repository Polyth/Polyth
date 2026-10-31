import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HARNESS_TONES } from "../widgets/usage/harnessShare.ts";

const shell = await readFile(new URL("../widgets/usage/UsageDashboard.tsx", import.meta.url), "utf8");
const blocks = await readFile(new URL("../widgets/usage/dashboardBlocks.tsx", import.meta.url), "utf8");
const charts = await readFile(new URL("../widgets/usage/UsageCharts.tsx", import.meta.url), "utf8");
const dashboard = [shell, blocks, charts].join("\n");
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
const css = await readFile(new URL("../widgets/usageAnalytics.css", import.meta.url), "utf8");
const widgetCss = await readFile(new URL("../widgets/usageWidgets.css", import.meta.url), "utf8");
const catalog = await readFile(new URL("../widgets/catalog.ts", import.meta.url), "utf8");
const layoutPrefs = await readFile(new URL("../widgets/usage/dashboardLayout.ts", import.meta.url), "utf8");

test("Usage keeps three analytics scopes and adds one isolated Limits page", () => {
  assert.match(layoutPrefs, /type UsageLayoutScope = "session" \| "project" \| "global";/);
  assert.match(layoutPrefs, /type UsageDashboardView = UsageLayoutScope \| "limits";/);
  assert.match(shell, /type UsageView = UsageDashboardView;/);
  assert.match(dashboard, /label: tr\("usage\.session"\)/);
  assert.match(dashboard, /label: tr\("usage\.project"\)/);
  assert.match(dashboard, /label: tr\("usage\.global"\)/);
  assert.match(dashboard, /label: tr\("usage\.limits"\)/);
  assert.match(dashboard, /<LimitsView \/>/);
  assert.doesNotMatch(dashboard, /ProviderDetails|QuotaWindows|ProviderSpend|SortableBlocks|UsageSettings/);
});

test("the Usage scope toolbar leaves the pane surface visible instead of painting a band", () => {
  // The segmented tabs carry their own rounded surface. A full-width opaque
  // band under them clashed with the lighter workspace surface and had square
  // corners, so the toolbar must stay transparent and non-sticky.
  const toolbar = css.match(/\.usage-clean-toolbar \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(toolbar, "the toolbar rule should exist");
  assert.match(toolbar, /background:\s*transparent/);
  assert.doesNotMatch(toolbar, /var\(--panel\)/);
  assert.doesNotMatch(toolbar, /position:\s*sticky/);
});

test("Session scope exposes performance and cache telemetry", () => {
  for (const key of [
    "usage.context",
    "usage.modelTokens",
    "usage.cacheHit",
    "usage.response",
    "usage.wholeTurn",
    "usage.reportedCost",
    "usage.wallTime",
    "usage.modelTime",
    "usage.toolTime",
    "usage.avgTtft",
    "usage.steps",
    "usage.retries",
  ]) {
    assert.ok(dashboard.includes(`tr("${key}")`), `${key} should be rendered`);
  }
});

test("Usage motion is intentionally static and needs no chart runtime", () => {
  // Charts are static markup themed by tokens; nothing animates while live sessions update.
  assert.doesNotMatch(dashboard, /chart\.js|new Chart\(|<canvas/);
  assert.equal(manifest.dependencies?.["chart.js"], undefined);
  assert.doesNotMatch(dashboard, /useLayoutEffect|\.animate\(|requestAnimationFrame|SortableBlocks/);
  assert.match(css, /transition:\s*none\s*!important/);
  assert.match(css, /animation:\s*none\s*!important/);
  assert.doesNotMatch(css, /@keyframes|backdrop-filter/);
});

test("Project and Global scopes show harness usage as a static pie with a legend", () => {
  for (const key of [
    "usage.harnesses",
    "usage.harnessesDescription",
    "usage.harnessMetric",
    "usage.noHarnessUsage",
    "usage.unknownHarness",
  ]) {
    assert.ok(dashboard.includes(`tr("${key}")`), `${key} should be rendered`);
  }
  // One section inside the shared scoped view, so Project and Global both get it.
  assert.match(shell, /case "harnesses": return report\.harnesses \? <HarnessBreakdown harnesses=\{report\.harnesses\} \/> : null;/);
  assert.match(shell, /scope === "session" \? <SessionOverview/);
  // Static SVG resolves theme tokens in CSS; the decorative ring is hidden from assistive tech
  // because the legend list carries the same numbers as text.
  assert.match(dashboard, /<svg viewBox="0 0 100 100" aria-hidden="true"/);
  assert.match(dashboard, /<ul className="usage-clean-harness-legend" aria-label=\{tr\("usage\.harnesses"\)\}/);
  assert.doesNotMatch(dashboard, /type:\s*"(pie|doughnut)"/);
});

test("every harness tone the pie can assign is defined in the stylesheet", () => {
  assert.match(css, /\.usage-clean-harness-slice,\s*\.usage-clean-harness-swatch\s*\{\s*--usage-tone:\s*var\(--usage-harness-tone-0\)/);
  for (let tone = 1; tone <= HARNESS_TONES; tone += 1) {
    assert.ok(css.includes(`--usage-harness-tone-${tone}:`), `tone ${tone} colour`);
    assert.ok(css.includes(`[data-tone="${tone}"] { --usage-tone: var(--usage-harness-tone-${tone}); }`), `tone ${tone} selector`);
  }
  assert.ok(!css.includes(`--usage-harness-tone-${HARNESS_TONES + 1}:`), "no colour without a tone the pie can assign");
  assert.match(css, /\.usage-clean-harness-slice\s*\{[^}]*fill:\s*var\(--usage-tone\)/);
});

test("Usage widget catalog contains only scoped widgets", () => {
  assert.match(catalog, /id:\s*"usage\.session"/);
  assert.match(catalog, /id:\s*"usage\.project"/);
  assert.match(catalog, /id:\s*"usage\.global"/);
  assert.doesNotMatch(catalog, /usage\.quotas|usage\.quota-summary|usage\.sessions-table|usage\.turn/);
});

test("the Limits page keeps windows neutral and colours the fill by the chosen factor", () => {
  // A low remaining share still does not tint a whole row.
  assert.doesNotMatch(css, /\.usage-limit-window\.(warning|critical)/);
  const fill = css.match(/\.usage-limit-progress > i\s*\{([^}]*)\}/)?.[1] ?? "";
  // Green is the base of the shared heat ramp and holds through the steady budget
  // (anchors at 0.5/0.75), never the accent.
  assert.match(fill, /background:\s*var\(--green\)/);
  assert.doesNotMatch(fill, /background:\s*var\(--accent\)/);
  assert.match(fill, /var\(--usage-limit-pace\)\s*-\s*0\.5\)\s*\*\s*4/);
  assert.match(fill, /var\(--usage-limit-pace\)\s*-\s*0\.75\)\s*\*\s*4/);
  assert.match(fill, /var\(--red\)[\s\S]*var\(--amber\)[\s\S]*var\(--green\)/);
  // Static mode replaces the whole ramp with the chosen palette slot.
  assert.match(css, /\.usage-limit-window\[data-color="static"\] \.usage-limit-progress > i\s*\{[^}]*background:\s*var\(--usage-limit-color\)/);
  // Every palette slot resolves to a theme token rather than a fixed hex, in both
  // the Limits page stylesheet and the widget stylesheet.
  for (const slot of ["accent", "green", "amber", "red", "blue", "purple", "neutral"]) {
    assert.match(css, new RegExp(`--usage-bar-${slot}:\\s*var\\(--`), `missing palette slot ${slot} on the Limits page`);
    assert.match(widgetCss, new RegExp(`--usage-bar-${slot}:\\s*var\\(--`), `missing palette slot ${slot} in widgets`);
  }
  // The widget meter fill and ring arc honour the same three modes and never
  // claim green without a usable reading.
  assert.match(widgetCss, /:is\(\.usage-limits-meter, \.usage-limits-ring\)\[data-bar="static"\]\s*\{[^}]*--usage-limits-fill:\s*var\(--usage-limits-static/);
  assert.match(widgetCss, /:not\(\[data-bar-tone="none"\]\)\s*\{[^}]*--usage-limits-pace/);
  assert.match(widgetCss, /:is\(\.usage-limits-meter, \.usage-limits-ring\)\s*\{\s*--usage-limits-fill:\s*var\(--accent\)/);
  // A window without a usable reading stays neutral instead of claiming a healthy green.
  assert.match(
    css,
    /\.usage-limit-window\[data-pace="none"\]:not\(\[data-color="static"\]\) \.usage-limit-progress > i\s*\{[^}]*background:\s*var\(--accent\)/,
  );
});
