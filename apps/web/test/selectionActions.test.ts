// F3 selection quick actions: markdown quoting is bounded and block-shaped,
// the derived session title clips to its cap, and the floating menu never
// leaves the viewport. Pure helpers — no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMenuPosition, quoteForReply, selectionTitle } from "../src/selectionActions.ts";

test("quoteForReply prefixes every line and leaves the caret on a fresh line", () => {
  assert.equal(quoteForReply("one line"), "> one line\n\n");
  assert.equal(
    quoteForReply("first\nsecond"),
    "> first\n> second\n\n",
  );
  // blank interior lines stay part of the same quote block (bare ">")
  assert.equal(
    quoteForReply("para one\n\npara two"),
    "> para one\n>\n> para two\n\n",
  );
  // CRLF normalizes; leading/trailing whitespace trims before quoting
  assert.equal(quoteForReply("\r\n  a\r\nb  \r\n"), "> a\n> b\n\n");
  // interior indentation survives (only the string's edges trim)
  assert.equal(quoteForReply("head\n  indented"), "> head\n>   indented\n\n");
  assert.equal(quoteForReply("   \n  "), "");
});

test("quoteForReply caps a select-all so the draft cannot flood", () => {
  const out = quoteForReply("x".repeat(10_000));
  assert.ok(out.length < 4_200);
  assert.ok(out.includes("…"));
  assert.ok(out.startsWith("> "));
  assert.ok(out.endsWith("\n\n"));
});

test("selectionTitle takes the first non-empty line, clipped", () => {
  assert.equal(selectionTitle("Fix the bug\nmore detail"), "Fix the bug");
  assert.equal(selectionTitle("\n\n  indented lead  \nrest"), "indented lead");
  assert.equal(selectionTitle(""), "From selection");
  const long = selectionTitle(`${"t".repeat(100)}`);
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("clampMenuPosition keeps the menu inside the viewport", () => {
  // fits: unchanged
  assert.deepEqual(clampMenuPosition(100, 50, 270, 34, 1280, 800), { x: 100, y: 50 });
  // off every edge: clamped with the 8px margin
  assert.deepEqual(clampMenuPosition(-40, -40, 270, 34, 1280, 800), { x: 8, y: 8 });
  assert.deepEqual(clampMenuPosition(2000, 2000, 270, 34, 1280, 800), { x: 1280 - 270 - 8, y: 800 - 34 - 8 });
});
