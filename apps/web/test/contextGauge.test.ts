import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, contextGauge } from "../src/reduce.ts";

test("context gauge uses the latest input sample and honest unknown metadata", () => {
  assert.deepEqual(contextGauge({ contextUsage: { inputTokens: 12_000 } }), {
    known: false,
    inputTokens: 12_000,
    contextTokens: null,
    percent: null,
    level: "unknown",
  });
  assert.deepEqual(contextGauge({ contextUsage: { inputTokens: 64_000 } }, 128_000), {
    known: true,
    inputTokens: 64_000,
    contextTokens: 128_000,
    percent: 50,
    level: "green",
  });
});

test("context gauge clamps overflow and applies warning thresholds", () => {
  assert.equal(contextGauge({ contextUsage: { inputTokens: 60 } }, 100).level, "yellow");
  assert.equal(contextGauge({ contextUsage: { inputTokens: 85 } }, 100).level, "red");
  const overflow = contextGauge({ contextUsage: { inputTokens: 250 } }, 100);
  assert.equal(overflow.known && overflow.percent, 100);
});

test("usage replay tracks the latest turn input separately from lifetime totals", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`,
    sessionId: "s1",
    seq,
    time: seq,
    type,
    data,
    v: 1,
  });
  const model = buildModel([
    event("turn/started", { turnId: "t1" }),
    event("usage/recorded", {
      model: { providerID: "test", modelID: "large" },
      tokens: { input: 10_000, output: 100 },
    }),
    event("usage/recorded", {
      model: { providerID: "test", modelID: "large" },
      tokens: { input: 12_000, output: 200 },
    }),
  ]);
  assert.equal(model.totals.input, 22_000);
  assert.equal(model.contextUsage?.inputTokens, 12_000);
  assert.deepEqual(model.contextUsage?.model, { providerID: "test", modelID: "large" });
  assert.equal(contextGauge(model, 24_000).percent, 50);
});
