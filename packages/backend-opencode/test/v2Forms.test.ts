import assert from "node:assert/strict";
import { test } from "node:test";
import { v2FormInfoOf, v2FormQuestionOf, v2FormAnswerOf } from "../src/v2Forms.ts";

test("V2 free text and optional conditional fields remain answerable through generic questions", () => {
  const native = {
    id: "frm_text", sessionID: "ses_text", title: "Details", fields: [
      { key: "name", type: "string", required: true },
      { key: "comment", type: "string" },
      { key: "extra", type: "string", required: true, when: [{ key: "name", op: "eq", value: "Other" }] },
    ],
  };
  const form = v2FormInfoOf(native, "ses_text")!;
  const questions = v2FormQuestionOf(native, "ses_text")!.questions;
  assert.deepEqual(questions.map((field) => field.required), [true, false, false]);
  assert.match(String(questions[2]!.prompt), /Required when name is "Other"/);
  assert.deepEqual(v2FormAnswerOf(form, { answers: [["Alice"], [], []] }), { answer: { name: "Alice" } });
  assert.deepEqual(v2FormAnswerOf(form, { answers: [["Alice"], ["free text"], []] }), { answer: { name: "Alice", comment: "free text" } });
  assert.ok("error" in v2FormAnswerOf(form, { answers: [["Other"], [], []] }));
  assert.deepEqual(v2FormAnswerOf(form, { answers: [["Other"], [], ["details"]] }), { answer: { name: "Other", extra: "details" } });
  assert.ok("error" in v2FormAnswerOf(form, { answers: [[], [], []] }));
});

test("V2 closed options still reject values outside the native selection", () => {
  const form = v2FormInfoOf({ id: "frm_closed", sessionID: "ses_text", title: "Pick", fields: [
    { key: "choice", type: "string", options: [{ value: "a", label: "A" }] },
  ] }, "ses_text")!;
  assert.ok("error" in v2FormAnswerOf(form, { answers: [["b"]] }));
  assert.deepEqual(v2FormAnswerOf(form, { answers: [["a"]] }), { answer: { choice: "a" } });
});
