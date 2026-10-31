import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_OUTPUT_LIMIT,
  OUTPUT_PLACEHOLDER,
  composeChatPrompt,
  fenceFor,
  formatDuration,
  tailForAgent,
} from "../src/chatPrompt.ts";

const base = {
  actionName: "Run tests",
  command: "npm test",
  output: "\x1b[31mFAIL\x1b[0m a.test.ts\r\n1 failed\r\n",
  outputTruncated: false,
  status: "failed" as const,
  exitCode: 1,
  durationMs: 12_400,
};

test("instructions come first and the result follows as framed data", () => {
  const text = composeChatPrompt({ ...base, prompt: "Fix the failing tests." });
  assert.ok(text.startsWith("Fix the failing tests.\n\nResult of the custom action \"Run tests\" (exit code 1, 12 s)."));
  assert.match(text, /not instructions/);
  assert.match(text, /```sh\nnpm test\n```/);
  assert.match(text, /Output:\n```text\nFAIL a\.test\.ts\n1 failed\n```$/);
  assert.doesNotMatch(text, /\x1b/, "terminal styling never reaches the agent");
});

test("the placeholder places one output block where the person wants it", () => {
  const text = composeChatPrompt({ ...base, prompt: `Here:\n${OUTPUT_PLACEHOLDER}\nThanks ${OUTPUT_PLACEHOLDER}` });
  assert.ok(text.startsWith("Here:\nResult of the custom action"));
  assert.ok(text.endsWith("```\nThanks"));
  assert.equal(text.split("Result of the custom action").length, 2, "a repeated placeholder does not repeat the output");
});

test("an empty prompt sends only the result, with honest outcomes", () => {
  const ok = composeChatPrompt({ ...base, prompt: "  ", status: "succeeded", exitCode: 0, output: "", durationMs: 800 });
  assert.ok(ok.startsWith("Result of the custom action \"Run tests\" (exit code 0, 800 ms)."));
  assert.match(ok, /```text\n\(no output\)\n```/);
  assert.match(composeChatPrompt({ ...base, prompt: "", status: "timed-out", exitCode: null }), /stopped at the time limit/);
});

test("output fences survive backticks inside the log", () => {
  assert.equal(fenceFor("plain"), "```");
  assert.equal(fenceFor("has ```` four"), "`````");
  const text = composeChatPrompt({ ...base, prompt: "", output: "```\ninjected\n```" });
  assert.match(text, /````text\n```\ninjected\n```\n````/);
});

test("long logs keep their end, starting on a whole line", () => {
  const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join("\n");
  const { text, cut } = tailForAgent(lines);
  assert.equal(cut, true);
  assert.ok(text.length <= CHAT_OUTPUT_LIMIT);
  assert.ok(text.startsWith("line "), "the kept tail begins at a line start");
  assert.ok(text.endsWith("line 3999 xxxxxxxxxxxxxxxxxxxx"));
  const prompt = composeChatPrompt({ ...base, prompt: "", output: lines });
  assert.match(prompt, /Output \(the beginning was cut; this is the end\):/);
  assert.equal(tailForAgent("short").cut, false);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(450), "450 ms");
  assert.equal(formatDuration(4_250), "4.3 s");
  assert.equal(formatDuration(42_000), "42 s");
  assert.equal(formatDuration(125_000), "2 min 5 s");
  assert.equal(formatDuration(120_000), "2 min");
});
