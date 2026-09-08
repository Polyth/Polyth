import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, contextGauge, contextTokensUsed } from "../src/reduce.ts";

/** A render-model shape carrying only what the gauge reads: a latest usage
 *  sample plus a (deliberately large, and ignored) lifetime input total. */
const withSample = (over: { input?: number; cacheRead?: number; cacheWrite?: number } = {}) => ({
  totals: { input: 9_999_999, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  contextUsage: {
    inputTokens: over.input ?? 0,
    cacheReadTokens: over.cacheRead ?? 0,
    cacheWriteTokens: over.cacheWrite ?? 0,
  },
});

test("context gauge measures the last request's prompt footprint, not the lifetime input total", () => {
  assert.deepEqual(contextGauge(withSample({ input: 12_000 })), {
    known: false,
    inputTokens: 12_000,
    contextTokens: null,
    percent: null,
    level: "unknown",
    quality: "unknown",
  });
  // 20k fresh + 40k cache-read + 4k cache-write = 64k resident of a 128k window.
  assert.deepEqual(contextGauge(withSample({ input: 20_000, cacheRead: 40_000, cacheWrite: 4_000 }), 128_000), {
    known: true,
    inputTokens: 64_000,
    contextTokens: 128_000,
    percent: 50,
    level: "green",
    quality: "estimated",
  });
});

test("context gauge is empty until the first usage sample arrives", () => {
  const fresh = { totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, contextUsage: null };
  assert.equal(contextTokensUsed(fresh), 0);
  assert.deepEqual(contextGauge(fresh, 128_000), {
    known: true,
    inputTokens: 0,
    contextTokens: 128_000,
    percent: 0,
    level: "green",
    quality: "estimated",
  });
});

test("context gauge clamps overflow and applies warning thresholds", () => {
  assert.equal(contextGauge(withSample({ input: 69 }), 100).level, "green");
  assert.equal(contextGauge(withSample({ input: 70 }), 100).level, "yellow");
  assert.equal(contextGauge(withSample({ input: 90 }), 100).level, "red");
  const overflow = contextGauge(withSample({ input: 250 }), 100);
  assert.equal(overflow.known && overflow.percent, 100);
});

test("explicit unknown occupancy never falls back to the last-turn heuristic", () => {
  assert.deepEqual(
    contextGauge(
      withSample({ input: 80_000, cacheRead: 20_000 }),
      200_000,
      { source: "unknown" },
    ),
    {
      known: false,
      inputTokens: 0,
      contextTokens: null,
      percent: null,
      level: "unknown",
      quality: "unknown",
    },
  );
});

test("fraction-only native occupancy uses native quality without token counts", () => {
  assert.deepEqual(
    contextGauge(withSample({ input: 80_000 }), 200_000, { source: "native", fraction: 0.72 }),
    {
      known: true,
      inputTokens: 0,
      contextTokens: 200_000,
      percent: 72,
      level: "yellow",
      quality: "native",
    },
  );
});

test("estimated vs native occupancy quality distinguishes heuristic from provider counts", () => {
  assert.deepEqual(
    contextGauge(withSample({ input: 50_000 }), 100_000, { source: "estimated", usedTokens: 50_000, limitTokens: 100_000 }),
    {
      known: true,
      inputTokens: 50_000,
      contextTokens: 100_000,
      percent: 50,
      level: "green",
      quality: "estimated",
    },
  );
  assert.deepEqual(
    contextGauge(withSample({ input: 50_000 }), 100_000, { source: "native", usedTokens: 50_000, limitTokens: 100_000 }),
    {
      known: true,
      inputTokens: 50_000,
      contextTokens: 100_000,
      percent: 50,
      level: "green",
      quality: "native",
    },
  );
});

test("incomplete native occupancy does not fall back to last-turn usage", () => {
  assert.deepEqual(
    contextGauge(
      withSample({ input: 80_000, cacheRead: 20_000 }),
      200_000,
      { source: "native", limitTokens: 200_000 },
    ),
    {
      known: false,
      inputTokens: 0,
      contextTokens: 200_000,
      percent: null,
      level: "unknown",
      quality: "unknown",
    },
  );
});

test("unknown occupancy with fraction may show percent but not last-turn heuristic tokens", () => {
  assert.deepEqual(
    contextGauge(
      withSample({ input: 80_000, cacheRead: 20_000 }),
      200_000,
      { source: "unknown", fraction: 0.72 },
    ),
    {
      known: false,
      inputTokens: 0,
      contextTokens: null,
      percent: 72,
      level: "fraction",
      quality: "fraction",
    },
  );
});

test("usage replay tracks the latest sample for context, and the running sum for lifetime totals", () => {
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
      tokens: { input: 10_000, output: 100, cacheRead: 2_000 },
    }),
    event("usage/recorded", {
      model: { providerID: "test", modelID: "large" },
      tokens: { input: 12_000, output: 200, cacheRead: 30_000, cacheWrite: 0 },
    }),
  ]);
  // Lifetime totals still accumulate every request.
  assert.equal(model.totals.input, 22_000);
  // Context accounting keeps only the newest sample's prompt footprint.
  assert.equal(model.contextUsage?.inputTokens, 12_000);
  assert.equal(model.contextUsage?.cacheReadTokens, 30_000);
  assert.deepEqual(model.contextUsage?.model, { providerID: "test", modelID: "large" });
  assert.equal(contextTokensUsed(model), 42_000);
  assert.equal(contextGauge(model, 84_000).percent, 50);
});

test("a new turn keeps the prior footprint until fresh usage lands", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const model = buildModel([
    event("turn/started", { turnId: "t1" }),
    event("usage/recorded", { model: { providerID: "test", modelID: "large" }, tokens: { input: 40_000, output: 100 } }),
    event("turn/stopped", { turnId: "t1", reason: "completed" }),
    event("turn/started", { turnId: "t2" }),
  ]);
  assert.equal(contextTokensUsed(model), 40_000);
});
