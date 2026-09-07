// WP2: IME-safe editor core + prompt token grammar + roving list (DOM-free).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  admitCommand,
  beginComposition,
  commitEdit,
  createGate,
  endComposition,
  insertAt,
  isCompositionKey,
  isSendKey,
  replaceAll,
} from "../src/components/input/editorCore.ts";
import { activeToken, completeToken, composerMode, fencedSpans, parsePromptTokens, shellCommand } from "../src/composer/language.ts";
import { isActivateKey, moveRoving } from "../src/components/a11y/roving.ts";

test("commands apply immediately when no composition is active", () => {
  const gate = createGate();
  assert.equal(admitCommand(gate, { kind: "insert", text: "x", generation: 0 }), "apply");
  assert.equal(gate.pending.length, 0);
});

test("commands defer during composition and replay on compositionend", () => {
  const gate = createGate();
  beginComposition(gate);
  assert.equal(admitCommand(gate, { kind: "insert", text: "@file ", generation: gate.generation }), "defer");
  assert.equal(gate.pending.length, 1);
  const replay = endComposition(gate);
  assert.equal(replay.length, 1);
  assert.equal(gate.composing, false);
  assert.equal(gate.pending.length, 0);
});

test("stale deferred commands (older than committed edit) are dropped", () => {
  const gate = createGate();
  beginComposition(gate);
  admitCommand(gate, { kind: "replace", text: "old draft", generation: gate.generation });
  // user commits a newer edit (e.g. composition text itself)
  commitEdit(gate);
  const replay = endComposition(gate);
  assert.deepEqual(replay, []);
});

test("consecutive compositions keep the gate consistent", () => {
  const gate = createGate();
  beginComposition(gate);
  endComposition(gate);
  beginComposition(gate);
  assert.equal(gate.composing, true);
  admitCommand(gate, { kind: "insert", text: "a", generation: gate.generation });
  const replay = endComposition(gate);
  assert.equal(replay.length, 1);
});

test("insertAt/replaceAll compute caret math with clamping", () => {
  assert.deepEqual(insertAt("hello world", "@x ", 6, 6), { value: "hello @x world", caret: 9 });
  assert.deepEqual(insertAt("abc", "Z", 1, 2), { value: "aZc", caret: 2 });
  assert.deepEqual(insertAt("abc", "Z", 99, 120), { value: "abcZ", caret: 4 });
  const r = replaceAll("text", { anchor: 2 });
  assert.equal(r.caret, 2);
  assert.equal(r.selEnd, 2);
  assert.equal(replaceAll("text").caret, 4);
});

test("Enter never sends during composition (isComposing or keyCode 229)", () => {
  assert.equal(isSendKey({ key: "Enter" }, false), true);
  assert.equal(isSendKey({ key: "Enter", shiftKey: true }, false), false);
  assert.equal(isSendKey({ key: "Enter", isComposing: true }, false), false);
  assert.equal(isSendKey({ key: "Enter", keyCode: 229 }, false), false);
  assert.equal(isSendKey({ key: "Enter" }, true), false);
  assert.equal(isCompositionKey({ key: "a", keyCode: 229 }, false), true);
});

test("prompt tokens parse at any caret position", () => {
  const tokens = parsePromptTokens("look at @src/app.ts and #snip\n/review now");
  assert.deepEqual(tokens.map((t) => t.kind), ["file", "snippet", "command"]);
  const file = tokens[0]!;
  assert.equal(file.kind === "file" ? file.path : "", "src/app.ts");
});

test("slash is a command only at line start", () => {
  const tokens = parsePromptTokens("try a/b and /cmd");
  assert.deepEqual(tokens.map((t) => t.kind), []);
  const t2 = parsePromptTokens("/cmd arg");
  assert.equal(t2[0]?.kind, "command");
});

test("tokens inside fenced code are opaque", () => {
  const text = "before\n```\n@ignored #also\n```\nafter @real";
  const tokens = parsePromptTokens(text);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]!.kind, "file");
  // unterminated fence swallows to end
  assert.equal(parsePromptTokens("```\n@x").length, 0);
  assert.equal(fencedSpans("```a``` ```b").length, 2);
});

test("activeToken matches the caret and completeToken replaces only it", () => {
  const text = "see @src/ap next";
  const token = activeToken(text, 9); // inside @src/ap
  assert.ok(token && token.kind === "file");
  const r = completeToken(text, token!, "@src/app.ts ");
  assert.equal(r.text, "see @src/app.ts  next");
  assert.equal(r.caret, 4 + "@src/app.ts ".length);
  // caret outside any token
  assert.equal(activeToken("plain text", 3), null);
});

test("leading bang selects shell mode and extracts the command", () => {
  assert.equal(composerMode("!git status"), "shell");
  assert.equal(composerMode("  ! npm test  "), "shell");
  assert.equal(composerMode("explain !important"), "prompt");
  assert.equal(shellCommand("  ! npm test  "), "npm test");
  assert.equal(shellCommand("!"), "");
  assert.equal(shellCommand("plain"), null);
});

test("roving list wraps and ignores composition keys", () => {
  assert.equal(moveRoving(3, 0, { key: "ArrowDown" }), 1);
  assert.equal(moveRoving(3, 2, { key: "ArrowDown" }), 0);
  assert.equal(moveRoving(3, 0, { key: "ArrowUp" }), 2);
  assert.equal(moveRoving(3, 1, { key: "Home" }), 0);
  assert.equal(moveRoving(3, 1, { key: "End" }), 2);
  assert.equal(moveRoving(3, 1, { key: "ArrowDown", isComposing: true }), 1);
  assert.equal(moveRoving(0, 0, { key: "ArrowDown" }), 0);
  assert.equal(isActivateKey({ key: "Enter" }), true);
  assert.equal(isActivateKey({ key: "Enter", isComposing: true }), false);
});
