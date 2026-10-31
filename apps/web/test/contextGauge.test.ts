import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import {
  buildModel,
  contextGauge,
  contextGaugeForTelemetry,
  contextHasSample,
  contextTelemetryNotice,
  contextTelemetryStatus,
  contextTokensUsed,
  estimatedContextTokens,
  reduceEvent,
  formatContextPercent,
  contextTone,
} from "../src/reduce.ts";

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
    quality: "estimated",
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

test("portable context estimate covers visible messages before harness usage arrives", () => {
  const messages = [
    {
      kind: "user" as const,
      id: "u1",
      eventSeq: 1,
      text: "abcd",
      time: 1,
    },
    {
      kind: "assistant" as const,
      id: "a1",
      partId: "a1",
      eventSeq: 2,
      text: "中文",
      reasoning: "é",
      finalized: true,
      time: 2,
    },
  ];
  assert.equal(estimatedContextTokens(messages), 12);
  assert.equal(contextTokensUsed({ messages }), 12);
  assert.deepEqual(contextGauge({ messages }, 100), {
    known: true,
    inputTokens: 12,
    contextTokens: 100,
    percent: 12,
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
      known: false,
      inputTokens: 0,
      contextTokens: 200_000,
      percent: 72,
      level: "fraction",
      quality: "native",
      hasTokenCount: false,
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

test("partial native occupancy stays useful without replacing it with stale usage", () => {
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
      quality: "native",
      hasTokenCount: false,
    },
  );
  assert.deepEqual(
    contextGauge(withSample({ input: 80_000 }), undefined, { source: "derived", usedTokens: 32_000 }),
    {
      known: false,
      inputTokens: 32_000,
      contextTokens: null,
      percent: null,
      level: "unknown",
      quality: "derived",
    },
  );
  assert.deepEqual(
    contextGauge({ messages: [] }, undefined, { source: "estimated", usedTokens: 0 }),
    {
      known: false,
      inputTokens: 0,
      contextTokens: null,
      percent: null,
      level: "unknown",
      quality: "estimated",
    },
  );
});

test("telemetry status does not hide model-metadata context estimates", () => {
  const reportedZero = contextGaugeForTelemetry(
    withSample(),
    200_000,
    { source: "native", usedTokens: 0, limitTokens: 200_000 },
    "reported",
  );
  assert.deepEqual(reportedZero, {
    known: true,
    inputTokens: 0,
    contextTokens: 200_000,
    percent: 0,
    level: "green",
    quality: "native",
  });
  assert.equal(contextTelemetryNotice("reported", reportedZero), undefined);

  const unsupported = contextTelemetryStatus({
    usage: { status: "unsupported" },
    context: { status: "unsupported" },
  });
  assert.equal(unsupported, "unsupported");
  const gauge = contextGaugeForTelemetry(withSample({ input: 80_000 }), 200_000, null, unsupported);
  assert.deepEqual(gauge, {
    known: true,
    inputTokens: 80_000,
    contextTokens: 200_000,
    percent: 40,
    level: "green",
    quality: "estimated",
  });
  assert.equal(contextTelemetryNotice(unsupported, gauge), undefined);

  const fresh = contextGaugeForTelemetry(
    { totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, contextUsage: null },
    200_000,
    null,
    unsupported,
  );
  assert.deepEqual(fresh, {
    known: true,
    inputTokens: 0,
    contextTokens: 200_000,
    percent: 0,
    level: "green",
    quality: "estimated",
  });
  assert.equal(contextTelemetryNotice(unsupported, fresh), undefined);

  const unsupportedWithoutModelLimit = contextGaugeForTelemetry(withSample({ input: 80_000 }), undefined, null, unsupported);
  assert.deepEqual(unsupportedWithoutModelLimit, {
    known: false,
    inputTokens: 80_000,
    contextTokens: null,
    percent: null,
    level: "unknown",
    quality: "estimated",
  });
  assert.equal(contextHasSample(unsupportedWithoutModelLimit), true);
  assert.equal(contextTelemetryNotice(unsupported, unsupportedWithoutModelLimit), undefined);

  const unsupportedWithoutAnySample = contextGaugeForTelemetry({ messages: [] }, undefined, null, unsupported);
  assert.equal(contextHasSample(unsupportedWithoutAnySample), false);
  assert.equal(contextTelemetryNotice(unsupported, unsupportedWithoutAnySample), "Context window unsupported by this harness");

  const unavailable = contextTelemetryStatus({
    usage: { status: "reported" },
    context: { status: "unavailable" },
  });
  assert.equal(unavailable, "unavailable");
  const unavailableWithModelLimit = contextGaugeForTelemetry(withSample({ input: 12_000 }), 128_000, null, unavailable);
  assert.deepEqual(unavailableWithModelLimit, {
    known: true,
    inputTokens: 12_000,
    contextTokens: 128_000,
    percent: 9,
    level: "green",
    quality: "estimated",
  });
  assert.equal(contextTelemetryNotice(unavailable, unavailableWithModelLimit), undefined);

  const unavailableWithoutModelLimit = contextGaugeForTelemetry(withSample({ input: 12_000 }), undefined, null, unavailable);
  assert.deepEqual(unavailableWithoutModelLimit, {
    known: false,
    inputTokens: 12_000,
    contextTokens: null,
    percent: null,
    level: "unknown",
    quality: "estimated",
  });
  assert.equal(contextHasSample(unavailableWithoutModelLimit), true);
  assert.equal(contextTelemetryNotice(unavailable, unavailableWithoutModelLimit), undefined);

  const freshOccupancyWithStaleStatus = contextGaugeForTelemetry(
    withSample({ input: 12_000 }),
    128_000,
    { source: "derived", usedTokens: 32_000 },
    unavailable,
  );
  assert.deepEqual(freshOccupancyWithStaleStatus, {
    known: true,
    inputTokens: 32_000,
    contextTokens: 128_000,
    percent: 25,
    level: "green",
    quality: "derived",
  });
  assert.equal(contextTelemetryNotice(unavailable, freshOccupancyWithStaleStatus), undefined);

  const unknownFraction = contextGaugeForTelemetry(
    withSample({ input: 80_000 }),
    200_000,
    { source: "unknown", fraction: 0.72 },
    unsupported,
  );
  assert.deepEqual(unknownFraction, {
    known: false,
    inputTokens: 0,
    contextTokens: null,
    percent: 72,
    level: "fraction",
    quality: "fraction",
  });
  assert.equal(contextTelemetryNotice(unsupported, unknownFraction), undefined);
  assert.equal(contextTelemetryStatus(undefined), "unknown");
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
  assert.equal(
    contextGauge(
      withSample({ input: 80_000 }),
      200_000,
      { source: "unknown", fraction: 1.15 },
    ).percent,
    100,
  );
  assert.equal(
    contextGauge(
      withSample({ input: 80_000 }),
      200_000,
      { source: "unknown", fraction: -0.05 },
    ).percent,
    0,
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

test("an aggregate usage sample counts toward totals but not the context footprint", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const model = buildModel([
    event("turn/started", { turnId: "t1" }),
    event("usage/recorded", { model: { providerID: "test", modelID: "large" }, tokens: { input: 50, output: 10, cacheRead: 40_000 } }),
    // A turn total (or its remainder) sums many requests' cache reads.
    event("usage/recorded", {
      model: { providerID: "test", modelID: "large" },
      tokens: { input: 300, output: 12, cacheRead: 9_000_000 },
      aggregate: true,
      cost: 1,
    }),
  ]);
  assert.equal(model.totals.cacheRead, 9_040_000);
  assert.equal(model.totals.cost, 1);
  assert.equal(contextTokensUsed(model), 40_050);
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

test("turn start without native usage leaves the portable estimate available", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const model = buildModel([
    event("turn/started", { turnId: "t1", model: { providerID: "test", modelID: "selected" } }),
    event("user/message", { text: "x".repeat(4_000) }),
  ]);

  assert.equal(estimatedContextTokens(model.messages), 1_004);
  assert.equal(model.contextUsage, null);
  assert.equal(contextTokensUsed(model), 1_004);
  assert.deepEqual(model.turn?.model, { providerID: "test", modelID: "selected" });
});

test("a genuine native zero remains authoritative across same-model turn start", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const model = buildModel([
    event("user/message", { text: "x".repeat(4_000) }),
    event("usage/recorded", { model: { providerID: "test", modelID: "selected" }, tokens: { input: 0 } }),
    event("turn/started", { turnId: "t1", model: { providerID: "test", modelID: "selected" } }),
  ]);

  assert.equal(contextTokensUsed(model), 0);
  assert.equal(model.contextUsage?.inputTokens, 0);
  assert.deepEqual(model.contextUsage?.model, { providerID: "test", modelID: "selected" });
});

test("a denominator-only native update does not invent a zero token sample", () => {
  const gauge = contextGauge(withSample({ input: 80_000 }), undefined, {
    source: "native", limitTokens: 128_000,
  });
  assert.equal(contextHasSample(gauge), false);
  assert.equal(gauge.percent, null);
});

for (const source of ["native", "derived"] as const) {
  test(`fraction-only ${source} occupancy never invents a zero denominator or token count`, () => {
    for (const limit of [undefined, 200_000]) {
      const gauge = contextGauge({}, limit, { source, fraction: 0.72 });
      assert.equal(gauge.known, false);
      assert.equal(gauge.contextTokens, limit ?? null);
      assert.equal(contextHasSample(gauge), false);
      assert.equal(formatContextPercent(gauge), "72%");
      assert.equal(contextTelemetryNotice("reported", gauge), undefined);
    }
  });
}

for (const boundary of ["session/compacted", "runtime/epoch-replaced"]) test(`${boundary} replay does not estimate the old transcript after live occupancy is lost`, () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const history = [
    event("user/message", { text: "x".repeat(40_000) }),
    event("usage/recorded", { tokens: { input: 90_000 } }),
    event(boundary, {}),
  ];
  const model = buildModel(history);
  assert.equal(model.messages.length, 1, "visible history remains intact");
  assert.equal(model.contextUsage, null, "pre-compaction usage is stale");
  assert.equal(contextHasSample(contextGauge(model, 128_000)), false);
  const next = event("user/message", { text: "abcd" });
  reduceEvent(model, next);
  assert.equal(contextTokensUsed(model), 5, "only visible text after compaction is estimated");
  assert.equal(contextTokensUsed(buildModel([...history, next])), 5, "reload and live reduction agree");
});

test("changing models cannot relabel the previous model's usage as the new sample", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const model = buildModel([
    event("user/message", { text: "abcd" }),
    event("turn/started", { turnId: "a", model: { providerID: "test", modelID: "large" } }),
    event("usage/recorded", { model: { providerID: "test", modelID: "large" }, tokens: { input: 90_000 } }),
    event("turn/started", { turnId: "b", model: { providerID: "test", modelID: "small" } }),
  ]);
  assert.equal(model.contextUsage, null);
  assert.equal(contextTokensUsed(model), 5);
  assert.equal(contextGauge(model, 128_000).quality, "estimated");
});

for (const changedHarness of [false, true]) {
  test(`turn start ${changedHarness ? "discards usage on harness change" : "preserves same-model and same-harness usage"}`, () => {
    let seq = 0;
    const event = (type: string, data: JsonObject): SessionEvent => ({
      id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
    });
    const ref = { providerID: "shared", modelID: "same" };
    const model = buildModel([
      event("user/message", { text: "abcd" }),
      event("turn/started", { turnId: "a", model: ref, harnessId: "original" }),
      event("usage/recorded", { tokens: { input: 90_000 } }),
    ]);
    const previousSample = model.contextUsage;
    assert.equal(previousSample?.inputTokens, 90_000);
    const occupancy = { source: "native", updatedAt: seq, usedTokens: 90_000, limitTokens: 200_000, harnessId: "original" };
    const harnessId = changedHarness ? "replacement" : "original";
    reduceEvent(model, event("turn/started", { turnId: "b", model: ref, harnessId }));

    assert.equal(model.contextUsage, changedHarness ? null : previousSample);
    const gauge = contextGauge(model, 128_000, occupancy, { model: ref, harnessId });
    assert.equal(gauge.inputTokens, changedHarness ? 5 : 90_000);
    assert.equal(gauge.contextTokens, changedHarness ? 128_000 : 200_000);
    assert.equal(gauge.quality, changedHarness ? "estimated" : "native");
  });
}

test("a pending model or harness cannot reuse another runtime's context sample", () => {
  const modelRef = { providerID: "provider", modelID: "same" };
  const model = {
    contextUsage: { ...withSample({ input: 90_000 }).contextUsage, model: modelRef, harnessId: "old" },
    messages: [{ kind: "user" as const, id: "u", eventSeq: 1, text: "abcd", time: 1 }],
  };
  const occupancy = { source: "native", usedTokens: 90_000, limitTokens: 200_000, harnessId: "old", model: modelRef };
  for (const identity of [
    { model: { ...modelRef, modelID: "new" }, harnessId: "old" },
    { model: modelRef, harnessId: "new" },
  ]) {
    const gauge = contextGauge(model, 128_000, occupancy, identity);
    assert.equal(gauge.quality, "estimated");
    assert.equal(gauge.inputTokens, 5);
    assert.equal(gauge.contextTokens, 128_000);
  }
  assert.equal(contextGauge(model, 128_000, occupancy, { model: modelRef, harnessId: "old" }).inputTokens, 90_000);
  const pendingWithoutUsage = contextGauge({ ...model, contextUsage: null }, 128_000, occupancy, {
    model: { ...modelRef, modelID: "new" }, harnessId: "old",
  });
  assert.equal(pendingWithoutUsage.inputTokens, 5, "occupancy's model fence works independently of any usage sample");
  assert.equal(pendingWithoutUsage.quality, "estimated");
});

test("stale occupancy from another harness preserves the current usage sample", () => {
  const ref = { providerID: "shared", modelID: "same" };
  const usage = { ...withSample({ input: 32_000 }).contextUsage, model: ref, harnessId: "current" };
  const model = { contextUsage: usage };
  const gauge = contextGauge(model, 128_000, {
    source: "native", usedTokens: 90_000, limitTokens: 200_000, harnessId: "old",
  }, { model: ref, harnessId: "current" });
  assert.equal(gauge.inputTokens, 32_000);
  assert.equal(gauge.contextTokens, 128_000);
  assert.equal(gauge.percent, 25);
  assert.equal(gauge.quality, "estimated");
  assert.equal(model.contextUsage, usage, "filtering is presentation-local and never mutates replay state");
});

test("stale usage from another harness preserves fresh current occupancy", () => {
  const ref = { providerID: "shared", modelID: "same" };
  for (const usageModel of [ref, { ...ref, modelID: "previous-model" }]) {
    const model = {
      contextUsage: { ...withSample({ input: 90_000 }).contextUsage, model: usageModel, harnessId: "old" },
    };
    const gauge = contextGauge(model, 128_000, {
      source: "native", usedTokens: 32_000, limitTokens: 128_000, harnessId: "current", model: ref,
    }, { model: ref, harnessId: "current" });
    assert.equal(gauge.inputTokens, 32_000);
    assert.equal(gauge.contextTokens, 128_000);
    assert.equal(gauge.percent, 25);
    assert.equal(gauge.quality, "native");
  }
});

test("compaction and model switches fence stale live occupancy but accept fresh native zero", () => {
  const model = { contextUsage: null, contextResetAt: 20, contextEstimateAfterSeq: 3, messages: [] };
  const stale = contextGauge(model, 128_000, { source: "native", updatedAt: 19, usedTokens: 90_000 });
  assert.equal(contextHasSample(stale), false);
  const fresh = contextGauge(model, 128_000, { source: "native", updatedAt: 21, usedTokens: 0 });
  assert.equal(contextHasSample(fresh), true);
  assert.equal(fresh.quality, "native");
  assert.equal(fresh.inputTokens, 0);
  assert.equal(fresh.percent, 0);
});

test("context tone warms a fraction-only window like a measured one", () => {
  const fraction = (percent: number) => ({ known: false as const, inputTokens: 0, contextTokens: null, percent, level: "fraction" as const });
  assert.equal(contextTone(fraction(40)), "green");
  assert.equal(contextTone(fraction(75)), "yellow");
  assert.equal(contextTone(fraction(95)), "red");
  assert.equal(contextTone({ known: false, inputTokens: 0, contextTokens: null, percent: null, level: "unknown" }), "unknown");
  assert.equal(contextTone({ known: true, inputTokens: 1, contextTokens: 2, percent: 50, level: "green", quality: "native" }), "green");
});

test("the model keeps the last announced context-pressure level until compaction", () => {
  let seq = 0;
  const event = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s", seq, time: seq, type, data, v: 1,
  });
  const announced = buildModel([
    event("user/message", { text: "a", contextPressure: { level: 0.5 } }),
    event("user/message", { text: "b" }),
  ]);
  assert.equal(announced.contextPressureLevel, 0.5);
  const compacted = buildModel([
    event("user/message", { text: "a", contextPressure: { level: 0.75 } }),
    event("session/compacted", {}),
  ]);
  assert.equal(compacted.contextPressureLevel, undefined);
});
