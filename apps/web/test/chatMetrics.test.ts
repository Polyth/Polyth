import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);
const { formatMetricDuration } = await import("../src/components/ChatMetrics.tsx");

test("chat metric duration stays zero-padded across hour boundaries", () => {
  assert.equal(formatMetricDuration(0), "00:00:00");
  assert.equal(formatMetricDuration(12 * 60_000 + 37_000), "00:12:37");
  assert.equal(formatMetricDuration(3_661_000), "01:01:01");
  assert.equal(formatMetricDuration(-1), "00:00:00");
});
