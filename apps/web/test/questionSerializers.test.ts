import { test } from "node:test";
import assert from "node:assert";
import type { JsonObject } from "@polyth/contracts";
import {
  answerText, answerValid, firstInvalidStep, normalizeQuestions, questionAnswerDraft, questionsToJson, questionsToMarkdown,
} from "../src/questionSerializers.ts";

test("normalize: loose runtime shapes become typed items", () => {
  const items = normalizeQuestions([
    { question: "Pick one", options: ["a", "b"] },
    { prompt: "Pick many", type: "multi", options: [{ value: "x", label: "X", description: "the x" }] },
    { text: "Free form" },
    {},
  ] as JsonObject[]);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.type), ["single", "multi", "text", "text"]);
  assert.deepEqual(items.map((i) => i.id), ["q1", "q2", "q3", "q4"]);
  assert.equal(items[0]!.prompt, "Pick one");
  assert.deepEqual(items[0]!.options, [{ value: "a", label: "a" }, { value: "b", label: "b" }]);
  assert.equal(items[1]!.options![0]!.description, "the x");
  assert.equal(items[3]!.prompt, "Question 4");
});

test("normalize: duplicate option values are dropped, first wins", () => {
  const items = normalizeQuestions([
    { prompt: "p", options: [{ value: "a", label: "First" }, { value: "a", label: "Second" }, "b"] },
  ] as JsonObject[]);
  assert.deepEqual(items[0]!.options!.map((o) => o.label), ["First", "b"]);
});

test("normalize: explicit ids, required=false, allowOther survive", () => {
  const items = normalizeQuestions([
    { id: "lang", prompt: "Language?", options: ["ts"], required: false, allowOther: true },
  ] as JsonObject[]);
  assert.equal(items[0]!.id, "lang");
  assert.equal(items[0]!.required, false);
  assert.equal(items[0]!.allowOther, true);
});

test("validation: required vs optional, multi needs one, text needs content", () => {
  const [single, multi, text, opt] = normalizeQuestions([
    { prompt: "s", options: ["a"] },
    { prompt: "m", type: "multi", options: ["a"] },
    { prompt: "t" },
    { prompt: "o", required: false },
  ] as JsonObject[]);
  assert.equal(answerValid(single!, undefined), false);
  assert.equal(answerValid(single!, "a"), true);
  assert.equal(answerValid(multi!, []), false);
  assert.equal(answerValid(multi!, ["a"]), true);
  assert.equal(answerValid(text!, "  "), false);
  assert.equal(answerValid(text!, "hi"), true);
  assert.equal(answerValid(opt!, undefined), true);
  assert.equal(firstInvalidStep([single!, multi!], { [single!.id]: "a" }), 1);
  assert.equal(firstInvalidStep([single!, multi!], { [single!.id]: "a", [multi!.id]: ["a"] }), -1);
});

test("markdown: selected markers, Other answers, quotes and newlines", () => {
  const items = normalizeQuestions([
    { id: "q1", prompt: "Choose *wisely*", options: ["safe", "risky"], allowOther: true },
    { id: "q2", prompt: "Notes" },
  ] as JsonObject[]);
  const md = questionsToMarkdown(items, { q1: "custom pick", q2: "line1\nline2 \"quoted\"" });
  assert.ok(md.includes("## 1. Choose \\*wisely\\*"));
  assert.ok(md.includes("- [ ] safe"));
  assert.ok(md.includes("- [x] Other: custom pick"));
  assert.ok(md.includes("> line1\n> line2 \"quoted\""));
});

test("markdown: no answer renders placeholder; multi-select marks each", () => {
  const items = normalizeQuestions([
    { id: "q1", prompt: "Pick", type: "multi", options: ["a", "b", "c"] },
    { id: "q2", prompt: "Empty" },
  ] as JsonObject[]);
  const md = questionsToMarkdown(items, { q1: ["a", "c"] });
  assert.ok(md.includes("- [x] a"));
  assert.ok(md.includes("- [ ] b"));
  assert.ok(md.includes("- [x] c"));
  assert.ok(md.includes("_No answer_"));
});

test("json: stable shape and deterministic key order, unicode preserved", () => {
  const items = normalizeQuestions([
    { id: "b", prompt: "β 質問?", options: ["ü"] },
    { id: "a", prompt: "second" },
  ] as JsonObject[]);
  // answers given in reverse order; output must follow question order
  const out = questionsToJson("req-1", items, { a: "答え", b: "ü" });
  const parsed = JSON.parse(out) as { requestId: string; questions: Array<{ id: string }>; answers: Record<string, string> };
  assert.equal(parsed.requestId, "req-1");
  assert.deepEqual(parsed.questions.map((q) => q.id), ["b", "a"]);
  assert.deepEqual(Object.keys(parsed.answers), ["b", "a"]);
  assert.equal(parsed.answers.a, "答え");
  // no envelope/internal fields leak
  assert.ok(!out.includes("seq"));
  assert.ok(!out.includes("sessionId"));
  // deterministic: same input, same output
  assert.equal(out, questionsToJson("req-1", items, { a: "答え", b: "ü" }));
});

test("normalize: choice questions automatically get allowOther: true", () => {
  const [single, multi] = normalizeQuestions([
    { question: "Choose one", options: ["a", "b"] },
    { prompt: "Choose multiple", type: "multi", options: ["x", "y"] },
  ] as JsonObject[]);
  assert.equal(single!.allowOther, true);
  assert.equal(multi!.allowOther, true);
});

test("normalize: questions with existing input field do not get duplicate allowOther", () => {
  const [textQ, explicitInputQ, optionInputQ] = normalizeQuestions([
    { text: "Free form prompt" },
    { prompt: "Has direct input", options: ["a"], hasInput: true },
    { prompt: "Option with input", options: [{ value: "a", label: "A" }, { value: "b", label: "Custom", input: true }] },
  ] as JsonObject[]);
  assert.equal(textQ!.type, "text");
  assert.equal(textQ!.allowOther, undefined);
  assert.equal(explicitInputQ!.allowOther, undefined);
  assert.equal(optionInputQ!.allowOther, undefined);
});

test("normalize: existing other / свій вибір options are deduplicated so they are not present twice", () => {
  const [ukQ, enQ, onlyOtherQ] = normalizeQuestions([
    { question: "Фреймворк", options: ["React", "Vue", "Свій вибір"] },
    { question: "Database", options: ["Postgres", "MySQL", "Other"] },
    { question: "Custom only", options: ["Свій вибір"] },
  ] as JsonObject[]);
  // Ukrainian: "Свій вибір" is removed from options so it is not duplicated in UI
  assert.deepEqual(ukQ!.options!.map((o) => o.label), ["React", "Vue"]);
  assert.equal(ukQ!.allowOther, true);

  // English: "Other" is removed from options
  assert.deepEqual(enQ!.options!.map((o) => o.label), ["Postgres", "MySQL"]);
  assert.equal(enQ!.allowOther, true);

  // Question that only had "Свій вибір" becomes a text input question without duplicate
  assert.equal(onlyOtherQ!.type, "text");
  assert.equal(onlyOtherQ!.allowOther, undefined);
});

test("normalize: explicit allowOther: false is respected", () => {
  const [closed] = normalizeQuestions([
    { question: "Strict choice", options: ["yes", "no"], allowOther: false },
  ] as JsonObject[]);
  assert.equal(closed!.allowOther, undefined);
});


test("normalize: an agent's Other option stays when no custom field replaces it", () => {
  const [closed, optionInput] = normalizeQuestions([
    { question: "Strict choice", options: ["yes", "Other"], allowOther: false },
    { question: "Own input", options: ["a", { value: "other", label: "Other", input: true }] },
  ] as JsonObject[]);
  assert.deepEqual(closed!.options!.map((o) => o.label), ["yes", "Other"]);
  assert.equal(closed!.allowOther, undefined);
  assert.deepEqual(optionInput!.options!.map((o) => o.value), ["a", "other"]);
  assert.equal(optionInput!.allowOther, undefined);
});

test("rewound answers seed the composer with each question quoted above its answer", () => {
  const items = normalizeQuestions([
    { id: "db", prompt: "Which database?", options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }] },
    { id: "langs", title: "Stack", prompt: "Languages?\nPick any", type: "multi", options: [{ value: "ts", label: "TypeScript" }, { value: "go", label: "Go" }] },
    { id: "note", prompt: "Anything else?" },
  ]);
  const answers = { db: "pg", langs: ["ts", "rust"], note: "Keep it small" };
  assert.equal(answerText(items[0]!, answers.db), "Postgres");
  assert.equal(answerText(items[1]!, answers.langs), "TypeScript, rust");
  assert.equal(answerText(items[2]!, undefined), "");
  assert.equal(
    questionAnswerDraft(items, answers),
    "> Which database?\nPostgres\n\n> Stack\n> Languages?\n> Pick any\nTypeScript, rust\n\n> Anything else?\nKeep it small",
  );
});
