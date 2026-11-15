import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime } from "@polyth/contracts";
import { buildCommitMessagePrompt, commitStyleWantsDetails, createCommitMessageGenerator, finishCommitMessage } from "../src/serverEntry.ts";
import type { CommitStyle } from "../src/commitSettings.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new";
const runtime = {} as AgentRuntime;

test("commit generator caches unchanged selected diff and coalesces concurrent requests", async () => {
  let calls = 0;
  let seenTimeoutMs: number | undefined;
  let selected = { harnessId: "opencode", providerID: "openai", modelID: "small" };
  let seenHarness: string | undefined;
  let seenUserId: string | undefined;
  const generate = createCommitMessageGenerator({
    diff: async (_root, opts) => ({ diff: opts?.staged ? DIFF : "unstaged ignored" }),
    runtime: async (_root, model) => { seenHarness = model?.harnessId; return runtime; },
    model: (userId) => { seenUserId = userId; return selected; },
    inputBudget: async () => 2_000,
    complete: async (_rt, options) => {
      calls += 1;
      seenTimeoutMs = options.timeoutMs;
      return { text: "Update the implementation" };
    },
  });
  const [first, second] = await Promise.all([generate("/repo", "usr_test"), generate("/repo", "usr_test")]);
  assert.equal(first, "Update the implementation");
  assert.equal(second, first);
  assert.equal(calls, 1);
  assert.equal(seenUserId, "usr_test");
  await generate("/repo", "usr_test");
  assert.equal(calls, 1);
  selected = { ...selected, harnessId: "codex" };
  await generate("/repo", "usr_test");
  assert.equal(calls, 2);
  assert.equal(seenHarness, "codex");
  assert.equal(
    seenTimeoutMs,
    90_000,
    "a free/subscription-auth small model needs headroom well past the old 30s cap",
  );
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


test("commit generator honors an explicit model and isolates cached results by caller", async () => {
  let calls = 0;
  const selected = { harnessId: "codex", providerID: "openai", modelID: "selected" };
  const generate = createCommitMessageGenerator({
    diff: async () => ({ diff: DIFF }),
    model: () => ({ providerID: "other", modelID: "default" }),
    runtime: async (_root, model) => { assert.deepEqual(model, selected); return runtime; },
    inputBudget: async () => 2_000,
    complete: async (_rt, options) => { assert.deepEqual(options.model, selected); return { text: `message ${++calls}` }; },
  });
  assert.equal(await generate("/repo", "a", selected), "message 1");
  assert.equal(await generate("/repo", "b", selected), "message 2");
});

const style = (overrides: Partial<CommitStyle> = {}): CommitStyle => ({
  titleRule: "", detailsRule: "", details: "auto", matchHistory: false, ...overrides,
});

test("the built-in prompt is unchanged when no style or context is given", () => {
  const prompt = buildCommitMessagePrompt(DIFF, 2_000);
  assert.match(prompt, /^Write a git commit message\. Output only the message\.\nUse one imperative subject of at most 72 characters/);
  assert.doesNotMatch(prompt, /Title rule/);
});

test("a Space style puts its title and details rules, the chat title and branch history in the prompt", async () => {
  let prompt = "";
  let maxOutputTokens = 0;
  let historyReads = 0;
  const generate = createCommitMessageGenerator({
    diff: async () => ({ diff: DIFF }),
    runtime: async () => runtime,
    recentSubjects: async (_root, limit) => { historyReads += 1; assert.equal(limit, 12); return ["[Fix] Keep the composer open", "[Feature] Add voice mode"]; },
    inputBudget: async () => 4_000,
    complete: async (_rt, options) => {
      prompt = options.prompt; maxOutputTokens = options.maxOutputTokens;
      return { text: "```\n[Feature] Add flag\n\n- Export the flag\n```" };
    },
  });
  const text = await generate("/repo", "u", undefined, {
    style: style({ titleRule: "Start with [Feature], [Fix] or [Improvement].", detailsRule: "A bulleted list of changes.", details: "always", matchHistory: true }),
    context: { title: "Feature flag", targetBranch: "devel" },
  });
  assert.equal(text, "[Feature] Add flag\n\n- Export the flag");
  assert.equal(historyReads, 1);
  assert.equal(maxOutputTokens, 400, "a body needs more room than a title");
  assert.match(prompt, /Title rule \(first line\):\nStart with \[Feature\], \[Fix\] or \[Improvement\]\./);
  assert.match(prompt, /Add a body after one blank line\. Body rule:\nA bulleted list of changes\./);
  assert.match(prompt, /recent commits on devel[^\n]*\n<recent-commits>\n\[Fix\] Keep the composer open\n\[Feature\] Add voice mode\n<\/recent-commits>/);
  assert.match(prompt, /<chat-title>Feature flag<\/chat-title>/);
  assert.ok(prompt.indexOf("<chat-title>") < prompt.indexOf("<diff>"));
});

test("a title-only style keeps one line and never reads history unless asked", async () => {
  let maxOutputTokens = 0;
  let prompt = "";
  const generate = createCommitMessageGenerator({
    diff: async () => ({ diff: DIFF }),
    runtime: async () => runtime,
    recentSubjects: async () => { throw new Error("history must not be read"); },
    inputBudget: async () => 2_000,
    complete: async (_rt, options) => { maxOutputTokens = options.maxOutputTokens; prompt = options.prompt; return { text: "\nfeat: add flag\n\nBody the model added anyway" }; },
  });
  assert.equal(await generate("/repo", "u", undefined, { style: style({ titleRule: "Conventional Commits.", details: "never" }) }), "feat: add flag");
  assert.equal(maxOutputTokens, 120);
  assert.match(prompt, /Write only the title line, no body\./);
});

test("the cache keeps messages written under different styles apart", async () => {
  let calls = 0;
  const generate = createCommitMessageGenerator({
    diff: async () => ({ diff: DIFF }),
    runtime: async () => runtime,
    inputBudget: async () => 2_000,
    complete: async () => ({ text: `message ${++calls}` }),
  });
  assert.equal(await generate("/repo", "u"), "message 1");
  assert.equal(await generate("/repo", "u", undefined, { style: style() }), "message 1", "an all-default style is the built-in style");
  assert.equal(await generate("/repo", "u", undefined, { style: style({ titleRule: "Lowercase." }) }), "message 2");
  assert.equal(await generate("/repo", "u", undefined, { style: style({ titleRule: "Lowercase." }) }), "message 2");
});

test("finishing a message strips fences and only trims a title-only style to one line", () => {
  assert.equal(finishCommitMessage("```text\nAdd flag\n\nWhy\n```", style()), "Add flag\n\nWhy");
  assert.equal(finishCommitMessage("Add flag\n\nWhy", style({ details: "never" })), "Add flag");
  assert.equal(commitStyleWantsDetails(style({ details: "auto" })), false);
  assert.equal(commitStyleWantsDetails(style({ details: "auto", detailsRule: "Bullets." })), true);
  assert.equal(commitStyleWantsDetails(style({ details: "never", detailsRule: "Bullets." })), false);
  assert.equal(commitStyleWantsDetails(undefined), false);
});

test("following history without a title rule lets the history set the title's form", () => {
  const prompt = buildCommitMessagePrompt(DIFF, 4_000, style({ matchHistory: true }), { targetBranch: "main", recentSubjects: ["[Fix] Keep the composer open"] });
  assert.match(prompt, /Title rule \(first line\):\nFollow the form of the recent commits below\./);
  assert.doesNotMatch(prompt, /One imperative subject line of at most 72 characters\.\n/);
  assert.match(prompt, /recent commits on main:\n<recent-commits>/);
  assert.doesNotMatch(prompt, /unless a rule above says otherwise/);
  const ruled = buildCommitMessagePrompt(DIFF, 4_000, style({ titleRule: "Lowercase.", matchHistory: true }), { recentSubjects: ["[Fix] x"] });
  assert.match(ruled, /unless a rule above says otherwise/);
});
