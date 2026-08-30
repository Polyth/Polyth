import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canApplyNextAction, nextActionInsertMode } from "../src/nextAction.ts";

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

test("next-action insertion replaces only an empty composer and never implies send", () => {
  assert.equal(nextActionInsertMode(request, "Implement the fix."), "replace");
  assert.equal(nextActionInsertMode({ ...request, draft: "Keep this note" }, "Implement the fix."), "insert");
  assert.equal(nextActionInsertMode(request, " "), null);
});

test("Composer uses the small native action, loading primitive, replacement bus, and mobile-safe icon button", async () => {
  const [composer, css] = await Promise.all([
    readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(composer, /api\.assistSuggestion\(target\)/);
  assert.match(composer, /requestComposerReplace\(result\.suggestion\)/);
  assert.match(composer, /requestComposerInsert\(result\.suggestion\)/);
  assert.doesNotMatch(composer, /send\(result\.suggestion\)/);
  assert.match(composer, /<IconButton[\s\S]*?icon=\{AssistIcon\}[\s\S]*?busy=\{suggestionBusy\}/);
  assert.match(composer, /<Tooltip content=\{tr\("composer\.generateNextAction"\)\}>/);
  assert.match(css, /\.ui-icon-btn::after\s*\{[^}]*width:\s*max\(100%, var\(--hit-min\)\)/s);
});
