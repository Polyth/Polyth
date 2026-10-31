import test from "node:test";
import assert from "node:assert/strict";
import type { UsageChartBucket } from "../src/analytics/contracts.ts";
import { usageWidgetBars, usageWidgetCompact, usageWidgetPreferences } from "../widgets/usage/widgetPresentation.ts";

const bucket = (index: number, tokens: number | null, cost: number | null = tokens): UsageChartBucket => ({
  start: index, end: index + 1, label: `day-${index}`,
  values: { tokens, tokensComplete: tokens !== null, cost, costComplete: cost !== null, turns: 1, turnsComplete: true, sessions: 1 },
});

test("the smaller Workspace panel size of each pair is the glance; no panel size is the full card", () => {
  assert.equal(usageWidgetCompact("compact"), true);
  assert.equal(usageWidgetCompact("wide"), true, "Project's smaller size");
  for (const size of ["standard", "large", undefined, null, "huge", 3]) assert.equal(usageWidgetCompact(size), false);
});

test("widget preferences keep the session lifetime and fence unsupported scope/legacy values", () => {
  assert.equal(usageWidgetPreferences({ range: "7d" }, "session").range, "all");
  assert.equal(usageWidgetPreferences({}, "session").primary, "context");
  assert.equal(usageWidgetPreferences({ primary: "context", range: "custom", layout: "old" }, "project").primary, "tokens");
  assert.equal(usageWidgetPreferences({ range: "custom" }, "project").range, "30d");
  assert.deepEqual(usageWidgetPreferences({ primary: "cost", layout: "metrics", range: "90d", showActivity: false }, "global"), {
    primary: "cost", layout: "metrics", range: "90d", showActivity: false, showBreakdown: true,
  });
});

test("bounded activity retains every observation rather than sampling away peaks", () => {
  const source = Array.from({ length: 83 }, (_, index) => bucket(index, index === 42 ? 1_000 : 1));
  const bars = usageWidgetBars(source, "tokens");
  assert.equal(bars.length, 28);
  assert.equal(bars.reduce((sum, bar) => sum + (bar.value ?? 0), 0), 1_082);
  assert.equal(Math.max(...bars.map((bar) => bar.height)), 100);
  assert.ok(bars.every((bar) => bar.complete && bar.height >= 0 && bar.height <= 100));
  assert.ok(bars[0]!.label.startsWith("day-0"));
  assert.ok(bars.at(-1)!.label.endsWith("day-82"));
});

test("unknown activity stays unknown, partial sums stay lower bounds, and reported zero stays zero", () => {
  const source = Array.from({ length: 56 }, (_, index) => bucket(index, null));
  source[0] = bucket(0, 5);
  source[2] = bucket(2, 0);
  source[3] = bucket(3, 0);
  const bars = usageWidgetBars(source, "tokens");
  assert.deepEqual(bars[0], { label: "day-0 – day-1", value: 5, complete: false, height: 100 });
  assert.deepEqual(bars[1], { label: "day-2 – day-3", value: 0, complete: true, height: 0 });
  assert.equal(bars[2]!.value, null);
  assert.equal(bars[2]!.complete, false);
  assert.equal(bars[2]!.height, 0);
});

test("cost activity never borrows token values and malformed values cannot create invalid geometry", () => {
  const source = [bucket(0, 5, null), bucket(1, 100, 2), bucket(2, 200, Number.NaN), bucket(3, -1, Infinity)];
  assert.deepEqual(usageWidgetBars(source, "cost").map(({ value, height }) => ({ value, height })), [
    { value: null, height: 0 }, { value: 2, height: 100 }, { value: null, height: 0 }, { value: null, height: 0 },
  ]);
  assert.equal(usageWidgetBars(source, "tokens")[3]!.value, null);
  assert.deepEqual(usageWidgetBars([], "tokens"), []);
  assert.equal(usageWidgetBars([bucket(0, 0)], "tokens")[0]!.height, 0);
});
