// Composer modes: pure trigger/leave decisions and the host registry side of
// the web-sdk `ComposerMode` seam.
import test from "node:test";
import assert from "node:assert/strict";
import type { ComposerMode } from "@polyth/web-sdk";
import { detectModeTrigger, isModeLeaveKey, modeText } from "../src/composer/modes.ts";
import {
  composerActiveMode,
  composerContributionsVersion,
  listComposerModes,
  listenComposerModeRequests,
  publishComposerActiveMode,
  registerComposerMode,
  requestComposerMode,
} from "../src/composer/contributions.ts";

const modes = [{ id: "btw", trigger: "/btw" }, { id: "other", trigger: "/o" }];

test("a trigger followed by whitespace at the very start enters its mode and is stripped", () => {
  assert.deepEqual(detectModeTrigger("/btw ", modes), { modeId: "btw", rest: "" });
  assert.deepEqual(detectModeTrigger("/btw which file?", modes), { modeId: "btw", rest: "which file?" });
  assert.deepEqual(detectModeTrigger("/BTW why", modes), { modeId: "btw", rest: "why" }, "auto-capitalised trigger still counts");
  assert.deepEqual(detectModeTrigger("/btw\nmulti", modes), { modeId: "btw", rest: "multi" });
  assert.deepEqual(detectModeTrigger("/o x", modes), { modeId: "other", rest: "x" });
});

test("a bare, longer, inner or whitespace-bearing trigger never enters", () => {
  assert.equal(detectModeTrigger("/btw", modes), null, "still typing");
  assert.equal(detectModeTrigger("/btwx y", modes), null, "a longer slash command");
  assert.equal(detectModeTrigger(" /btw y", modes), null, "not at the very start");
  assert.equal(detectModeTrigger("ask /btw y", modes), null);
  assert.equal(detectModeTrigger("/btw y", [{ id: "no-trigger" }]), null);
  assert.equal(detectModeTrigger("a b c", [{ id: "spaced", trigger: "a b" }]), null);
});

test("Esc in an empty draft and Backspace at the start of an empty draft leave", () => {
  const base = { text: "", selectionStart: 0, selectionEnd: 0, composing: false };
  assert.equal(isModeLeaveKey({ ...base, key: "Escape" }), true);
  assert.equal(isModeLeaveKey({ ...base, key: "Backspace" }), true);
  assert.equal(isModeLeaveKey({ ...base, key: "Enter" }), false);
  assert.equal(isModeLeaveKey({ ...base, key: "a" }), false);
});

test("typed text, composition and modifiers keep the mode", () => {
  const base = { text: "", selectionStart: 0, selectionEnd: 0, composing: false };
  assert.equal(isModeLeaveKey({ ...base, key: "Backspace", text: "x", selectionStart: 0, selectionEnd: 0 }), false);
  assert.equal(isModeLeaveKey({ ...base, key: "Escape", text: "question" }), false);
  assert.equal(isModeLeaveKey({ ...base, key: "Escape", composing: true }), false);
  assert.equal(isModeLeaveKey({ ...base, key: "Backspace", metaKey: true }), false);
  assert.equal(isModeLeaveKey({ ...base, key: "Escape", shiftKey: true }), false);
});

test("mode text resolves functions and survives a throwing label", () => {
  assert.equal(modeText("By the way"), "By the way");
  assert.equal(modeText(() => "Ask"), "Ask");
  assert.equal(modeText(undefined), "");
  assert.equal(modeText(() => { throw new Error("locale gone"); }), "");
});

const mode = (id: string): ComposerMode => ({ id, label: id, submit: () => {} });

test("modes list by id, replace by id and a superseded unregister is a no-op", () => {
  const offB = registerComposerMode(mode("b"));
  const offA = registerComposerMode(mode("a"));
  assert.deepEqual(listComposerModes().map((entry) => entry.id), ["a", "b"]);
  const replacement = mode("a");
  const offReplacement = registerComposerMode(replacement);
  offA();
  assert.equal(listComposerModes().find((entry) => entry.id === "a"), replacement);
  offReplacement();
  offB();
  assert.deepEqual(listComposerModes(), []);
});

test("mode requests reach the composer of the named session first, or any composer", () => {
  const seen: Array<[string | null, string | undefined, string]> = [];
  const offOne = listenComposerModeRequests((modeId, sessionId) => {
    seen.push([modeId, sessionId, "one"]);
    return sessionId === undefined || sessionId === "s1";
  });
  const offTwo = listenComposerModeRequests((modeId, sessionId) => {
    seen.push([modeId, sessionId, "two"]);
    return sessionId === "s2";
  });
  assert.equal(requestComposerMode("btw", { sessionId: "s2" }), true);
  assert.equal(requestComposerMode(null), true);
  assert.equal(requestComposerMode("btw", { sessionId: "s3" }), false, "nobody owns s3");
  offOne();
  offTwo();
  assert.equal(requestComposerMode("btw"), false, "no composer mounted");
  assert.deepEqual(seen.map((entry) => entry[2]), ["one", "two", "one", "one", "two"]);
});

test("the active mode is published per session and notifies only on change", () => {
  const before = composerContributionsVersion();
  publishComposerActiveMode("s1", "btw");
  assert.equal(composerActiveMode("s1"), "btw");
  assert.equal(composerActiveMode("s2"), null);
  const afterEnter = composerContributionsVersion();
  assert.ok(afterEnter > before);
  publishComposerActiveMode("s1", "btw");
  assert.equal(composerContributionsVersion(), afterEnter, "same mode does not bump");
  publishComposerActiveMode("s1", null);
  assert.equal(composerActiveMode("s1"), null);
  publishComposerActiveMode(null, "btw");
  assert.equal(composerActiveMode(null), "btw", "a new-chat composer keys by the empty session");
  publishComposerActiveMode(null, null);
});
