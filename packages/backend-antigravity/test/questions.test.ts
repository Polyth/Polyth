import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgySkillsReport, readAgySkills } from "../src/commands.ts";
import { agyQuestionItems, agyQuestionReply, parseAgyQuestions } from "../src/questions.ts";

test("native question arguments normalize across the field spellings the CLI emits", () => {
  assert.deepEqual(parseAgyQuestions({ questions: [
    { question: "Pick a stack", options: [{ id: "a", text: "Node" }, { id: "a", text: "Duplicate" }, { id: "b", text: "Go" }], is_multi_select: true },
    { Question: "Name?", Options: ["First", "Second"] },
  ] }), [
    { question: "Pick a stack", options: [{ id: "a", text: "Node" }, { id: "b", text: "Go" }], multi: true },
    { question: "Name?", options: [{ id: "1", text: "First" }, { id: "2", text: "Second" }], multi: false },
  ]);
  assert.deepEqual(parseAgyQuestions({ question: "Proceed?" }), [{ question: "Proceed?", options: [], multi: false }]);
  for (const invalid of [{}, { questions: [] }, { questions: [{ options: [] }] }, { questions: "text" }]) {
    assert.equal(parseAgyQuestions(invalid), undefined);
  }
});

test("question items keep native option IDs as values and always allow a write-in", () => {
  const questions = parseAgyQuestions({ questions: [
    { question: "Pick", options: [{ id: "a", text: "Alpha" }], isMultiSelect: true },
    { question: "Why?" },
  ] })!;
  assert.deepEqual(agyQuestionItems(questions), [
    { id: "q1", prompt: "Pick", type: "multi", options: [{ value: "a", label: "Alpha" }], allowOther: true, required: true },
    { id: "q2", prompt: "Why?", type: "text", required: true },
  ]);
  const reply = agyQuestionReply(questions, { answers: [["a", "Custom"], []] });
  assert.match(reply, /1\. Pick\n {3}Answer: Alpha; Custom/);
  assert.match(reply, /2\. Why\?\n {3}Answer: \(no answer\)/);
  assert.match(agyQuestionReply(questions, { action: "reject" }), /^Dismissed by the user in Polyth/);
});

test("the skills report becomes native commands; malformed or foreign reports publish nothing", () => {
  // Captured shape of `agy -p /skills --output-format json` (CLI 1.2.9).
  const report = JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0,
    command: { name: "skills", data: { skills: [
      { name: "automation", description: "Create a scheduled\n automation.", path: "/skills/automation/SKILL.md", builtin: true, model_invocable: true },
      { name: "bad name; rm -rf", description: "x" },
      { name: "automation", description: "duplicate" },
      { name: "generative_ui" },
    ] } } });
  assert.deepEqual(parseAgySkillsReport(report), [
    { id: "native:antigravity:automation", name: "automation", description: "Create a scheduled automation.", owner: "native",
      harnessId: "antigravity", acceptsArguments: true, availability: "session", invocation: "raw-native-input" },
    { id: "native:antigravity:generative_ui", name: "generative_ui", owner: "native",
      harnessId: "antigravity", acceptsArguments: true, availability: "session", invocation: "raw-native-input" },
  ]);
  assert.deepEqual(parseAgySkillsReport("not json"), []);
  assert.deepEqual(parseAgySkillsReport(JSON.stringify({ command: { name: "usage", data: { skills: [{ name: "x" }] } } })), []);
});

test("the skills report runs the local print-mode command with stdin closed and is bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake-agy.mjs");
  await writeFile(fake, `
const args = process.argv.slice(2);
if (args.join(" ") !== "-p /skills --output-format json") { process.stderr.write("unexpected args"); process.exit(2); }
if (process.env.AGY_FAKE_HANG) setInterval(() => {}, 1000);
else process.stdin.on("end", () => {}), process.stdout.write(JSON.stringify({ command: { name: "skills", data: { skills: [{ name: "automation" }] } } }));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  assert.deepEqual((await readAgySkills({ command: process.execPath, prefixArgs: [fake], cwd: root, env })).map((row) => row.name), ["automation"]);
  await assert.rejects(readAgySkills({ command: process.execPath, prefixArgs: [fake], cwd: root, env: { ...env, AGY_FAKE_HANG: "1" }, timeoutMs: 200 }),
    { code: "discovery-unavailable", message: /in time/ });
});
