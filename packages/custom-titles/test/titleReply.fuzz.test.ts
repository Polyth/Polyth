import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_TITLE_MAX_CHARS, readGeneratedTitle, sanitizeGeneratedTitle } from "../src/titleReply.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<think>", "</think>", "<answer>", "</answer>", "<title>", "```json", "```", "{\"title\":", "\"}", "Title:", "Here is", "\u001b[0m", "​", "Sure!", "<|im_start|>", "<b>", "</b>"];

test("readGeneratedTitle never throws and returns a bounded single-line title or a rejection", () => {
  forEachFuzzInput(TOKENS, (input) => {
    for (const message of [undefined, "fix the build"]) {
      const result = readGeneratedTitle(input, message);
      if ("title" in result) {
        assert.ok(result.title.trim().length > 0, "empty title");
        assert.ok(result.title.length <= CUSTOM_TITLE_MAX_CHARS + 1, `title length ${result.title.length}`);
        assert.doesNotMatch(result.title, /[\r\n]/, "multi-line title");
      } else {
        assert.ok(result.rejected.length > 0);
      }
    }
    assert.equal(typeof sanitizeGeneratedTitle(input), "string");
  });
});

test("readGeneratedTitle handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, readGeneratedTitle);
});
