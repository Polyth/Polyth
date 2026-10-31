import test from "node:test";
import assert from "node:assert/strict";
import {
  canApplyPromptRewrite,
  canRevertPromptRewrite,
  nextActionInsertMode,
  promptRewriteSource,
} from "../widgets/promptRewrite.ts";

const request = { sessionId: "s1", draftRevision: 3, draft: "fix it" };

test("rewrite guard accepts only the unchanged active draft and session", () => {
  assert.equal(canApplyPromptRewrite(request, { activeSessionId: "s1", draftRevision: 3 }), true);
  assert.equal(canApplyPromptRewrite(request, { activeSessionId: "s2", draftRevision: 3 }), false,
    "switching sessions discards the response");
  assert.equal(canApplyPromptRewrite(request, { activeSessionId: "s1", draftRevision: 4 }), false,
    "typing preserves the draft");
  assert.equal(canApplyPromptRewrite({ ...request, projectId: "p1" }, {
    activeSessionId: "s1", activeProjectId: "p2", draftRevision: 3,
  }), false, "switching projects discards the response");
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

