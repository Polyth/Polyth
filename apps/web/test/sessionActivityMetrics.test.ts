import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { setLocale } from "../src/i18n/index.ts";
import { fmtTokens } from "../src/format.ts";
import type { ContextGauge, RenderModel, Totals } from "../src/reduce.ts";
import { contextGauge, emptyModel, formatContextPercent } from "../src/reduce.ts";
import { contextUsageLabel, latestRequestExcerpt, reportedSessionUsage, sessionDurationMs, sessionMessageCounts } from "../src/sessionMetrics.ts";

const ZERO: Totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const usageEvent = (data: Record<string, unknown>) => ({ type: "usage/recorded", data }) as SessionEvent;
const session = { createdAt: 1_000 } as SessionProjection;
const model = (messages: Array<Record<string, unknown>>, turn: Record<string, unknown> | null = null) =>
  ({ messages, turn, version: 1 }) as unknown as Pick<RenderModel, "messages" | "turn" | "version">;

test("latest request excerpt stays a request, includes later lines, and never invents a recap", () => {
  assert.equal(latestRequestExcerpt(undefined), "");
  assert.equal(latestRequestExcerpt("  Fix the panel.\nThen run the tests.  "), "Fix the panel. Then run the tests.");
  assert.equal(latestRequestExcerpt("a".repeat(200)).length, 180);
  assert.ok(latestRequestExcerpt("a".repeat(200)).endsWith("…"));
});

test("session duration spans all messages, ticks live, freezes on stop, and omits empty data", () => {
  assert.equal(sessionDurationMs(session, model([]), 99_000), null);
  assert.equal(sessionDurationMs(null, model([{ kind: "user", time: 2_000 }]), 99_000), null);
  const messages = [
    { kind: "user", time: 2_000 },
    { kind: "assistant", time: 3_000, completedAt: 6_500 },
  ];
  assert.equal(sessionDurationMs(session, model(messages, { status: "stopped", startedAt: 5_000, stoppedAt: 7_000 }), 99_000), 5_000);
  assert.equal(sessionDurationMs(session, model(messages, { status: "working", startedAt: 7_000 }), 10_000), 8_000);
  assert.equal(sessionDurationMs(session, model(messages, { status: "working", startedAt: 7_000 }), 11_000), 9_000);
  assert.equal(sessionDurationMs(session, model(messages, { status: "stopped", stoppedAt: 8_000 }), 99_000), 6_000);
});

test("unchanged message bounds are shared between second ticks and invalidated by model version", () => {
  let reads = 0;
  const assistant = { kind: "assistant", time: 3_000, completedAt: 5_000 };
  const messages = [
    { kind: "user", get time() { reads++; return 2_000; } },
    assistant,
  ];
  const live = model(messages, { status: "working", startedAt: 4_000 });
  assert.equal(sessionDurationMs(session, live, 8_000), 6_000);
  const firstReads = reads;
  assert.ok(firstReads > 0);
  assert.deepEqual(sessionMessageCounts(live), { all: 2, visible: 2 });
  assert.equal(reads, firstReads, "message count reuses the duration's history pass");
  assert.equal(sessionDurationMs(session, live, 9_000), 7_000);
  assert.equal(reads, firstReads, "a one-second tick does not rescan messages");
  assistant.completedAt = 12_000;
  live.version += 1;
  assert.equal(sessionDurationMs(session, live, 9_000), 10_000);
  assert.ok(reads > firstReads, "an event-derived model change refreshes bounds");
  const updatedReads = reads;
  assert.deepEqual(sessionMessageCounts(live), { all: 2, visible: 2 });
  assert.equal(reads, updatedReads, "message count also avoids the second-tick scan");
});

test("message counts preserve undone semantics and refresh on model revision", () => {
  const user = { kind: "user", time: 1_000, undone: true };
  const messages = [user, { kind: "assistant", time: 2_000 }];
  const current = model(messages);
  assert.deepEqual(sessionMessageCounts(current), { all: 2, visible: 1 });
  user.undone = false;
  current.version++;
  assert.deepEqual(sessionMessageCounts(current), { all: 2, visible: 2 });
});

test("reported context fraction without a token limit is shown rather than unavailable", () => {
  const fraction = contextGauge(emptyModel(), undefined, { source: "derived", fraction: 0.64, updatedAt: 1 });
  assert.equal(contextUsageLabel(fraction, "64%", undefined, "Unavailable", String), "64%");
  assert.equal(contextUsageLabel(null, null, undefined, "Unavailable", String), "Unavailable");
  const bounded = contextGauge(emptyModel(), undefined, { source: "derived", usedTokens: 32, limitTokens: 128, updatedAt: 1 });
  assert.equal(contextUsageLabel(bounded, "25%", undefined, "Unavailable", String), "32 / 128");
});

test("activity context keeps partial counts, estimated labels, and unknown token counts distinct", () => {
  const label = (gauge: ContextGauge) => contextUsageLabel(gauge, formatContextPercent(gauge), undefined, "Unavailable", String);
  const current = emptyModel();
  assert.equal(label(contextGauge(current, undefined, { source: "native", usedTokens: 32000, updatedAt: 1 })), "32000 tokens observed; window limit unavailable");
  assert.equal(label(contextGauge(current, undefined, { source: "native", usedTokens: 0, updatedAt: 1 })), "0 tokens observed; window limit unavailable");
  assert.equal(label(contextGauge(current, undefined, { source: "estimated", usedTokens: 32000, updatedAt: 1 })), "~32000 tokens observed; window limit unavailable");
  assert.equal(label(contextGauge(current, undefined, { source: "estimated", usedTokens: 32000, limitTokens: 128000, updatedAt: 1 })), "~32000 / 128000");
  for (const source of ["native", "derived"] as const) {
    assert.equal(label(contextGauge(current, 128000, { source, fraction: 0.64, updatedAt: 1 })), "64%", "a fraction alone never supplies a token count");
  }
  assert.equal(label(contextGauge(current, undefined, { source: "native", limitTokens: 128000, updatedAt: 1 })), "Unavailable");
});

test("estimated unknown-window activity label renders Ukrainian copy with locale formatting", async () => {
  await setLocale("uk");
  try {
    const sample = contextGauge(emptyModel(), undefined, {
      source: "estimated", usedTokens: 11_500_000, updatedAt: 1,
    });
    assert.equal(
      contextUsageLabel(sample, null, undefined, "Unavailable", fmtTokens),
      "Зафіксовано ~11,5M токенів; ліміт вікна недоступний",
    );
  } finally {
    await setLocale("en");
  }
});

test("missing usage is unavailable; a reported zero is zero; cache read and write stay distinct", () => {
  assert.deepEqual(reportedSessionUsage(ZERO, undefined), {
    tokens: null, input: null, output: null, cacheRead: null, cacheWrite: null, cost: null,
  });
  assert.deepEqual(reportedSessionUsage(ZERO, [usageEvent({ tokens: { input: 0, output: 0 }, cost: 0 })]), {
    tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  });
  assert.equal(reportedSessionUsage(ZERO, [usageEvent({ tokens: { input: 0, output: 0 } })]).cost, null);
  assert.equal(reportedSessionUsage(ZERO, [usageEvent({ cost: 0 })]).tokens, null);
  const totals = { input: 10, output: 4, reasoning: 2, cacheRead: 7, cacheWrite: 3, cost: 0.02 };
  assert.deepEqual(reportedSessionUsage(totals, undefined), {
    tokens: 16, input: 10, output: 4, cacheRead: 7, cacheWrite: 3, cost: 0.02,
  });
});
