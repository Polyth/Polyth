import assert from "node:assert/strict";
import test from "node:test";
import { composerPromptSuggestion, visiblePromptSuggestion } from "../src/composer/promptSuggestion.ts";

const base = { suggestion: "  Add tests  ", dismissed: "", text: "", working: false, blocked: false };

test("an idle empty composer shows the trimmed harness suggestion", () => {
  assert.equal(visiblePromptSuggestion(base), "Add tests");
});

test("typing, a running turn, a blocked composer or a dismissal hides it", () => {
  assert.equal(visiblePromptSuggestion({ ...base, text: "x" }), "");
  assert.equal(visiblePromptSuggestion({ ...base, text: "   " }), "Add tests", "whitespace is still an empty draft");
  assert.equal(visiblePromptSuggestion({ ...base, working: true }), "");
  assert.equal(visiblePromptSuggestion({ ...base, blocked: true }), "");
  assert.equal(visiblePromptSuggestion({ ...base, dismissed: "Add tests" }), "");
  assert.equal(visiblePromptSuggestion({ ...base, dismissed: "Old hint" }), "Add tests", "a new suggestion replaces a dismissed one");
  assert.equal(visiblePromptSuggestion({ ...base, suggestion: undefined }), "");
});

test("a package offer fills in only for its own session and, unless preferred, not over the harness", () => {
  const offer = { sessionId: "s1", text: "Validate the fix" };
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: undefined, offer }), "Validate the fix");
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: "Add tests", offer }), "Add tests", "the harness wins");
  assert.equal(composerPromptSuggestion({ sessionId: "s2", harness: undefined, offer }), undefined, "another chat's offer stays hidden");
  assert.equal(composerPromptSuggestion({ sessionId: undefined, harness: undefined, offer }), undefined);
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: "  ", offer }), "Validate the fix", "a blank harness hint is no hint");
});

test("a preferred offer wins over the harness, and an empty one holds the chip instead of flashing it", () => {
  const preferred = { sessionId: "s1", text: "Validate the fix", preferred: true };
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: "Add tests", offer: preferred }), "Validate the fix");
  assert.equal(composerPromptSuggestion({ sessionId: "s2", harness: "Add tests", offer: preferred }), "Add tests",
    "another chat's preferred offer changes nothing here");
  const holding = { sessionId: "s1", text: "", preferred: true };
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: "Add tests", offer: holding }), undefined,
    "the preferred source is still answering");
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: "Add tests", offer: null }), "Add tests",
    "a withdrawn hold gives the chip back to the harness");
  assert.equal(composerPromptSuggestion({ sessionId: "s1", harness: undefined, offer: { sessionId: "s1", text: "  " } }), undefined);
});
