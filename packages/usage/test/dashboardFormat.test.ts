import test from "node:test";
import assert from "node:assert/strict";
import type { QuotaWindow } from "@polyth/contracts";
import { formatAxisValue, formatMetric, formatTokens } from "../widgets/usage/dashboardFormat.ts";
import { measurableValue } from "../widgets/usage/limitsModel.ts";

test("token totals switch from millions to billions at a thousand million", () => {
  assert.equal(formatTokens(842_300_000), "842.3M");
  assert.equal(formatTokens(999_949_999), "999.9M");
  assert.equal(formatTokens(999_950_000), "1.0B");
  assert.equal(formatTokens(3_456_789_012), "3.5B");
  assert.equal(formatTokens(12_345_678_901.4), "12.3B");
});

test("a partial total keeps its lower-bound marker on the billions unit", () => {
  assert.equal(formatTokens(3_456_789_012, false), "≥3.5B");
  assert.equal(formatMetric("tokens", 2_100_000_000, false), "≥2.1B");
});

test("unknown tokens stay unknown rather than becoming zero", () => {
  assert.equal(formatTokens(null), "—");
  assert.equal(formatTokens(undefined), "—");
  assert.equal(formatTokens(0), "0");
});

test("the chart axis and its tooltips agree on the billions unit", () => {
  assert.equal(formatAxisValue("tokens", 3_000_000_000, 1_000_000_000), "3B");
  assert.equal(formatAxisValue("tokens", 500_000_000, 500_000_000), "500M");
  assert.equal(formatMetric("tokens", 3_000_000_000), "3.0B");
});

test("token limit windows report billions in the headline and the detail", () => {
  const window: QuotaWindow = { id: "monthly", label: "Monthly tokens", unit: "tokens", used: 1_500_000_000, limit: 5_000_000_000 };
  assert.deepEqual(measurableValue(window, "used"), {
    primary: "1.5B used",
    detail: "1.5B used · 5.0B limit",
  });
  assert.equal(measurableValue(window, "remaining").primary, "3.5B left");
});
