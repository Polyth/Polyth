// Where a permission judge's answer leaves a request (pure): the verdict and
// its safety follow the judge's own fire rule for every question type, for
// judges that approve, deny or both.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, requestVerdict } from "../src/custom.ts";
import { validateJudgeInput, type JudgeDefinition, type JudgeEffect, type JudgeQuestion } from "../src/types.ts";

const judge = (question: JudgeQuestion, effects: JudgeEffect[], fire = { threshold: 0.8, margin: 0.3 }): JudgeDefinition => ({
  id: "j0123456789ab", name: "Approvals", enabled: true, trigger: "permission-requested", filters: {},
  evidence: [{ pick: "permission-request", maxChars: 600 }], question, fire, effects, dailyCap: 40, createdAt: 1, updatedAt: 1 });
const choice = (labels: string[]): JudgeQuestion => ({ type: "choice", text: "Safe?", labels: labels.map((label) => ({ label, description: label })) });
const answer = (value: unknown) => ({ ok: true, answers: { answer: value } }) as unknown as Parameters<typeof evaluate>[1];
const choiceOf = (probabilities: Record<string, number>) => {
  const value = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return answer({ type: "choice", value, confidence: 0.9, probabilities });
};
const verdictOf = (definition: JudgeDefinition, result: Parameters<typeof evaluate>[1]) => requestVerdict(definition, evaluate(definition, result));

test("a choice judge approves exactly when its approving answer runs; a confident other answer advises against", () => {
  const safeOrUnsure = judge(choice(["safe", "unsure"]), [{ kind: "approve-request", when: "safe" }]);
  assert.deepEqual(verdictOf(safeOrUnsure, choiceOf({ safe: 0.9, unsure: 0.1 })), { verdict: "approve", safety: 0.9, label: "safe", probability: 0.9 });
  // Under the threshold, or a close call: the judge did not approve, and says how safe it found it.
  assert.equal(verdictOf(safeOrUnsure, choiceOf({ safe: 0.75, unsure: 0.25 }))?.verdict, "unsure");
  assert.equal(verdictOf(safeOrUnsure, choiceOf({ unsure: 0.6, safe: 0.4 }))?.verdict, "unsure");
  assert.deepEqual(verdictOf(safeOrUnsure, choiceOf({ unsure: 0.92, safe: 0.08 })), { verdict: "against", safety: 0.08, label: "unsure", probability: 0.92 });
  // The fire rule and the verdict agree: an approve verdict is exactly an answer that runs the approval.
  for (const safe of [0.05, 0.3, 0.5, 0.64, 0.66, 0.79, 0.8, 0.95]) {
    const result = choiceOf({ safe, unsure: 1 - safe });
    const runs = evaluate(safeOrUnsure, result).actions.some((action) => action.kind === "approve-request");
    assert.equal(verdictOf(safeOrUnsure, result)?.verdict === "approve", runs, `safe ${safe}`);
  }

  // Several approving answers share the safety; Full access counts as approving, Auto-Approve does not.
  const graded = judge(choice(["safe", "fine", "risky"]), [{ kind: "approve-request", when: "safe" }, { kind: "set-approval", level: "all", when: "fine" },
    { kind: "set-approval", level: "on", when: "risky" }]);
  const mixed = verdictOf(graded, choiceOf({ safe: 0.45, fine: 0.35, risky: 0.2 }))!;
  assert.equal(mixed.verdict, "unsure"); assert.ok(Math.abs(mixed.safety - 0.8) < 1e-9);
  assert.equal(verdictOf(graded, choiceOf({ fine: 0.9, safe: 0.05, risky: 0.05 }))?.verdict, "approve");
  assert.equal(verdictOf(graded, choiceOf({ risky: 0.9, safe: 0.05, fine: 0.05 }))?.verdict, "against");
});

test("yes/no and score judges read their chance as the safety", () => {
  const yesNo = judge({ type: "noul", text: "Safe?" }, [{ kind: "approve-request" }]);
  const noul = (probability: number) => answer({ type: "noul", probability, confidence: 0.9 });
  assert.deepEqual(verdictOf(yesNo, noul(0.95)), { verdict: "approve", safety: 0.95, label: "yes", probability: 0.95 });
  assert.equal(verdictOf(yesNo, noul(0.6))?.verdict, "unsure");
  assert.deepEqual(verdictOf(yesNo, noul(0.1)), { verdict: "against", safety: 0.1, label: "no", probability: 0.9 });

  const scored = judge({ type: "score", text: "How safe?", rubric: ["dangerous", "risky", "fine", "safe", "routine"] }, [{ kind: "approve-request" }],
    { threshold: 0.75, margin: 0 });
  const level = (score: number) => answer({ type: "score", score, levelCount: 5, confidence: 0.9 });
  assert.equal(verdictOf(scored, level(4))?.verdict, "approve");
  assert.equal(verdictOf(scored, level(2))?.verdict, "unsure");
  assert.deepEqual(verdictOf(scored, level(0)), { verdict: "against", safety: 0, label: "level 1 of 5", probability: 0 });
});

test("a judge that denies: deny exactly when the denial runs, no objection when it is sure the other way", () => {
  // Approve the safe, deny the dangerous: a confident answer between them only advises.
  const gate = judge(choice(["safe", "unsure", "dangerous"]), [{ kind: "approve-request", when: "safe" }, { kind: "deny-request", when: "dangerous" }]);
  assert.deepEqual(verdictOf(gate, choiceOf({ dangerous: 0.9, unsure: 0.06, safe: 0.04 })), { verdict: "deny", safety: 0.04, label: "dangerous", probability: 0.9 });
  assert.equal(verdictOf(gate, choiceOf({ safe: 0.9, unsure: 0.06, dangerous: 0.04 }))?.verdict, "approve");
  assert.equal(verdictOf(gate, choiceOf({ unsure: 0.9, safe: 0.06, dangerous: 0.04 }))?.verdict, "against");
  assert.equal(verdictOf(gate, choiceOf({ dangerous: 0.6, unsure: 0.3, safe: 0.1 }))?.verdict, "unsure", "a close call denies nothing");
  // The fire rule and the verdict agree for the denial too.
  for (const dangerous of [0.05, 0.4, 0.62, 0.79, 0.8, 0.86, 0.97]) {
    const result = choiceOf({ dangerous, unsure: (1 - dangerous) * 0.7, safe: (1 - dangerous) * 0.3 });
    const runs = evaluate(gate, result).actions.some((action) => action.kind === "deny-request");
    assert.equal(verdictOf(gate, result)?.verdict === "deny", runs, `dangerous ${dangerous}`);
  }

  // A judge that can only deny cannot approve: a confident other answer is "no objection", and the safety is what it does not deny.
  const brakes = judge(choice(["fine", "dangerous"]), [{ kind: "deny-request", when: "dangerous" }]);
  assert.deepEqual(verdictOf(brakes, choiceOf({ fine: 0.9, dangerous: 0.1 })), { verdict: "clear", safety: 0.9, label: "fine", probability: 0.9 });
  assert.equal(verdictOf(brakes, choiceOf({ dangerous: 0.95, fine: 0.05 }))?.verdict, "deny");
  assert.equal(verdictOf(brakes, choiceOf({ dangerous: 0.7, fine: 0.3 }))?.verdict, "unsure");

  // Yes/no and score judges deny when they fire: their question asks about danger, so the safety is the other side.
  const danger = judge({ type: "noul", text: "Is this dangerous?" }, [{ kind: "deny-request" }]);
  const noul = (probability: number) => answer({ type: "noul", probability, confidence: 0.9 });
  const denied = verdictOf(danger, noul(0.95))!;
  assert.deepEqual({ ...denied, safety: 0 }, { verdict: "deny", safety: 0, label: "yes", probability: 0.95 });
  assert.ok(Math.abs(denied.safety - 0.05) < 1e-9);
  assert.equal(evaluate(danger, noul(0.95)).actions[0]?.kind, "deny-request");
  assert.equal(verdictOf(danger, noul(0.05))?.verdict, "clear");
  assert.equal(verdictOf(danger, noul(0.6))?.verdict, "unsure");
  const risk = judge({ type: "score", text: "How risky?", rubric: ["none", "low", "high"] }, [{ kind: "deny-request" }], { threshold: 0.9, margin: 0 });
  const level = (score: number) => answer({ type: "score", score, levelCount: 3, confidence: 0.9 });
  assert.equal(verdictOf(risk, level(2))?.verdict, "deny");
  assert.deepEqual(verdictOf(risk, level(0)), { verdict: "clear", safety: 1, label: "level 1 of 3", probability: 0 });
  assert.equal(verdictOf(risk, level(1))?.verdict, "unsure");
});

test("one answer either lets the request through or denies it", () => {
  const input = (question: JudgeQuestion, effects: JudgeEffect[]) => ({ name: "Gate", enabled: true, trigger: "permission-requested",
    evidence: [{ pick: "permission-request", maxChars: 600 }], question, fire: { threshold: 0.8, margin: 0.3 }, effects, dailyCap: 40 });
  const three = choice(["safe", "unsure", "dangerous"]);
  assert.doesNotThrow(() => validateJudgeInput(input(three, [{ kind: "approve-request", when: "safe" }, { kind: "deny-request", when: "dangerous" },
    { kind: "set-approval", level: "off", when: "dangerous" }])));
  assert.throws(() => validateJudgeInput(input(three, [{ kind: "approve-request", when: "safe" }, { kind: "deny-request", when: "safe" }])), /cannot both allow and deny/);
  assert.throws(() => validateJudgeInput(input(three, [{ kind: "set-approval", level: "all", when: "unsure" }, { kind: "deny-request", when: "unsure" }])), /cannot both allow and deny/);
  assert.throws(() => validateJudgeInput(input({ type: "noul", text: "Safe?" }, [{ kind: "approve-request" }, { kind: "deny-request" }])), /use a choice/);
  assert.throws(() => validateJudgeInput({ ...input(three, [{ kind: "deny-request", when: "dangerous" }]), trigger: "turn-completed",
    evidence: [{ pick: "last-answer", maxChars: 600 }] }), /not available for this trigger/);
  // Auto-Approve on or off may sit beside a denial; only Full access answers with Allow.
  assert.doesNotThrow(() => validateJudgeInput(input({ type: "noul", text: "Dangerous?" }, [{ kind: "deny-request" }, { kind: "set-approval", level: "on" }])));
});

test("no verdict without an answer, or for a judge with nothing that approves or denies", () => {
  const safeOrUnsure = judge(choice(["safe", "unsure"]), [{ kind: "approve-request", when: "safe" }]);
  assert.equal(requestVerdict(safeOrUnsure, evaluate(safeOrUnsure, { ok: false, reason: "timeout" } as never)), undefined);
  const flagOnly = judge(choice(["risky", "fine"]), [{ kind: "needs-attention" }, { kind: "set-approval", level: "on", when: "fine" }]);
  assert.equal(verdictOf(flagOnly, choiceOf({ fine: 0.9, risky: 0.1 })), undefined);
});
