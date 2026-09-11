import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { createGoalService, parseVerdict, STUCK_STREAK_LIMIT } from "../src/index.ts";

interface Harness {
  events: Array<{ type: string; data: JsonObject }>;
  sends: string[];
  replies: string[];
  service: ReturnType<typeof createGoalService>;
}

function harness(replies: string[]): Harness {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const sends: string[] = [];
  const service = createGoalService({
    append: async (_s, type, data) => {
      events.push({ type, data });
    },
    send: async (_s, text) => {
      sends.push(text);
    },
    complete: async () => replies.shift() ?? '{"verdict":"keep","reason":"more"}',
    now: () => 1000,
  });
  return { events, sends, replies, service };
}

const types = (h: Harness) => h.events.map((e) => e.type);

test("parseVerdict handles json, fenced json and prose", () => {
  assert.equal(parseVerdict('{"verdict":"done","reason":"ok"}').verdict, "done");
  assert.equal(parseVerdict('```json\n{"verdict":"stuck","reason":"x"}\n```').verdict, "stuck");
  assert.equal(parseVerdict("The task is DONE now").verdict, "done");
  assert.equal(parseVerdict("no idea").verdict, "keep");
});

test("attach emits goal/attached and exposes state", async () => {
  const h = harness([]);
  const state = await h.service.attach("s1", { objective: "ship it", maxContinuations: 3 });
  assert.equal(state.status, "active");
  assert.deepEqual(types(h), ["goal/attached"]);
  assert.equal(h.service.get("s1")?.objective, "ship it");
});

test("attach rejects empty objectives and non-positive or fractional limits", async () => {
  const h = harness([]);
  for (const [input, field] of [
    [{ objective: " " }, "objective"],
    [{ objective: "ship", budgetTokens: 0 }, "budgetTokens"],
    [{ objective: "ship", budgetTokens: -1 }, "budgetTokens"],
    [{ objective: "ship", maxContinuations: 0 }, "maxContinuations"],
    [{ objective: "ship", maxContinuations: 1.5 }, "maxContinuations"],
  ] as const) {
    await assert.rejects(
      () => h.service.attach("s1", input),
      (error: Error & { code?: string; field?: string }) =>
        error.code === "invalid-input" && error.field === field,
    );
  }
  assert.deepEqual(h.events, []);
  assert.equal(h.service.get("s1"), null);
});

test("keep verdict continues the session and counts continuations", async () => {
  const h = harness(['{"verdict":"keep","reason":"more work"}']);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.onTurnCompleted("s1", "did a bit");
  assert.deepEqual(types(h), ["goal/attached", "goal/audit"]);
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.get("s1")?.continuations, 1);
});

test("goal auditor retains the requester for small-model selection", async () => {
  let seenUserId: string | undefined;
  const service = createGoalService({
    append: async () => {},
    send: async () => {},
    complete: async (_sessionId, _prompt, userId) => {
      seenUserId = userId;
      return '{"verdict":"done","reason":"finished"}';
    },
  });
  await service.attach("s1", { objective: "ship it" }, "usr_test");
  await service.onTurnCompleted("s1", "done");
  assert.equal(seenUserId, "usr_test");
});

test("done verdict completes and stops continuing", async () => {
  const h = harness(['{"verdict":"done","reason":"finished"}']);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.onTurnCompleted("s1", "all done");
  assert.deepEqual(types(h), ["goal/attached", "goal/audit", "goal/completed"]);
  assert.equal(h.sends.length, 0);
  assert.equal(h.service.get("s1")?.status, "completed");
  await h.service.onTurnCompleted("s1", "again");
  assert.equal(h.sends.length, 0);
});

test("stuck only after three consecutive stuck verdicts", async () => {
  const stuck = '{"verdict":"stuck","reason":"blocked"}';
  const h = harness([stuck, stuck, stuck]);
  await h.service.attach("s1", { objective: "ship it" });
  for (let i = 0; i < STUCK_STREAK_LIMIT; i++) await h.service.onTurnCompleted("s1", "hmm");
  assert.equal(h.sends.length, 0);
  assert.equal(types(h).filter((t) => t === "goal/stuck").length, 1);
  assert.equal(h.service.get("s1")?.status, "stuck");
});

test("a keep verdict resets the stuck streak", async () => {
  const h = harness([
    '{"verdict":"stuck","reason":"x"}',
    '{"verdict":"stuck","reason":"x"}',
    '{"verdict":"keep","reason":"progress"}',
    '{"verdict":"stuck","reason":"x"}',
  ]);
  await h.service.attach("s1", { objective: "ship it" });
  for (let i = 0; i < 4; i++) await h.service.onTurnCompleted("s1", "hmm");
  assert.equal(h.service.get("s1")?.status, "active");
  assert.equal(types(h).includes("goal/stuck"), false);
});

test("continuation limit and token budget stop the loop", async () => {
  const keep = '{"verdict":"keep","reason":"more"}';
  const h = harness([keep, keep]);
  await h.service.attach("s1", { objective: "ship it", maxContinuations: 1 });
  await h.service.onTurnCompleted("s1", "step 1");
  await h.service.onTurnCompleted("s1", "step 2");
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.get("s1")?.status, "stuck");

  const h2 = harness([keep]);
  await h2.service.attach("s2", { objective: "ship it", budgetTokens: 100 });
  h2.service.recordUsage("s2", { input: 90, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  await h2.service.onTurnCompleted("s2", "step 1");
  assert.equal(h2.sends.length, 0);
  assert.equal(h2.service.get("s2")?.lastReason, "token budget exhausted");
});

test("auditor failure is treated as stuck, never as silent continuation", async () => {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const sends: string[] = [];
  const service = createGoalService({
    append: async (_s, type, data) => void events.push({ type, data }),
    send: async (_s, t) => void sends.push(t),
    complete: async () => {
      throw new Error("provider down");
    },
  });
  await service.attach("s1", { objective: "ship it" });
  await service.onTurnCompleted("s1", "reply");
  assert.equal(sends.length, 0);
  assert.equal(service.get("s1")?.lastVerdict, "stuck");
});

test("pause blocks continuation, resume re-enables it", async () => {
  const h = harness(['{"verdict":"keep","reason":"more"}', '{"verdict":"keep","reason":"more"}']);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.pause("s1");
  await h.service.onTurnCompleted("s1", "reply");
  assert.equal(h.sends.length, 0);
  await h.service.resume("s1");
  await h.service.onTurnCompleted("s1", "reply");
  assert.equal(h.sends.length, 1);
  assert.ok(types(h).includes("goal/paused") && types(h).includes("goal/resumed"));
});

test("rehydrate rebuilds goal state from the durable log", async () => {
  const h = harness(['{"verdict":"keep","reason":"more"}']);
  await h.service.attach("s1", { objective: "ship it", maxContinuations: 5 });
  await h.service.onTurnCompleted("s1", "reply");
  const log: SessionEvent[] = h.events.map((e, i) => ({
    id: `e${i}`,
    sessionId: "s1",
    seq: i + 1,
    time: 1000 + i,
    type: e.type,
    data: e.data,
    v: 1,
  }));

  const fresh = harness([]);
  const state = fresh.service.rehydrate("s1", log);
  assert.equal(state?.objective, "ship it");
  assert.equal(state?.status, "active");
  assert.equal(state?.continuations, 1);
  assert.equal(fresh.service.get("s1")?.maxContinuations, 5);
});

test("rehydrate treats context-restored markers as audit-only", () => {
  const log: SessionEvent[] = [
    {
      id: "e1", sessionId: "s1", seq: 1, time: 1000, type: "goal/attached",
      data: {
        objective: "ship it", status: "active", continuations: 0,
        maxContinuations: 5, tokensUsed: 0, budgetTokens: 1000, updatedAt: 900,
      },
      v: 1,
    },
    {
      id: "e2", sessionId: "s1", seq: 2, time: 2000, type: "goal/context-restored",
      data: { compactionSeq: 8, sourceMessageSeq: 9 },
      ignorable: true, v: 1,
    },
  ];
  const fresh = harness([]);
  const state = fresh.service.rehydrate("s1", log);
  assert.equal(state?.status, "active");
  assert.equal(state?.objective, "ship it");
  assert.equal(state?.updatedAt, 900, "recovery audit does not mutate workflow state");
});

test("stop removes the goal and emits goal/stopped", async () => {
  const h = harness([]);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.stop("s1");
  assert.equal(h.service.get("s1"), null);
  assert.ok(types(h).includes("goal/stopped"));
});
