import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RenderMessage, TurnState } from "../../../apps/web/src/reduce.ts";
import {
  deriveTurnStats,
  unionIntervalDurationMs,
} from "../widgets/usage/turnStatsData.ts";

register("./tsxHooks.mjs", import.meta.url);

const { TurnStatsView, buildTurnStatsRows } = await import("../widgets/usage/turnStatsUi.tsx");

const assistant = (time: number, id = "a1"): RenderMessage => ({
  kind: "assistant",
  id,
  partId: id,
  eventSeq: time,
  text: "hi",
  reasoning: "",
  finalized: true,
  time,
});

const tool = (
  time: number,
  finishTime: number | undefined,
  status: "running" | "done" = "done",
  callId = "t1",
): RenderMessage => ({
  kind: "tool",
  id: callId,
  callId,
  eventSeq: time,
  tool: "read",
  input: {},
  status,
  time,
  ...(finishTime !== undefined ? { finishTime } : {}),
});

const baseTurn = (overrides: Partial<TurnState> = {}): TurnState => ({
  turnId: "turn-1",
  status: "stopped",
  startedAt: 0,
  stoppedAt: 10_000,
  usage: {
    tokens: { input: 35_900, output: 1_200, cacheRead: 24_000 },
    cost: 0,
  },
  ...overrides,
});

test("deriveTurnStats reports full turn metrics honestly", () => {
  const messages: RenderMessage[] = [
    assistant(500),
    tool(2_000, 5_000, "done", "t1"),
    tool(5_500, 8_000, "done", "t2"),
    assistant(8_200, "a2"),
  ];
  const stats = deriveTurnStats(baseTurn(), messages);
  assert.equal(stats.steps, 2);
  assert.equal(stats.toolTimeMs, 5_500);
  assert.equal(stats.modelTimeMs, 4_500);
  assert.ok(stats.avgTtftMs !== null && stats.avgTtftMs > 0);
  assert.ok(stats.responseTokPerSec !== null && stats.responseTokPerSec > 0);
  assert.ok(stats.wholeTurnTokPerSec !== null);
  assert.equal(stats.inputTokens, 35_900);
  assert.equal(stats.outputTokens, 1_200);
  assert.ok(stats.cachePercent !== null && stats.cachePercent > 35);
  assert.equal(stats.costKnown, true);
  assert.equal(stats.cost, 0);
});

test("working turn uses now for live duration and running tools", () => {
  const now = 20_000;
  const messages = [tool(1_000, undefined, "running", "t1")];
  const stats = deriveTurnStats(
    baseTurn({ status: "working", stoppedAt: undefined }),
    messages,
    now,
  );
  assert.equal(stats.toolTimeMs, 19_000);
  assert.equal(stats.modelTimeMs, 1_000);
  assert.ok(stats.wholeTurnTokPerSec !== null);
});

test("turns without a start keep timing unknown", () => {
  const stats = deriveTurnStats(baseTurn({ startedAt: undefined, stoppedAt: 10_000 }), [assistant(100)]);
  assert.equal(stats.modelTimeMs, null);
  assert.equal(stats.toolTimeMs, null);
  assert.equal(stats.avgTtftMs, null);
  assert.equal(stats.steps, null);
  assert.equal(stats.responseTokPerSec, null);
});

test("missing usage and TTFT stay unknown rather than zero", () => {
  const stats = deriveTurnStats(
    baseTurn({ usage: undefined }),
    [],
  );
  assert.equal(stats.tokensKnown, false);
  assert.equal(stats.inputTokens, null);
  assert.equal(stats.responseTokPerSec, null);
  assert.equal(stats.avgTtftMs, null);
  const rows = buildTurnStatsRows(stats, {});
  const tokens = rows.find((row) => row.id === "tokens");
  assert.match(tokens?.value ?? "", /—/);
});

test("overlapping tool intervals are unioned", () => {
  const merged = unionIntervalDurationMs([
    { start: 1_000, end: 3_000 },
    { start: 2_000, end: 4_000 },
  ]);
  assert.equal(merged, 3_000);
});

test("turn stats settings hide rows", () => {
  const stats = deriveTurnStats(baseTurn(), [assistant(100)]);
  const rows = buildTurnStatsRows(stats, { showResponseRate: false, showCost: false });
  assert.equal(rows.some((row) => row.id === "responseRate"), false);
  assert.equal(rows.some((row) => row.id === "cost"), false);
  assert.ok(rows.some((row) => row.id === "wholeTurnRate"));
});

test("turn stats view empty states", () => {
  const noTurn = renderToStaticMarkup(createElement(TurnStatsView, {
    model: { turn: null, messages: [] },
    config: {},
  }));
  assert.match(noTurn, /turnStatsAppearAfterRun|after a run/i);

  const html = renderToStaticMarkup(createElement(TurnStatsView, {
    model: { turn: baseTurn(), messages: [assistant(100)] },
    config: {},
  }));
  assert.match(html, /data-turn-stat="responseRate"/);
  assert.match(html, /tok\/s/);
});
