// The widget translates `validateJudgeInput`'s English messages. This test
// feeds the real validator a broad set of invalid judges and proves every
// message it produces is recognised, so a future server-side rule cannot slip
// through as raw English.
import test from "node:test";
import assert from "node:assert/strict";
import { validateJudgeInput, type JudgeInput } from "../src/types.ts";
import { judgeErrorMessage } from "../widgets/judgeErrors.ts";

type Params = Record<string, string | number>;

/** A visible sentinel per catalog key, with its interpolation values. */
const translate = (key: string, params?: Params) =>
  `⟦${key}⟧${params ? Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(";") : ""}`;

const valid: JudgeInput = {
  name: "Judge",
  enabled: true,
  trigger: "turn-completed",
  filters: {},
  evidence: [{ pick: "last-request", maxChars: 600 }],
  question: { type: "noul", text: "Is the work finished?" },
  fire: { threshold: 0.7, margin: 0.2 },
  effects: [{ kind: "timeline-marker" }],
  dailyCap: 40,
};

const choice = {
  type: "choice" as const,
  text: "How did it go?",
  labels: [{ label: "yes", description: "Done." }, { label: "no", description: "Not done." }],
};
const route = { type: "route" as const, text: "Which model?" };
const permission = {
  ...valid,
  trigger: "permission-requested" as const,
  evidence: [{ pick: "permission-request" as const, maxChars: 600 }],
};
const limit = {
  ...valid,
  trigger: "limit-reached" as const,
  question: route,
  effects: [{ kind: "switch-route" as const }],
  routes: ["harness::provider/model"],
};

const cases: Array<[string, unknown]> = [
  ["not a record", null],
  ["extra top-level field", { ...valid, extra: true }],
  ["empty name", { ...valid, name: "" }],
  ["non-boolean enabled", { ...valid, enabled: "yes" }],
  ["unknown trigger", { ...valid, trigger: "later" }],
  ["non-record filters", { ...valid, filters: "now" }],
  ["unknown filter field", { ...valid, filters: { other: "x" } }],
  ["invalid project filter", { ...valid, filters: { projectId: "ü" } }],
  ["no evidence", { ...valid, evidence: [] }],
  ["evidence not a record", { ...valid, evidence: [null] }],
  ["unknown evidence pick", { ...valid, evidence: [{ pick: "nope", maxChars: 600 }] }],
  ["evidence not allowed for trigger", { ...valid, evidence: [{ pick: "permission-request", maxChars: 600 }] }],
  ["extra evidence field", { ...valid, evidence: [{ pick: "last-request", maxChars: 600, extra: 1 }] }],
  ["evidence too short", { ...valid, evidence: [{ pick: "last-request", maxChars: 5 }] }],
  ["permission judge without the request", { ...permission, evidence: [{ pick: "last-request", maxChars: 600 }] }],
  ["non-record question", { ...valid, question: null }],
  ["limit judge without a route question", { ...limit, question: { type: "noul", text: "Which?" } }],
  ["non-limit route question", { ...valid, question: route }],
  ["extra question field", { ...valid, question: { type: "noul", text: "Done?", extra: 1 } }],
  ["choice with one answer", { ...valid, question: { ...choice, labels: [choice.labels[0]] } }],
  ["answer not a record", { ...valid, question: { ...choice, labels: [choice.labels[0], null] } }],
  ["extra answer field", { ...valid, question: { ...choice, labels: [choice.labels[0], { ...choice.labels[1], extra: 1 }] } }],
  ["invalid answer name", { ...valid, question: { ...choice, labels: [{ label: "Yes!", description: "A" }, choice.labels[1]] } }],
  ["duplicate answer names", { ...valid, question: { ...choice, labels: [choice.labels[0], { ...choice.labels[1], label: "yes" }] } }],
  ["score with one level", { ...valid, question: { type: "score", text: "Score?", rubric: ["Only"] } }],
  ["unknown question type", { ...valid, question: { type: "essay", text: "Write" } }],
  ["non-record fire", { ...valid, fire: null }],
  ["extra fire field", { ...valid, fire: { ...valid.fire, extra: 1 } }],
  ["threshold out of range", { ...valid, fire: { ...valid.fire, threshold: 2 } }],
  ["margin out of range", { ...valid, fire: { ...valid.fire, margin: -1 } }],
  ["label on a yes/no question", { ...valid, fire: { ...valid.fire, label: "yes" } }],
  ["fire label not an answer", { ...valid, question: choice, fire: { ...valid.fire, label: "maybe" } }],
  ["no effects", { ...valid, effects: [] }],
  ["unknown effect kind", { ...valid, effects: [{ kind: "explode" }] }],
  ["effect not allowed for trigger", { ...valid, effects: [{ kind: "switch-route" }] }],
  ["extra effect field", { ...valid, effects: [{ kind: "timeline-marker", extra: 1 }] }],
  ["action tied to an answer on a yes/no judge", { ...valid, effects: [{ kind: "send-message", text: "Go", when: "yes" }] }],
  ["repeated effect", { ...valid, effects: [{ kind: "timeline-marker" }, { kind: "timeline-marker" }] }],
  ["invalid approval level", { ...valid, effects: [{ kind: "set-approval", level: "maybe" }] }],
  ["answer both allows and denies", { ...permission, question: choice, fire: { ...valid.fire, label: "yes" },
    effects: [{ kind: "approve-request", when: "yes" }, { kind: "deny-request", when: "yes" }] }],
  ["judge both allows and denies", { ...permission, effects: [{ kind: "approve-request" }, { kind: "deny-request" }] }],
  ["limit judge without switching", { ...limit, effects: [{ kind: "timeline-marker" }] }],
  ["limit judge without routes", { ...limit, routes: [] }],
  ["invalid route", { ...limit, routes: ["not-a-route"] }],
  ["repeated route", { ...limit, routes: ["harness::provider/model", "harness::provider/model"] }],
  ["routes on a non-limit judge", { ...valid, routes: ["harness::provider/model"] }],
  ["invalid model", { ...valid, model: "not-a-route" }],
  ["messages in a row out of range", { ...valid, maxRounds: 0 }],
  ["daily limit out of range", { ...valid, dailyCap: 5_000 }],
];

test("a valid judge is accepted by the real validator", () => {
  assert.doesNotThrow(() => validateJudgeInput(valid));
  assert.doesNotThrow(() => validateJudgeInput(permission));
  assert.doesNotThrow(() => validateJudgeInput(limit));
});

test("every validation message the widget can receive is translated", () => {
  assert.ok(cases.length >= 40);
  for (const [name, input] of cases) {
    let message: string | undefined;
    try { validateJudgeInput(input); }
    catch (cause) { message = cause instanceof Error ? cause.message : String(cause); }
    assert.ok(message, `${name} is rejected`);
    const localized = judgeErrorMessage(message, translate);
    assert.ok(localized.includes("judgesui.validation."), `${name}: "${message}" is recognised as ${localized}`);
    assert.notEqual(localized, message, `${name}: "${message}" is not shown raw`);
    assert.equal(localized.includes("{"), false, `${name}: no placeholder is left in "${localized}"`);
  }
});

test("field labels and evidence/effect names are passed through the translator", () => {
  let seen: { key?: string; params?: Params } = {};
  const record = (key: string, params?: Params) => { seen = { key, params }; return key; };

  judgeErrorMessage("Name must be 1–80 characters", record);
  assert.equal(seen.key, "judgesui.validation.textRange");
  assert.equal(seen.params?.field, "judgesui.validation.fieldName");
  assert.equal(seen.params?.max, 80);

  judgeErrorMessage("Margin must be between 0 and 1", record);
  assert.equal(seen.key, "judgesui.validation.probabilityRange");
  assert.equal(seen.params?.field, "judgesui.validation.fieldMargin");

  judgeErrorMessage("Last answer is not available for this trigger", record);
  assert.equal(seen.key, "judgesui.validation.evidenceUnavailable");
  assert.equal(seen.params?.evidence, "judgesui.evLastAnswer");

  judgeErrorMessage("Change Auto-Approve is not available for this trigger", record);
  assert.equal(seen.key, "judgesui.validation.effectUnavailable");
  assert.equal(seen.params?.effect, "judgesui.actApprovalLabel");

  judgeErrorMessage("Question: unknown field extra", record);
  assert.equal(seen.key, "judgesui.validation.unknownField");
  assert.equal(seen.params?.field, "judgesui.validation.fieldQuestion");
  assert.equal(seen.params?.name, "extra");
});

test("an unrecognised message keeps its original text", () => {
  const server = "Could not save the judge";
  assert.equal(judgeErrorMessage(server, translate), server);
});
