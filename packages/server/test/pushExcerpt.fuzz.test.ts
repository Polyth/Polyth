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

// The link patterns `\[([^\]]*)\]\(` used to rescan to the next `]` from every `[`, so the
// 8000-char input window cost ~0.6 s per notification. Links are unwrapped in one pass now.
test("plainTextExcerpt is linear on unclosed link brackets", () => {
  assertBoundedTime(["[", "![", "[a]", "[a](", "[a][", "[[a]"], plainTextExcerpt);
});

test("plainTextExcerpt reduces links to their labels exactly as its patterns did", () => {
  const withPatterns = (text: string): string => text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Brackets only, so nothing else in the excerpt pipeline rewrites the text.
  const alphabet = ["[", "]", "(", ")", "!", "a", "b", " "];
  let seed = 20261118;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const cases = [
    "see [the docs](https://example.com/a) and ![shot](x.png) or [ref][1] end",
    "[a](b)[c](d)", "[[a]](b)", "[a](b", "[a]( b ) c)", "[](x)", "![](x)", "[][x]", "[a][]", "[a][b", "[a] [b]", "[a]x[b](c)",
    "![a][b]", "!![a](b)", "[a](b)](c)", "[a[b](c)", "[a]](b)", "[a\\](b)", "[x](y)[z]", "[x][y](z)",
  ];
  for (let i = 0; i < 4000; i++) {
    let text = "";
    for (let n = 1 + (next() % 14); n > 0; n--) text += alphabet[next() % alphabet.length];
    cases.push(text);
  }
  for (const input of cases) {
    const expected = withPatterns(input).replace(/\s+/g, " ").trim();
    assert.equal(plainTextExcerpt(input, 500), expected, JSON.stringify(input));
  }
});

// Regression: removing emphasis markers joined `<**b>` into a tag after tags were stripped.
test("plainTextExcerpt strips tags that appear once markers are removed", () => {
  assert.doesNotMatch(plainTextExcerpt("a <**b> c <~~i~~> d <scr**ipt>"), /<\/?[a-z]/i);
});
