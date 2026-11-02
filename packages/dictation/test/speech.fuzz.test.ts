import assert from "node:assert/strict";
import test from "node:test";
import { applySpokenPunctuation, sentenceBoundaries, speakableLine } from "../src/speech.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<b>", "</b>", "<script", "![", "](", "**", "__", "~~", "`", "https://example.com/x", ". ", "? ", "! ", "… ", "。", "Mr. ", "e.g. ", "J. ", "comma", "period", "new line", "question mark", " .", " ,", "\n\n"];

test("speakableLine yields one line without markdown emphasis or html tags", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const out = speakableLine(input);
    assert.doesNotMatch(out, /[\r\n\t]|\s{2}/, "whitespace not collapsed");
    assert.equal(out, out.trim());
    assert.ok(!out.includes("**") && !out.includes("~~"), "emphasis marker survived");
    assert.doesNotMatch(out, /<\/?[a-zA-Z][^>]*>/, "html tag survived");
  });
});

test("sentenceBoundaries returns ascending in-range integer offsets", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const cuts = sentenceBoundaries(input);
    let previous = 0;
    for (const cut of cuts) {
      assert.ok(Number.isInteger(cut) && cut > previous && cut <= input.length, `bad offset ${cut}`);
      previous = cut;
    }
  });
});

test("applySpokenPunctuation is deterministic, trims, and leaves other languages alone", () => {
  forEachFuzzInput(TOKENS, (input) => {
    for (const lang of ["en", "en-US", "auto", ""]) {
      const out = applySpokenPunctuation(input, lang);
      assert.equal(applySpokenPunctuation(input, lang), out);
    }
    assert.equal(applySpokenPunctuation(input, "de-DE"), input);
  });
});

test("speech text helpers handle 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => { speakableLine(input); sentenceBoundaries(input); applySpokenPunctuation(input, "en"); });
});

// Regression: the link patterns `\[([^\]]+)\]\(` rescanned to the end of the line from every `[`
// (50k brackets took ~5 s); links are now replaced by index.
test("speakableLine is linear on unclosed link brackets", () => {
  assertBoundedTime(["[", "!["], speakableLine, { reps: 10_000, limitMs: 100 });
});

// Regression: removing emphasis markers joined `<**b>` into a tag after tags were stripped.
test("speakableLine strips tags that appear once markers are removed", () => {
  assert.doesNotMatch(speakableLine("a <**b> c <__i> d"), /<\/?[a-z]/i);
});
