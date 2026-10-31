import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@polyth/contracts";
import { createJudgmentRuntime, resolveUseState } from "@polyth/judgment";
import { createFakeJudgmentEngine } from "@polyth/judgment/testing";
import { createMultirunService, type RubricScorer } from "../src/index.ts";
import { scoreMultirunAnswers, type RubricJudgmentPort } from "../src/scoring.ts";
import {
  DEFAULT_CRITERIA,
  DEFAULT_RUBRIC,
  INVALID_RUBRIC_NOTE,
  MULTIRUN_RUBRIC_SCORE_SCOPE,
  formatScore,
  multirunRubricScoreUse,
  parseRubric,
} from "../src/rubric.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

interface ScriptedAnswer { score: number; confidence: number }

/** A fake Judgment service: one fresh fake engine/runtime per judge call. */
function scriptedPort(
  scripted: ScriptedAnswer[],
  options: { enabled?: boolean; params?: Record<string, string | number | boolean> } = {},
) {
  const engines: ReturnType<typeof createFakeJudgmentEngine>[] = [];
  let created = 0;
  const port: RubricJudgmentPort = {
    resolveUse: async (useId) => {
      assert.equal(useId, "multirun.rubric-score");
      return {
        enabled: options.enabled ?? true,
        params: {
          rubric: DEFAULT_RUBRIC,
          criteria: "correctness, completeness",
          maxAnswerChars: 6000,
          fusionTopK: 0,
          ...(options.params ?? {}),
        },
      };
    },
    createRun: async () => {
      const answer = scripted[created];
      created += 1;
      const engine = createFakeJudgmentEngine({
        answers: answer ? { score: { type: "score", score: answer.score, confidence: answer.confidence, levelCount: 5 } } : {},
      });
      engines.push(engine);
      return createJudgmentRuntime({ engines: [engine] });
    },
  };
  return { port, engines, created: () => created };
}

test("the use descriptor declares the rubric scoring contract", () => {
  const use = multirunRubricScoreUse();
  assert.equal(use.id, "multirun.rubric-score");
  assert.equal(use.packageId, "multirun");
  assert.equal(use.scope, MULTIRUN_RUBRIC_SCORE_SCOPE);
  assert.equal(use.scope, "multirun.rubric-score.v1");
  assert.equal(use.evidence, "long");
  assert.equal(use.defaultEnabled, false);
  assert.deepEqual(use.params.map((param) => param.id), ["rubric", "criteria", "maxAnswerChars", "fusionTopK"]);
  const off = resolveUseState(use, use.id, undefined, undefined);
  assert.equal(off.enabled, false);
  assert.equal(off.params.rubric, DEFAULT_RUBRIC);
  assert.equal(off.params.criteria, DEFAULT_CRITERIA);
  assert.equal(off.params.maxAnswerChars, 6000);
  assert.equal(off.params.fusionTopK, 0);
  const on = resolveUseState(use, use.id,
    { enabled: true, uses: { [use.id]: { enabled: true, params: { fusionTopK: 3 } } } }, undefined);
  assert.equal(on.enabled, true);
  assert.equal(on.params.fusionTopK, 3);
});

test("parseRubric keeps 2–8 non-empty trimmed lines and rejects the rest", () => {
  assert.deepEqual(parseRubric(" a \n\n b \n"), ["a", "b"]);
  assert.equal(parseRubric("only one"), null);
  assert.equal(parseRubric(Array.from({ length: 9 }, (_, i) => `level ${i}`).join("\n")), null);
  assert.equal(parseRubric(""), null);
});

test("formatScore shows the score, its maximum and confidence", () => {
  assert.equal(formatScore(3.4, 5, 0.82), "3.4 / 4 · 82%");
  assert.equal(formatScore(0, 5, 1), "0.0 / 4 · 100%");
  assert.equal(formatScore(2, 3, 0.5), "2.0 / 2 · 50%");
});

test("scoreMultirunAnswers records a continuous score and confidence per answer", async () => {
  const { port, created } = scriptedPort([{ score: 3.4, confidence: 0.82 }, { score: 1.25, confidence: 0.5 }]);
  const outcomes = await scoreMultirunAnswers(port, {
    sessionId: "s1",
    prompt: "Explain X",
    answers: [{ runId: "r1", output: "answer one" }, { runId: "r2", output: "answer two" }],
  });
  assert.deepEqual(outcomes, [
    { runId: "r1", score: 3.4, levels: 5, confidence: 0.82, fusionTopK: 0 },
    { runId: "r2", score: 1.25, levels: 5, confidence: 0.5, fusionTopK: 0 },
  ]);
  assert.equal(created(), 2);
});

test("scoring bounds the prompt and the answer tail before judging", async () => {
  const { port, engines } = scriptedPort([{ score: 2, confidence: 0.7 }], { params: { maxAnswerChars: 1000 } });
  await scoreMultirunAnswers(port, {
    sessionId: "s1",
    prompt: "p".repeat(5000),
    answers: [{ runId: "r1", output: "x".repeat(5000) }],
  });
  const state = engines[0]!.calls[0]!.state as { prompt: string; answer: string; criteria: string };
  assert.equal(state.prompt.length, 2000);
  assert.equal(state.answer.length, 1000);
  assert.equal(state.criteria, "correctness, completeness");
});

test("an invalid rubric is skipped with a visible note and no judgment calls", async () => {
  const { port, created } = scriptedPort([{ score: 3, confidence: 0.9 }], { params: { rubric: "just one level" } });
  const outcomes = await scoreMultirunAnswers(port, {
    sessionId: "s1",
    prompt: "hi",
    answers: [{ runId: "r1", output: "answer" }],
  });
  assert.deepEqual(outcomes, [{ runId: "r1", note: INVALID_RUBRIC_NOTE }]);
  assert.equal(created(), 0);
});

test("a disabled use produces no scores", async () => {
  const { port, created } = scriptedPort([{ score: 3, confidence: 0.9 }], { enabled: false });
  assert.deepEqual(await scoreMultirunAnswers(port, {
    sessionId: "s1",
    prompt: "hi",
    answers: [{ runId: "r1", output: "answer" }],
  }), []);
  assert.equal(created(), 0);
});

test("a judgment failure yields no score and no note", async () => {
  const { port } = scriptedPort([{ score: 3, confidence: 0.9 }]);
  // An empty answer map fails response validation: the result is not ok.
  const broken: RubricJudgmentPort = {
    resolveUse: port.resolveUse,
    createRun: async () => createJudgmentRuntime({ engines: [createFakeJudgmentEngine({ answers: {} })] }),
  };
  assert.deepEqual(await scoreMultirunAnswers(broken, {
    sessionId: "s1",
    prompt: "hi",
    answers: [{ runId: "r1", output: "answer" }],
  }), [{ runId: "r1" }]);
});

test("a scored multirun persists score fields and run-scored events before completion", async () => {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const scorer: RubricScorer = async ({ answers }) =>
    answers.map((answer, index) => ({
      runId: answer.runId,
      score: index === 0 ? 3.4 : 2,
      levels: 5,
      confidence: index === 0 ? 0.82 : 0.5,
    }));
  const service = createMultirunService({
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
    },
    runOne: async (_ctx, onUpdate) => onUpdate({ status: "completed", output: "answer" }),
    scoreAnswers: scorer,
    now: () => 1000,
  });
  const { id } = await service.start("s1", { text: "hello", runs: [{}, {}] });
  await flush();
  await flush();
  await flush();
  const state = service.get(id)!;
  assert.equal(state.scoring, false);
  assert.deepEqual(
    state.runs.map((run) => [run.score, run.scoreLevels, run.scoreConfidence]),
    [[3.4, 5, 0.82], [2, 5, 0.5]],
  );
  const scored = events.filter((event) => event.type === "multirun/run-scored");
  assert.equal(scored.length, 2);
  assert.equal(scored[0]!.data.status, "scored");
  assert.ok(
    events.findIndex((event) => event.type === "multirun/completed")
      > events.findIndex((event) => event.type === "multirun/run-scored"),
  );
});

test("without a scorer the multirun keeps today's behavior", async () => {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const service = createMultirunService({
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
    },
    runOne: async (_ctx, onUpdate) => onUpdate({ status: "completed", output: "answer" }),
    now: () => 1000,
  });
  const { id } = await service.start("s1", { text: "hello", runs: [{}] });
  await flush();
  await flush();
  const state = service.get(id)!;
  assert.equal(state.runs[0]!.score, undefined);
  assert.equal(state.scoring, undefined);
  assert.equal(events.some((event) => event.type === "multirun/run-scored"), false);
  assert.equal(service.snapshot(state).scoring, undefined);
});

test("a skipped rubric surfaces its note on the run", async () => {
  const scorer: RubricScorer = async ({ answers }) =>
    answers.map((answer) => ({ runId: answer.runId, note: INVALID_RUBRIC_NOTE }));
  const events: Array<{ type: string; data: JsonObject }> = [];
  const service = createMultirunService({
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
    },
    runOne: async (_ctx, onUpdate) => onUpdate({ status: "completed", output: "answer" }),
    scoreAnswers: scorer,
  });
  const { id } = await service.start("s1", { text: "hello", runs: [{}] });
  await flush();
  await flush();
  assert.equal(service.get(id)!.runs[0]!.scoreNote, INVALID_RUBRIC_NOTE);
  const scored = events.find((event) => event.type === "multirun/run-scored");
  assert.equal(scored?.data.status, "skipped");
});
