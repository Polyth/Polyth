import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  UsageAnalyticsIndex,
  deriveUsageObservations,
  parseUsageAnalyticsQuery,
} from "../src/analytics.ts";

const projection = (lastTurnAt = 3_000): SessionProjection => ({
  id: "s1",
  projectId: "p1",
  title: "Usage test",
  status: "idle",
  resolvedHarnessId: "opencode",
  model: { providerID: "openai", modelID: "gpt-test" },
  createdAt: 500,
  updatedAt: lastTurnAt,
  lastTurnAt,
});

const event = (
  seq: number,
  time: number,
  type: string,
  data: Record<string, unknown> = {},
): SessionEvent => ({
  id: `e${seq}`,
  sessionId: "s1",
  seq,
  time,
  type,
  data,
}) as SessionEvent;

test("derives complete turn telemetry and leaves an incomplete tail replayable", () => {
  const events = [
    event(1, 1_000, "turn/started", {
      turnId: "t1",
      model: { providerID: "openai", modelID: "gpt-test" },
    }),
    event(2, 1_100, "assistant/chunk", { text: "a" }),
    event(3, 1_200, "tool/call", { callId: "tool-1" }),
    event(4, 1_400, "tool/result", { callId: "tool-1" }),
    event(5, 1_500, "assistant/chunk", { text: "b" }),
    event(6, 1_550, "usage/recorded", {
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5 },
      cost: 0.25,
      costSource: "derived",
    }),
    event(7, 2_000, "turn/stopped", { turnId: "t1", reason: "completed" }),
    event(8, 2_100, "turn/started", { turnId: "t2" }),
    event(9, 2_200, "usage/recorded", {
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: { input: 10, output: 4 },
    }),
  ];

  const result = deriveUsageObservations(projection(), events);
  assert.equal(result.observations.length, 1);
  assert.equal(result.safeSeq, 7);
  assert.equal(result.pending, true);

  const turn = result.observations[0]!;
  assert.equal(turn.turnDurationMs, 1_000);
  assert.equal(turn.toolTimeMs, 200);
  assert.equal(turn.modelTimeMs, 800);
  assert.equal(turn.steps, 1);
  assert.equal(turn.ttftMs, 100);
  assert.equal(turn.outputTokPerSec, 62.5);
  assert.equal(turn.wholeTurnTokPerSec, 50);
  assert.equal(turn.recordedCost, 0.25);
  assert.equal(turn.costSource, "derived");
  assert.equal(turn.cacheReadTokens, 20);
  assert.equal(turn.status, "success");
});

test("rewind markers stay replayable until the replacement turn is indexed", () => {
  const before = deriveUsageObservations(projection(2_000), [
    event(1, 1_000, "turn/started", { turnId: "t1" }),
    event(2, 1_500, "turn/stopped", { turnId: "t1", reason: "completed" }),
    event(3, 1_600, "session/rewound", { atSeq: 1 }),
  ]);
  assert.equal(before.safeSeq, 2);
  assert.equal(before.pending, false);

  const replacement = deriveUsageObservations(projection(3_000), [
    event(3, 1_600, "session/rewound", { atSeq: 1 }),
    event(4, 2_100, "turn/started", { turnId: "t2" }),
    event(5, 2_500, "turn/stopped", { turnId: "t2", reason: "completed" }),
  ], 2);
  assert.equal(replacement.safeSeq, 5);
  assert.equal(replacement.observations[0]?.regenerated, true);
});

test("persists observations as a rebuildable index and aggregates on the server", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-usage-"));
  const index = new UsageAnalyticsIndex(join(dir, "analytics.sqlite"));
  try {
    const first = deriveUsageObservations(projection(), [
      event(1, 1_000, "turn/started", {
        turnId: "t1",
        model: { providerID: "openai", modelID: "gpt-test" },
      }),
      event(2, 1_100, "assistant/chunk"),
      event(3, 1_500, "usage/recorded", {
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: { input: 100, output: 50, cacheRead: 25 },
        cost: 0.25,
      }),
      event(4, 2_000, "turn/stopped", { turnId: "t1", reason: "completed" }),
      event(5, 2_100, "turn/started", { turnId: "t2" }),
    ]);
    index.commitSync(projection(), first);
    assert.deepEqual(index.checkpoint("s1"), { lastSeq: 4, lastTurnAt: -1, pending: true });

    const second = deriveUsageObservations(projection(3_000), [
      event(5, 2_100, "turn/started", { turnId: "t2" }),
      event(6, 2_200, "assistant/chunk"),
      event(7, 2_500, "usage/recorded", {
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: { input: 40, output: 20 },
        cost: 0.1,
      }),
      event(8, 3_000, "turn/stopped", { turnId: "t2", reason: "completed" }),
    ], 4);
    index.commitSync(projection(3_000), second);
    assert.deepEqual(index.checkpoint("s1"), { lastSeq: 8, lastTurnAt: 3_000, pending: false });

    const query = parseUsageAnalyticsQuery(new URLSearchParams({
      from: "500",
      to: "4000",
      metric: "outputTokPerSec",
      groupBy: "provider",
      aggregation: "p50",
    }), 4_000);
    const data = index.query(query);
    assert.equal(data.summary.observations, 2);
    assert.equal(data.summary.sessions, 1);
    assert.equal(data.summary.recordedCost, 0.35);
    assert.equal(data.summary.costKnownTurns, 2);
    assert.equal(data.groups[0]?.id, "openai");
    assert.equal(data.groups[0]?.observations, 2);
    assert.equal(data.series[0]?.id, "openai");
    assert.equal(data.coverage.costCoverage, 1);
  } finally {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analytics query chooses production bucket/stat defaults and rejects oversized ranges", () => {
  const day = 24 * 60 * 60_000;
  const query = parseUsageAnalyticsQuery(new URLSearchParams({
    range: "24h",
    metric: "ttftMs",
    groupBy: "model",
  }), 10 * day);
  assert.equal(query.to - query.from, day);
  assert.equal(query.aggregation, "p50");
  assert.equal(query.groupBy, "model");

  assert.throws(
    () => parseUsageAnalyticsQuery(new URLSearchParams({
      from: "1",
      to: String(400 * day),
    }), 400 * day),
    /no longer than 366 days/,
  );
});
