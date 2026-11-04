import assert from "node:assert/strict";
import test from "node:test";
import { errorBodyText } from "../src/index.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<html>", "</html>", "<head>", "<title>", "</title>", "<body>", "<h1>", "<p>", "<br>", "<script>", "</script>", "<style>", "<!DOCTYPE html>", "&lt;", "&#60;", "&#x3c;", "&#99999999;", "&nbsp;", "<![CDATA["];

test("errorBodyText never throws and respects its limit for markup bodies", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const text = errorBodyText(input);
    assert.equal(typeof text, "string");
    // Plain text is returned unchanged (trimmed); only markup is cut to the limit.
    if (text !== input.trim()) assert.ok(text.length <= 200, `length ${text.length}`);
    assert.equal(errorBodyText(input, { limit: 20 }).length <= Math.max(20, input.trim().length), true);
  });
});

test("errorBodyText returns plain text unchanged", () => {
  forEachFuzzInput([], (input) => {
    if (/<\s*(?:!doctype|html|head|body|title|h[1-6]|p|div|center|br|table|pre)\b/i.test(input)) return;
    assert.equal(errorBodyText(input), input.trim());
  });
});

test("errorBodyText handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => errorBodyText(`<html>${input}`));
});
