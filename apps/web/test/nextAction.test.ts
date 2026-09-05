import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canApplyNextAction,
  canRevertPromptRewrite,
  nextActionInsertMode,
  promptRewriteSource,
} from "../src/nextAction.ts";

const request = { sessionId: "s1", atSeq: 42, draftRevision: 3, draft: "" };

test("next-action guard accepts only the unchanged active draft and session", () => {
  assert.equal(canApplyNextAction(request, {
    activeSessionId: "s1", latestSeq: 42, draftRevision: 3,
  }, { atSeq: 42 }), true);
  assert.equal(canApplyNextAction(request, {
    activeSessionId: "s2", latestSeq: 42, draftRevision: 3,
  }, { atSeq: 42 }), false, "switching sessions discards the response");
  assert.equal(canApplyNextAction(request, {
    activeSessionId: "s1", latestSeq: 43, draftRevision: 3,
  }, { atSeq: 42 }), false, "a new event discards the response");
  assert.equal(canApplyNextAction(request, {
    activeSessionId: "s1", latestSeq: 42, draftRevision: 4,
  }, { atSeq: 42 }), false, "typing preserves the draft");
});

test("suggestions and improved prompts replace the whole composer and never imply send", () => {
  assert.equal(nextActionInsertMode("Implement the fix."), "replace");
  assert.equal(nextActionInsertMode(" "), null);
});

test("a generated prompt can be reverted or regenerated from the original", () => {
  const rewrite = { scopeId: "s1", original: "fix bug", generated: "Fix the retry bug and add a regression test." };
  assert.equal(promptRewriteSource("s1", rewrite.generated, rewrite), "fix bug");
  assert.equal(canRevertPromptRewrite("s1", rewrite.generated, rewrite), true);
  assert.equal(promptRewriteSource("s1", `${rewrite.generated} Now.`, rewrite), `${rewrite.generated} Now.`);
  assert.equal(canRevertPromptRewrite("s2", rewrite.generated, rewrite), false);
});

test("next action is a toggleable composer widget using the existing action flow", async () => {
  const [composer, miniWidgets, css] = await Promise.all([
    readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/widgets/builtinMiniWidgets.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(composer, /api\.assistSuggestion\(target, source\)/);
  assert.match(composer, /api\.assistPrompt\(projectId!, source\)/);
  assert.match(composer, /requestComposerReplace\(result\.suggestion\)/);
  assert.doesNotMatch(composer, /send\(result\.suggestion\)/);
  assert.match(composer, /canGenerateNextAction,[\s\S]*suggestionBusy,[\s\S]*generateNextAction/);
  assert.match(miniWidgets, /id: "composer\.next-action"/);
  assert.match(miniWidgets, /defaultVisible: true/);
  assert.match(miniWidgets, /icon=\{AssistIcon\}/);
  assert.match(miniWidgets, /busy=\{busy\}/);
  assert.match(miniWidgets, /icon=\{UndoIcon\}/);
  assert.match(miniWidgets, /disabled=\{!canGenerate\}/);
  assert.match(css, /\.ui-icon-btn::after\s*\{[^}]*width:\s*max\(100%, var\(--hit-min\)\)/s);
});
