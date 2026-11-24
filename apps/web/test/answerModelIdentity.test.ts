// An answer's model identity is recorded with its turn and never follows the
// session's later selection. The footer reads message model, then turn model;
// a model that only arrives with the turn's usage reaches that turn's answers.
import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { answerModelRef, buildModel, type AssistantMsg } from "../src/reduce.ts";

const opus = { providerID: "anthropic", modelID: "opus" };
const auto = (): ((type: string, data: JsonObject) => SessionEvent) => {
  let seq = 0;
  return (type, data) => ({ id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1 });
};
const answers = (events: SessionEvent[]) =>
  buildModel(events).messages.filter((m): m is AssistantMsg => m.kind === "assistant");

test("an answer with no recorded model stays unrecorded (footer shows Auto, not the selection)", () => {
  const e = auto();
  const [a] = answers([
    e("turn/started", { turnId: "t1" }),
    e("assistant/message", { partId: "p1", text: "hi" }),
    e("turn/stopped", { turnId: "t1", reason: "completed" }),
  ]);
  assert.equal(a!.model, undefined);
});

test("a model recorded at turn start is frozen onto the answer", () => {
  const e = auto();
  const [a] = answers([
    e("turn/started", { turnId: "t1", model: opus }),
    e("assistant/message", { partId: "p1", text: "hi" }),
  ]);
  assert.deepEqual(a!.model, opus);
});

test("a concrete model arriving with usage reaches the turn's already-created answers only", () => {
  const e = auto();
  const [first, second] = answers([
    e("turn/started", { turnId: "t1" }),
    e("assistant/message", { partId: "p1", text: "one" }),
    e("usage/recorded", { model: opus, tokens: { input: 10, output: 5 } }),
    e("turn/stopped", { turnId: "t1", reason: "completed" }),
    e("turn/started", { turnId: "t2" }),
    e("assistant/message", { partId: "p2", text: "two" }),
  ]);
  assert.deepEqual(first!.model, opus);
  assert.equal(second!.model, undefined);
});

test("replay is deterministic", () => {
  const e = auto();
  const events = [
    e("turn/started", { turnId: "t1" }),
    e("assistant/message", { partId: "p1", text: "one" }),
    e("usage/recorded", { model: opus, tokens: { input: 1, output: 1 } }),
  ];
  assert.deepEqual(answers(events), answers(events));
});

const selected = { providerID: "anthropic", modelID: "sonnet" };

test("footer identity: a settled answer without a record ignores the session selection", () => {
  assert.equal(answerModelRef({}, undefined, selected, false), undefined);
  assert.equal(answerModelRef({}, {}, selected, false), undefined);
});

test("footer identity: a recorded model wins over the selection and the turn", () => {
  assert.deepEqual(answerModelRef({ model: opus }, { model: selected }, selected, false), opus);
  assert.deepEqual(answerModelRef({}, { model: opus }, selected, false), opus);
  assert.deepEqual(answerModelRef({ model: opus }, undefined, selected, true), opus);
});

test("footer identity: an in-flight answer without a record may use the selection", () => {
  assert.deepEqual(answerModelRef({}, undefined, selected, true), selected);
});
