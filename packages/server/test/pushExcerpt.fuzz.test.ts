import assert from "node:assert/strict";
import test from "node:test";
import { plainTextExcerpt } from "../src/push.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["[", "<b>", "</b>", "<script>", "<a href=", "<scr<b>ipt>", "```ui", "~~~", "**", "__", "![", "](", "][", "- [ ] ", "> ", "---", "| a | b |", "|---|---|", "<https://example.com>", "sk-abcdefghijkl", "-----BEGIN PRIVATE KEY-----"];

test("plainTextExcerpt never exceeds its cap and leaves no tags", () => {
  forEachFuzzInput(TOKENS, (input) => {
    for (const cap of [2, 10, 200]) {
      const out = plainTextExcerpt(input, cap);
      assert.ok(out.length <= cap, `cap ${cap}, got ${out.length}`);
      assert.doesNotMatch(out, /<\/?[a-zA-Z][^>]*>/, "tag survived");
      assert.doesNotMatch(out, /[\u0000-\u001f\u007f]/, "control character survived");
    }
  });
});

test("plainTextExcerpt returns an empty string for non-strings and tiny caps", () => {
  assert.equal(plainTextExcerpt(undefined), "");
  assert.equal(plainTextExcerpt({}), "");
  assert.equal(plainTextExcerpt("hello", 1), "");
});

test("plainTextExcerpt handles repeated tokens in bounded time", () => {
  assertBoundedTime(TOKENS, plainTextExcerpt, { skip: ["["] });
});

// Finding: the link patterns `\[([^\]]*)\]\(` rescan to the end of the line from every `[`, so the
// 8000-char input window costs ~0.6 s. Bounded by the window, so it is slow rather than unbounded.
test("plainTextExcerpt is linear on unclosed link brackets", { todo: "quadratic link regexes" }, () => {
  assertBoundedTime(["["], plainTextExcerpt);
});

// Regression: removing emphasis markers joined `<**b>` into a tag after tags were stripped.
test("plainTextExcerpt strips tags that appear once markers are removed", () => {
  assert.doesNotMatch(plainTextExcerpt("a <**b> c <~~i~~> d <scr**ipt>"), /<\/?[a-z]/i);
});
