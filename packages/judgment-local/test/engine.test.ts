import test from "node:test";
import assert from "node:assert/strict";
import { choice, noul, score, JudgmentExecutionError } from "@polyth/judgment";
import { createLocalJudgmentEngine, fromNative, startLocalRunner, toNativeQuestions, toNativeState } from "../src/engine.ts";

const questions = {
  done: noul("Tests were run."),
  outcome: choice("Is it complete?", { complete: "Verified.", cannot_tell: "Insufficient." }),
  tone: score("How positive?", ["negative", "neutral", "positive"]),
};
const native = { truncated: false, tokens: { total: 42 }, answers: [
  { type: "noul" as const, p: 0.2 },
  { type: "choice" as const, probs: [0.7, 0.3], pick: 0, confidence: 0.12 },
  { type: "score" as const, probs: [0.1, 0.2, 0.7], pick: 2, confidence: 0.4, score: 0.8 },
] };

test("questions and state map onto the TinyDecide request", () => {
  assert.deepEqual(toNativeQuestions(questions), [
    { type: "noul", text: "Tests were run." },
    { type: "choice", text: "Is it complete?", options: ["Verified.", "Insufficient."] },
    { type: "score", text: "How positive?", options: ["negative", "neutral", "positive"] },
  ]);
  assert.equal(toNativeState("plain"), "plain");
  assert.equal(toNativeState({ a: [1] }), '{"a":[1]}');
});

test("native answers normalize to canonical Judgment answers", () => {
  assert.deepEqual(fromNative(native, questions, "tinydecide"), {
    answers: {
      done: { type: "noul", probability: 0.2, confidence: 0.8 },
      outcome: { type: "choice", value: "complete", confidence: 0.12, probabilities: { complete: 0.7, cannot_tell: 0.3 } },
      tone: { type: "score", score: 1.6, confidence: 0.4, probabilities: [0.1, 0.2, 0.7], levelCount: 3 },
    },
    model: { providerId: "local", modelId: "tinydecide" }, usage: { inputTokens: 42, outputTokens: 0 },
  });
  const reason = (value: unknown) => { try { fromNative(value as typeof native, questions, "m"); } catch (error) { return (error as JudgmentExecutionError).reason; } };
  assert.equal(reason({ ...native, truncated: true }), "invalid-request", "cut evidence is refused, not judged");
  assert.equal(reason({ ...native, answers: native.answers.slice(1) }), "invalid-response");
  assert.equal(reason({ ...native, answers: [{ type: "noul", p: 2 }, ...native.answers.slice(1)] }), "invalid-response");
  assert.equal(reason({ ...native, answers: [native.answers[0], { ...native.answers[1], pick: 5 }, native.answers[2]] }), "invalid-response");
});

test("the engine only serves its own provider and known models", async () => {
  const engine = createLocalJudgmentEngine({ models: () => ["tinydecide", "mine"], runner: async () => { throw new Error("unused"); } });
  assert.deepEqual(engine.capabilities().defaults, { providerId: "local", modelId: "tinydecide" });
  assert.equal(engine.availability({ engineId: "local", providerId: "typesafe", modelId: "tinydecide" }), "provider-unavailable");
  assert.equal(engine.availability({ engineId: "local", providerId: "local", modelId: "other" }), "model-unavailable");
  assert.equal(engine.availability({ engineId: "local", providerId: "local", modelId: "mine" }), undefined);
});

// A stand-in for the pinned engine module: same export, same request/answer shape.
const FAKE_ENGINE = `export class TinyDecide {
  constructor(meta) { if (!meta.ok) throw new Error("bad meta"); }
  answer(req) {
    if (req.state === "spin") for (;;) {}
    if (req.state === "throw") throw new Error("too many options");
    return { truncated: false, tokens: { total: req.state.length }, ids: [1], answers: req.questions.map(() => ({ type: "noul", p: 0.25, qvec: [1], z0: [0, 0], proj: true })) };
  }
}`;
const start = (meta: unknown, onExit = () => {}) => startLocalRunner({ engineSource: FAKE_ENGINE, meta, weights: new ArrayBuffer(8) }, onExit);
const ask = (state: string) => ({ state, questions: [{ type: "noul" as const, text: "q" }] });

test("the worker answers off the main thread and strips correction vectors", async (t) => {
  const runner = start({ ok: true });
  t.after(() => runner.close());
  assert.deepEqual(await runner.answer(ask("hello"), new AbortController().signal),
    { truncated: false, tokens: { total: 5 }, answers: [{ type: "noul", p: 0.25 }] });
  await assert.rejects(runner.answer(ask("throw"), new AbortController().signal), { reason: "invalid-request" });
});

test("abort terminates a running pass; queued requests stay retryable and the runner is dropped", async () => {
  let exited = 0;
  const runner = start({ ok: true }, () => { exited++; });
  const controller = new AbortController();
  const spinning = runner.answer(ask("spin"), controller.signal);
  const queued = runner.answer(ask("later"), new AbortController().signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(spinning, { reason: "cancelled" });
  await assert.rejects(queued, (error: JudgmentExecutionError) => error.reason === "provider-error" && error.retryable);
  assert.equal(exited, 1);
  await assert.rejects(runner.answer(ask("after"), new AbortController().signal), { reason: "provider-error" });
});

test("a model that cannot load fails as model-unavailable and is dropped", async () => {
  let exited = 0;
  const runner = start({ ok: false }, () => { exited++; });
  await assert.rejects(runner.answer(ask("x"), new AbortController().signal), { reason: "model-unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exited, 1);
});
