import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeProjectIconSvg } from "../src/projectIconPicker.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<script", "</script>", "<foreignObject", "</foreignObject>", " onload=", " onclick='x'", " href=", " xlink:href=", "javascript:", "<?xml", "?>", "<!doctype", "<svg", "</svg>", "<path d=\"M0\"/>", "﻿"];

/** What must never survive: script-ish elements, event handlers, external hrefs. */
function unsafeResidue(svg: string): string | null {
  if (/<\/?(?:script|foreignObject)\b/i.test(svg)) return "script/foreignObject tag";
  if (/\son\w+\s*=\s*[^\s>]/i.test(svg)) return "event handler attribute";
  if (/\s(?:xlink:)?href\s*=\s*(?:"(?!#)|'(?!#)|[^\s"'>#])/i.test(svg)) return "non-fragment href";
  return null;
}

test("web sanitizeProjectIconSvg never throws, is idempotent and leaves nothing unsafe", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const once = sanitizeProjectIconSvg(input);
    assert.equal(unsafeResidue(once), null, "unsafe residue");
    assert.equal(sanitizeProjectIconSvg(once), once, "not idempotent");
  });
});

/** Tokens whose unterminated runs make a lazy `[\s\S]*?` or `[^>]*` rescan the tail from every start. */
const QUADRATIC = ["<script", "<foreignObject", "<?xml", "<!doctype", "<script>", "<script>x"];

test("web sanitizeProjectIconSvg handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, sanitizeProjectIconSvg, { skip: QUADRATIC });
});

// Finding: 5k repetitions already take 0.2-1 s and 50k take ~50 s (quadratic backtracking in the
// paired-element and `<?xml`/`<!doctype` patterns), so a 350 KB icon pins the event loop.
test("web sanitizeProjectIconSvg is linear on unterminated openers", { todo: "quadratic regex backtracking" }, () => {
  assertBoundedTime(QUADRATIC, sanitizeProjectIconSvg, { reps: 5_000, limitMs: 100 });
});

test("sanitizeProjectIconSvg drops attribute values whose quote never closes", () => {
  for (const input of ["<svg><a xlink:href='javascript:x'></a>", "<svg><a href=\"javascript:x", "<svg onload=\"x", "<svg onload='x"]) {
    const clean = sanitizeProjectIconSvg(input);
    assert.equal(unsafeResidue(clean), null, clean);
    assert.ok(!/javascript:|onload=/.test(clean), clean);
  }
});
