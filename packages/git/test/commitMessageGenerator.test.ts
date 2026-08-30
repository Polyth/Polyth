import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime } from "@polyth/contracts";
import { buildCommitMessagePrompt, createCommitMessageGenerator } from "../src/serverEntry.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new";
const runtime = {} as AgentRuntime;

test("commit generator caches unchanged selected diff and coalesces concurrent requests", async () => {
  let calls = 0;
  const generate = createCommitMessageGenerator({
    diff: async (_root, opts) => ({ diff: opts?.staged ? DIFF : "unstaged ignored" }),
    runtime: async () => runtime,
    model: { providerID: "openai", modelID: "small" },
    inputBudget: async () => 2_000,
    complete: async () => { calls += 1; return { text: "Update the implementation" }; },
  });
  const [first, second] = await Promise.all([generate("/repo"), generate("/repo")]);
  assert.equal(first, "Update the implementation");
  assert.equal(second, first);
  assert.equal(calls, 1);
  await generate("/repo");
  assert.equal(calls, 1);
});

test("commit generator preserves staged-first semantics and changes cache key with diff", async () => {
  let staged = "";
  let unstaged = DIFF;
  let calls = 0;
  const generate = createCommitMessageGenerator({
    diff: async (_root, opts) => ({ diff: opts?.staged ? staged : unstaged }),
    runtime: async () => runtime,
    inputBudget: async () => 2_000,
    complete: async () => ({ text: `message ${++calls}` }),
  });
  assert.equal(await generate("/repo"), "message 1");
  staged = "staged diff";
  assert.equal(await generate("/repo"), "message 2");
  staged = "staged diff changed";
  assert.equal(await generate("/repo"), "message 3");
});

test("commit prompt stays within its model-aware global budget", () => {
  const prompt = buildCommitMessagePrompt(`${DIFF}\n${"+x\n".repeat(5_000)}`, 800);
  assert.ok(prompt.length <= 800);
  assert.match(prompt, /<diff>/);
  assert.match(prompt, /<\/diff>/);
});
