import assert from "node:assert/strict";
import test from "node:test";

import { contextWindowTelemetry, normalizeTokenUsage } from "../src/index.ts";

test("telemetry normalization preserves reported zero counters", () => {
  assert.deepEqual(normalizeTokenUsage({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("context telemetry clamps counts and derives one consistent occupancy", () => {
  assert.deepEqual(contextWindowTelemetry({
    source: "native",
    updatedAt: 123,
    usedTokens: 250,
    limitTokens: 200,
  }), {
    source: "native",
    updatedAt: 123,
    usedTokens: 250,
    limitTokens: 200,
    remainingTokens: 0,
    fraction: 1.25,
  });
});
