// Caret restore across session switches: in-memory, bounded, text-matched.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { forgetComposerSelection, rememberComposerSelection, takeComposerSelection } = await import("../src/drafts.ts");

test("restores a remembered selection for identical text and consumes it", () => {
  rememberComposerSelection("k1", "hello world", { start: 2, end: 5 });
  assert.deepEqual(takeComposerSelection("k1", "hello world"), { anchor: 2, head: 5 });
  assert.equal(takeComposerSelection("k1", "hello world"), null);
});

test("clamps out-of-range offsets and keeps head >= anchor", () => {
  rememberComposerSelection("k2", "abc", { start: 9, end: 20 });
  assert.deepEqual(takeComposerSelection("k2", "abc"), { anchor: 3, head: 3 });
  rememberComposerSelection("k2", "abc", { start: -4, end: 1 });
  assert.deepEqual(takeComposerSelection("k2", "abc"), { anchor: 0, head: 1 });
});

test("falls back when the text changed, even at equal length", () => {
  rememberComposerSelection("k3", "abcd", { start: 1, end: 1 });
  assert.equal(takeComposerSelection("k3", "abce"), null);
  rememberComposerSelection("k3", "abcd", { start: 1, end: 1 });
  assert.equal(takeComposerSelection("k3", "abcde"), null);
});

test("keys are independent", () => {
  rememberComposerSelection("lane:a", "x", { start: 0, end: 1 });
  assert.equal(takeComposerSelection("lane:b", "x"), null);
  assert.deepEqual(takeComposerSelection("lane:a", "x"), { anchor: 0, head: 1 });
});

test("forget drops the remembered caret (submit)", () => {
  rememberComposerSelection("k4", "text", { start: 1, end: 2 });
  forgetComposerSelection("k4");
  assert.equal(takeComposerSelection("k4", "text"), null);
});

test("store is bounded and evicts least recently recorded", () => {
  for (let i = 0; i < 64; i++) rememberComposerSelection(`b${i}`, "t", { start: 1, end: 1 });
  rememberComposerSelection("b0", "t", { start: 0, end: 0 }); // re-insert refreshes b0
  rememberComposerSelection("b64", "t", { start: 1, end: 1 }); // evicts b1
  assert.equal(takeComposerSelection("b1", "t"), null);
  assert.deepEqual(takeComposerSelection("b0", "t"), { anchor: 0, head: 0 });
  assert.deepEqual(takeComposerSelection("b64", "t"), { anchor: 1, head: 1 });
  for (let i = 2; i < 64; i++) forgetComposerSelection(`b${i}`);
});
