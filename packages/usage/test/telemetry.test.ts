import test from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionProjection } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import { collectUsageTelemetry } from "../src/telemetry.ts";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 19, 12);
const SPACE = "spc_usage";
const PROJECT: Project = {
  id: "project-a",
  path: "/tmp/project-a",
  name: "Polyth",
  createdAt: NOW - 100 * DAY_MS,
};

async function seedTurn(input: {
  store: ReturnType<typeof createStore>;
  id: string;
  at: number;
  provider: string;
  model: string;
  harness: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cost: number;
  ttftMs: number;
  durationMs: number;
  toolMs?: number;
  reason?: "completed" | "error" | "aborted";
  spaceId?: string;
}) {
  const start = input.at - input.durationMs;
  const assistantAt = start + input.ttftMs;
  const toolStart = input.toolMs ? assistantAt + 200 : null;
  const toolEnd = toolStart === null ? null : toolStart + input.toolMs!;
  const events: Array<{
    type: string;
    data: Record<string, unknown>;
    time: number;
    ignorable?: boolean;
  }> = [
    { type: "session/created", data: { title: input.id }, time: start - 1_000 },
    {
      type: "turn/started",
      data: { turnId: `${input.id}-turn`, model: { providerID: input.provider, modelID: input.model } },
      time: start,
      ignorable: true,
    },
    {
      type: "assistant/chunk",
      data: { partId: `${input.id}-part`, text: "hello" },
      time: assistantAt,
    },
  ];
  if (toolStart !== null && toolEnd !== null) {
    events.push({
      type: "tool/started",
      data: { callId: `${input.id}-tool`, tool: "read_file", input: {} },
      time: toolStart,
    });
    events.push({
      type: "tool/result",
      data: { callId: `${input.id}-tool`, tool: "read_file", output: "ok" },
      time: toolEnd,
    });
  }
  events.push({
    type: "usage/recorded",
    data: {
      model: { providerID: input.provider, modelID: input.model },
      tokens: {
        input: input.inputTokens,
        output: input.outputTokens,
        cacheRead: input.cacheRead ?? 0,
      },
      cost: input.cost,
    },
    time: input.at - 100,
    ignorable: true,
  });
  events.push({
    type: "turn/stopped",
    data: { turnId: `${input.id}-turn`, reason: input.reason ?? "completed" },
    time: input.at,
    ignorable: true,
  });

  const projection: SessionProjection = {
    id: input.id,
    projectId: PROJECT.id,
    spaceId: input.spaceId ?? SPACE,
    title: input.id,
    status: "idle",
    model: { providerID: input.provider, modelID: input.model },
    harness: { mode: "pinned", harnessId: input.harness },
    resolvedHarnessId: input.harness,
    createdAt: start - 1_000,
    updatedAt: input.at,
    lastTurnAt: input.at,
    tokenTotals: {
      input: input.inputTokens,
      output: input.outputTokens,
      cacheRead: input.cacheRead ?? 0,
    },
    costTotal: input.cost,
  };
  await input.store.appendBatch!(input.id, events, { projection });
}

test("historical telemetry uses event time, exact range, percentiles, cache and composition", async () => {
  const store = createStore(":memory:");
  try {
    await seedTurn({
      store,
      id: "current-a",
      at: NOW - DAY_MS,
      provider: "openai",
      model: "gpt-5.6-sol",
      harness: "codex",
      inputTokens: 900,
      outputTokens: 100,
      cacheRead: 300,
      cost: .08,
      ttftMs: 500,
      durationMs: 5_000,
      toolMs: 1_000,
    });
    await seedTurn({
      store,
      id: "current-b",
      at: NOW - 2 * DAY_MS,
      provider: "openai",
      model: "gpt-5.6-sol",
      harness: "codex",
      inputTokens: 1_800,
      outputTokens: 200,
      cacheRead: 300,
      cost: .12,
      ttftMs: 1_500,
      durationMs: 5_000,
      reason: "error",
    });
    await seedTurn({
      store,
      id: "previous",
      at: NOW - 9 * DAY_MS,
      provider: "anthropic",
      model: "claude-sonnet",
      harness: "claude",
      inputTokens: 450,
      outputTokens: 50,
      cost: .04,
      ttftMs: 700,
      durationMs: 3_000,
    });
    await seedTurn({
      store,
      id: "other-space",
      at: NOW - DAY_MS,
      provider: "google",
      model: "gemini",
      harness: "opencode",
      inputTokens: 9_000,
      outputTokens: 1_000,
      cost: 9,
      ttftMs: 100,
      durationMs: 1_000,
      spaceId: "spc_other",
    });

    const telemetry = await collectUsageTelemetry({
      store,
      spaceId: SPACE,
      projects: [PROJECT],
      start: NOW - 7 * DAY_MS,
      end: NOW,
      now: NOW,
    });

    assert.equal(telemetry.partial, false);
    assert.equal(telemetry.current.totals.sessions, 2);
    assert.equal(telemetry.current.totals.requests, 2);
    assert.equal(telemetry.current.totals.effectiveTokens, 3_000);
    assert.equal(telemetry.current.totals.cost, .2);
    assert.equal(Math.round(telemetry.current.totals.cacheHitPercent!), 18);
    assert.equal(telemetry.current.totals.ttftMs?.p50, 1_000);
    assert.equal(telemetry.current.totals.ttftMs?.average, 1_000);
    assert.equal(telemetry.current.totals.errorRate, 50);
    assert.equal(telemetry.current.totals.successRate, 50);

    const openai = telemetry.current.providers.find((provider) => provider.id === "openai");
    assert.ok(openai);
    assert.equal(openai.models[0]?.label, "gpt-5.6-sol");
    assert.equal(openai.harnesses[0]?.id, "codex");
    assert.equal(openai.projects[0]?.label, "Polyth");
    assert.ok((openai.tokPerSec?.p50 ?? 0) > 0);

    assert.equal(telemetry.previous.totals.sessions, 1);
    assert.equal(telemetry.previous.providers[0]?.id, "anthropic");
    assert.equal(telemetry.monthCostByProvider.openai, .2);
    assert.equal(telemetry.monthCostByProvider.anthropic, .04);
    assert.equal(telemetry.current.providers.some((provider) => provider.id === "google"), false);

    const harnessSeries = telemetry.chart.byDimension.harness.find((series) => series.id === "codex");
    assert.ok(harnessSeries);
    assert.equal(harnessSeries.requests.reduce((sum, value) => sum + value, 0), 2);
    assert.equal(harnessSeries.errors.reduce((sum, value) => sum + value, 0), 1);
    assert.ok(harnessSeries.ttftMs.some((value) => value !== null));
  } finally {
    await store.close();
  }
});

test("tool time is excluded from output generation speed", async () => {
  const store = createStore(":memory:");
  try {
    await seedTurn({
      store,
      id: "tool-time",
      at: NOW - DAY_MS,
      provider: "openai",
      model: "gpt",
      harness: "codex",
      inputTokens: 100,
      outputTokens: 120,
      cost: .01,
      ttftMs: 500,
      durationMs: 5_000,
      toolMs: 2_000,
    });
    const telemetry = await collectUsageTelemetry({
      store,
      spaceId: SPACE,
      projects: [PROJECT],
      start: NOW - 7 * DAY_MS,
      end: NOW,
      now: NOW,
    });
    // 120 output tokens / (5s turn - 2s tool) = 40 tok/s.
    assert.ok(Math.abs((telemetry.current.totals.tokPerSec?.p50 ?? 0) - 40) < .01);
  } finally {
    await store.close();
  }
});
