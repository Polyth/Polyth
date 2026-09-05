import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, contextGauge } from "../src/reduce.ts";

test("context gauge uses complete session input totals and honest unknown metadata", () => {
  assert.deepEqual(contextGauge({ totals: { input: 12_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }), {
    known: false,
    inputTokens: 12_000,
    contextTokens: null,
    percent: null,
    level: "unknown",
  });
  assert.deepEqual(contextGauge({ totals: { input: 64_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, 128_000), {
    known: true,
    inputTokens: 64_000,
    contextTokens: 128_000,
    percent: 50,
    level: "green",
  });
});

test("context gauge clamps overflow and applies warning thresholds", () => {
  const model = (input: number) => ({ totals: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  assert.equal(contextGauge(model(69), 100).level, "green");
  assert.equal(contextGauge(model(70), 100).level, "yellow");
  assert.equal(contextGauge(model(90), 100).level, "red");
  const overflow = contextGauge(model(250), 100);
  assert.equal(overflow.known && overflow.percent, 100);
});

test("usage replay uses complete session input for context accounting", () => {
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
  assert.equal(contextGauge(model, 24_000).percent, 92);
});
