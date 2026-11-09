import test from "node:test";
import assert from "node:assert/strict";
import { locatePassage } from "../src/conversationPassage.ts";

test("a passage is found across text nodes, ignoring whitespace and case", () => {
  assert.deepEqual(locatePassage(["Повну перевірку ", "запускай", " рідше."], "перевірку\nЗАПУСКАЙ"), {
    startSegment: 0, startOffset: 6, endSegment: 1, endOffset: 8,
  });
});

test("a selection spanning two blocks matches their text with nothing between", () => {
  assert.deepEqual(locatePassage(["Кінець абзацу.", "Початок наступного."], "абзацу.\n\nПочаток"), {
    startSegment: 0, startOffset: 7, endSegment: 1, endOffset: 7,
  });
});

test("an absent or empty passage finds nothing", () => {
  assert.equal(locatePassage(["Some text"], "other"), null);
  assert.equal(locatePassage(["Some text"], "  \n "), null);
  assert.equal(locatePassage([], "text"), null);
});

test("a character whose lower case is longer still maps back to the source", () => {
  const found = locatePassage(["xİy"], "y");
  assert.deepEqual(found, { startSegment: 0, startOffset: 2, endSegment: 0, endOffset: 3 });
});
