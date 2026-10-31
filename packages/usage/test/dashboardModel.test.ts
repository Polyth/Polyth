import test from "node:test";
import assert from "node:assert/strict";
import { axisLabelIndices, niceScale, sparklineGeometry, summarizeSeries } from "../widgets/usage/chartModel.ts";
import {
  DEFAULT_USAGE_DASHBOARD_PREFS,
  USAGE_SCOPE_BLOCKS,
  isDefaultUsageLayout,
  moveUsageBlock,
  sanitizeUsageDashboardPrefs,
  effectiveUsageView,
  sanitizeUsageLayout,
  visibleUsageBlocks,
} from "../widgets/usage/dashboardLayout.ts";

test("every scope offers its own blocks, and Project and Global both keep the harness breakdown", () => {
  assert.deepEqual(USAGE_SCOPE_BLOCKS.session, ["overview", "tokens", "cache", "timing", "turns"]);
  assert.ok(USAGE_SCOPE_BLOCKS.project.includes("harnesses"));
  assert.ok(USAGE_SCOPE_BLOCKS.global.includes("harnesses"));
  assert.ok(USAGE_SCOPE_BLOCKS.global.includes("projects"));
  assert.ok(!USAGE_SCOPE_BLOCKS.project.includes("projects"), "a single project has no project breakdown");
  for (const blocks of Object.values(USAGE_SCOPE_BLOCKS)) assert.equal(new Set(blocks).size, blocks.length);
});

test("a stored layout drops unknown blocks, collapses duplicates and slots in blocks added later", () => {
  // "tokens" and "cache" are missing (blocks a newer release added); each lands after its default predecessor.
  const layout = sanitizeUsageLayout("project", {
    order: ["sessions", "activity", "retired-block", "activity", "overview", "harnesses", "models"],
    hidden: ["models", "nope", "models"],
  });
  assert.deepEqual(layout.order, ["sessions", "activity", "tokens", "cache", "overview", "harnesses", "models"]);
  assert.deepEqual(layout.hidden, ["models"]);
  // A block whose default predecessors are all missing goes first.
  assert.deepEqual(sanitizeUsageLayout("session", { order: ["turns"] }).order, ["overview", "tokens", "cache", "timing", "turns"]);
  assert.deepEqual(sanitizeUsageLayout("global", "garbage").order, [...USAGE_SCOPE_BLOCKS.global]);
});

test("preferences sanitize ranges, metrics and every scope", () => {
  assert.deepEqual(sanitizeUsageDashboardPrefs(null), DEFAULT_USAGE_DASHBOARD_PREFS);
  const prefs = sanitizeUsageDashboardPrefs({ range: "90d", metric: "cost", layouts: { global: { order: ["models"], hidden: ["overview"] } } });
  assert.equal(prefs.range, "90d");
  assert.equal(prefs.metric, "cost");
  assert.equal(prefs.layouts.global.order[0], "overview", "missing blocks fill in around the stored ones");
  assert.deepEqual(prefs.layouts.global.hidden, ["overview"]);
  assert.deepEqual(prefs.layouts.session.order, [...USAGE_SCOPE_BLOCKS.session]);
  assert.equal(sanitizeUsageDashboardPrefs({ range: "custom", metric: "sessions" }).range, "30d");
  assert.equal(sanitizeUsageDashboardPrefs({ range: "custom", metric: "sessions" }).metric, "tokens");
});

test("the chosen tab is sanitized, and a value without one keeps the caller's tab", () => {
  assert.equal(sanitizeUsageDashboardPrefs({ view: "limits" }).view, "limits");
  assert.equal(sanitizeUsageDashboardPrefs({ view: "billing" }).view, "session");
  assert.equal(sanitizeUsageDashboardPrefs({ range: "7d" }, "global").view, "global", "an older client's mirrored value does not reset the tab");
  assert.equal(effectiveUsageView("session", null), "project", "no active session shows Project");
  assert.equal(effectiveUsageView("session", "s-1"), "session");
  assert.equal(effectiveUsageView("global", null), "global");
});

test("moving a block keeps every other block in order", () => {
  const order = [...USAGE_SCOPE_BLOCKS.project];
  assert.deepEqual(moveUsageBlock(order, "sessions", 0), ["sessions", "overview", "activity", "tokens", "cache", "harnesses", "models"]);
  assert.deepEqual(moveUsageBlock(order, "overview", 99), ["activity", "tokens", "cache", "harnesses", "models", "sessions", "overview"]);
  assert.deepEqual(moveUsageBlock(order, "activity", 1), order, "moving to its own slot is a no-op");
  assert.ok(isDefaultUsageLayout("project", { order, hidden: [] }));
  assert.ok(!isDefaultUsageLayout("project", { order, hidden: ["models"] }));
  assert.deepEqual(visibleUsageBlocks({ order, hidden: ["tokens", "models"] }), ["overview", "activity", "cache", "harnesses", "sessions"]);
});

test("axis scales land on readable steps at or above the peak", () => {
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(niceScale(97), { max: 100, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(niceScale(100), { max: 100, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(niceScale(1_234_567).max, 1_500_000);
  const cents = niceScale(0.037);
  assert.ok(cents.max >= 0.037 && cents.max <= 0.05);
  assert.ok(cents.ticks.length >= 3 && cents.ticks.length <= 6);
});

test("axis labels always include both ends and never exceed the budget", () => {
  assert.deepEqual(axisLabelIndices(0, 7), []);
  assert.deepEqual(axisLabelIndices(5, 7), [0, 1, 2, 3, 4]);
  const many = axisLabelIndices(120, 7);
  assert.equal(many.length, 7);
  assert.equal(many[0], 0);
  assert.equal(many.at(-1), 119);
});

test("series summaries skip unreported buckets instead of counting them as zero", () => {
  const summary = summarizeSeries([
    { start: 0, end: 1, value: 4, complete: true },
    { start: 1, end: 2, value: null, complete: true },
    { start: 2, end: 3, value: 10, complete: false },
    { start: 3, end: 4, value: 0, complete: true },
  ]);
  assert.equal(summary.peakIndex, 2);
  assert.equal(summary.total, 14);
  assert.equal(summary.reported, 3);
  assert.equal(summary.average, 14 / 3);
  assert.equal(summary.totalComplete, false);
  assert.equal(summarizeSeries([{ start: 0, end: 1, value: null, complete: true }]).peak, null);
});

test("a sparkline breaks at unreported samples and stays inside its box", () => {
  const geometry = sparklineGeometry([1, 3, null, 2, 4], 100, 20);
  assert.equal((geometry.line.match(/M/g) ?? []).length, 2, "one subpath per reported run");
  assert.equal((geometry.area.match(/Z/g) ?? []).length, 2);
  for (const [, x, y] of geometry.line.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
    assert.ok(Number(x) >= 0 && Number(x) <= 100);
    assert.ok(Number(y) >= 0 && Number(y) <= 20);
  }
  assert.deepEqual(geometry.last, { x: 98.5, y: 1.5 });
  assert.equal(sparklineGeometry([5], 100, 20).line, "", "one sample is not a trend");
  assert.equal(sparklineGeometry([null, null], 100, 20).line, "");
});
