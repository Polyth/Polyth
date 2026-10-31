import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@polyth/contracts";
import { resolveUseState, type JudgmentRequest, type JudgmentResult, type JudgmentRuntime } from "@polyth/judgment";
import type { JudgmentService, JudgmentUseState } from "@polyth/judgment/server";
import {
  createGoalJudgmentAudit,
  createGoalService,
  GOAL_AUDIT_SCOPE,
  GOAL_AUDIT_USE,
  goalAuditState,
  goalAuditVerdict,
  STUCK_STREAK_LIMIT,
  type GoalAuditJudgment,
} from "../src/index.ts";

const timing = { startedAt: 0, completedAt: 1, durationMs: 1 };
const params = { doneThreshold: 0.8, stuckThreshold: 0.7, minMargin: 0.2 };

function answers(p: { progressing: number; stuck: number; done: number }, progress: number): JudgmentResult<never> {
  const value = (Object.keys(p) as Array<keyof typeof p>).reduce((a, b) => p[b] > p[a] ? b : a);
  return {
    ok: true, engine: { id: "fake" }, timing, attempts: 1,
    answers: {
      status: { type: "choice", value, confidence: 0.9, probabilities: p },
      progress: { type: "score", score: progress, confidence: 0.9, levelCount: 5 },
    } as never,
  };
}

function fakeJudgment(results: Array<JudgmentResult<never> | Error>, use: Partial<JudgmentUseState> = {}) {
  const calls: Array<JudgmentRequest<never>> = [];
  let disposed = 0;
  const base = resolveUseState(GOAL_AUDIT_USE, GOAL_AUDIT_USE.id, { enabled: true, uses: { [GOAL_AUDIT_USE.id]: { enabled: true } } }, undefined);
  const service: JudgmentService = {
    registerEngine: () => () => {},
    registerUse: () => () => {},
    resolveUse: async () => ({ ...base, ...use }),
    createRun: async () => ({
      judge: async (request: JudgmentRequest<never>) => {
        calls.push(request);
        const next = results.shift() ?? answers({ progressing: 1, stuck: 0, done: 0 }, 1);
        if (next instanceof Error) throw next;
        return next;
      },
      dispose: () => { disposed++; },
    }) as unknown as JudgmentRuntime,
  };
  return { service, calls, disposed: () => disposed };
}

const judgeWith = (service: JudgmentService | undefined) =>
  createGoalJudgmentAudit({ judgment: () => service, context: async () => ({ space: { spaceId: "s" } as never, projectId: "p" }) });

function harness(judge: ReturnType<typeof judgeWith>, replies: string[] = []) {
  const events: Array<{ type: string; data: JsonObject }> = [];
  let oneShots = 0;
  const service = createGoalService({
    append: async (_s, type, data) => { events.push({ type, data }); },
    send: async () => {},
    complete: async () => { oneShots++; return replies.shift() ?? '{"verdict":"keep","reason":"more"}'; },
    judge,
    now: () => 1000,
  });
  return { events, service, oneShots: () => oneShots };
}

const judgment = (p: { progressing: number; stuck: number; done: number }, progress = 2): GoalAuditJudgment => {
  const sorted = Object.values(p).sort((a, b) => b - a);
  return { probabilities: p, margin: sorted[0]! - sorted[1]!, progress, progressLevels: 5 };
};

test("descriptor is opt-in with the documented defaults", () => {
  assert.equal(GOAL_AUDIT_USE.id, "goals.audit");
  assert.equal(GOAL_AUDIT_USE.scope, "goals.audit.v1");
  assert.equal(GOAL_AUDIT_USE.defaultEnabled, false);
  const state = resolveUseState(GOAL_AUDIT_USE, GOAL_AUDIT_USE.id, { enabled: true }, undefined);
  assert.equal(state.enabled, false);
  assert.deepEqual(state.params, { doneThreshold: 0.8, stuckThreshold: 0.7, minMargin: 0.2 });
});

test("policy: done needs the threshold and a clear lead; uncertainty keeps working", () => {
  assert.equal(goalAuditVerdict(judgment({ progressing: 0.1, stuck: 0.05, done: 0.85 }, 4), params).verdict, "done");
  assert.equal(goalAuditVerdict(judgment({ progressing: 0.25, stuck: 0, done: 0.75 }), params).verdict, "keep");
  // At the threshold but without a clear lead (a low user threshold).
  assert.equal(goalAuditVerdict(judgment({ progressing: 0.45, stuck: 0, done: 0.55 }), { ...params, doneThreshold: 0.5 }).verdict, "keep");
  assert.equal(goalAuditVerdict(judgment({ progressing: 0.2, stuck: 0.75, done: 0.05 }), params).verdict, "stuck");
  assert.equal(goalAuditVerdict(judgment({ progressing: 0.35, stuck: 0.65, done: 0 }), params).verdict, "keep");
  assert.match(goalAuditVerdict(judgment({ progressing: 0.1, stuck: 0.05, done: 0.85 }, 3.5), params).reason, /done 85% · progress 3.5\/4/);
});

test("a confident done completes the goal and records probabilities and progress", async () => {
  const fake = fakeJudgment([answers({ progressing: 0.08, stuck: 0.02, done: 0.9 }, 3.8)]);
  const h = harness(judgeWith(fake.service));
  await h.service.attach("s1", { objective: "ship the toggle" });
  await h.service.onTurnCompleted("s1", "Implemented and verified the toggle.");
  assert.equal(h.oneShots(), 0);
  assert.equal(fake.calls[0]!.scope, GOAL_AUDIT_SCOPE);
  assert.equal(fake.disposed(), 1);
  const audit = h.events.find((event) => event.type === "goal/audit")!;
  assert.equal(audit.data.verdict, "done");
  assert.deepEqual(audit.data.judgment, { probabilities: { progressing: 0.08, stuck: 0.02, done: 0.9 }, margin: 0.82, progress: 3.8, progressLevels: 5 });
  assert.equal(audit.data.lastProgress, 0.95);
  assert.equal(h.events.at(-1)!.type, "goal/completed");
  // Replay restores the progress.
  const replay = harness(judgeWith(undefined));
  const state = replay.service.rehydrate("s1", h.events.map((event, i) => ({ id: String(i), sessionId: "s1", seq: i + 1, time: 1, type: event.type, data: event.data, v: 1 })));
  assert.equal(state?.lastProgress, 0.95);
});

test("an unclear done continues as progressing", async () => {
  const fake = fakeJudgment([answers({ progressing: 0.3, stuck: 0, done: 0.7 }, 3)]);
  const h = harness(judgeWith(fake.service));
  await h.service.attach("s1", { objective: "ship" });
  await h.service.onTurnCompleted("s1", "Maybe done.");
  const audit = h.events.find((event) => event.type === "goal/audit")!;
  assert.equal(audit.data.verdict, "keep");
  assert.equal(h.service.get("s1")?.status, "active");
  assert.equal(h.service.get("s1")?.continuations, 1);
});

test("confident stuck answers take the existing stuck path", async () => {
  const stuck = () => answers({ progressing: 0.1, stuck: 0.85, done: 0.05 }, 1);
  const fake = fakeJudgment(Array.from({ length: STUCK_STREAK_LIMIT }, stuck));
  const h = harness(judgeWith(fake.service));
  await h.service.attach("s1", { objective: "ship" });
  for (let i = 0; i < STUCK_STREAK_LIMIT; i++) await h.service.onTurnCompleted("s1", `blocked ${i}`);
  assert.equal(h.events.at(-1)!.type, "goal/stuck");
  assert.equal(h.service.get("s1")?.status, "stuck");
  assert.equal(h.oneShots(), 0);
});

test("failure, errors, an off use or no Judgment fall back to the original audit", async () => {
  const cases = [
    fakeJudgment([{ ok: false, reason: "timeout", retryable: true, timing, attempts: 1 }]).service,
    fakeJudgment([new Error("boom")]).service,
    fakeJudgment([], { enabled: false, reason: "use-off" }).service,
    undefined,
  ];
  for (const service of cases) {
    const h = harness(judgeWith(service), ['{"verdict":"done","reason":"auditor says so"}']);
    await h.service.attach("s1", { objective: "ship" });
    await h.service.onTurnCompleted("s1", "done");
    assert.equal(h.oneShots(), 1);
    const audit = h.events.find((event) => event.type === "goal/audit")!;
    assert.equal(audit.data.reason, "auditor says so");
    assert.equal(audit.data.judgment, undefined);
    assert.equal(audit.data.lastProgress, undefined);
  }
});

test("evidence is bounded", () => {
  const state = goalAuditState({ objective: "o".repeat(10_000), reply: `${"r".repeat(20_000)}END` }) as { objective: string; latestReply: string };
  assert.ok(state.objective.length <= 4_001);
  assert.ok(state.latestReply.length <= 8_001 && state.latestReply.endsWith("END"));
});
