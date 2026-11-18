import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeProjectIconSvg } from "../src/projects.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["<script", "</script>", "<foreignObject", "</foreignObject>", " onload=", " onclick='x'", " href=", " xlink:href=", "javascript:", "<?xml", "?>", "<!doctype", "<svg", "</svg>", "<path d=\"M0\"/>", "﻿"];

function unsafeResidue(svg: string): string | null {
  if (/<\/?(?:script|foreignObject)\b/i.test(svg)) return "script/foreignObject tag";
  if (/\son\w+\s*=\s*[^\s>]/i.test(svg)) return "event handler attribute";
  if (/\s(?:xlink:)?href\s*=\s*(?:"(?!#)|'(?!#)|[^\s"'>#])/i.test(svg)) return "non-fragment href";
  return null;
}

test("server sanitizeProjectIconSvg never throws, is idempotent and leaves nothing unsafe", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const once = sanitizeProjectIconSvg(input);
    assert.equal(unsafeResidue(once), null, "unsafe residue");
    assert.equal(sanitizeProjectIconSvg(once), once, "not idempotent");
  });
});

/** Tokens whose unterminated runs make a lazy `[\s\S]*?` or `[^>]*` rescan the tail from every start. */
const QUADRATIC = ["<script", "<foreignObject", "<?xml", "<!doctype", "<script>", "<script>x"];

test("server sanitizeProjectIconSvg handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, sanitizeProjectIconSvg, { skip: QUADRATIC });
});

// These used to take 0.2-1 s at 5k repetitions and ~50 s at 50k (the paired-element and
// `<?xml`/`<!doctype` patterns rescanned the tail from every opener), so a 350 KB icon pinned
// the event loop. The sanitizer scans them in one pass now.
test("server sanitizeProjectIconSvg is linear on unterminated openers", () => {
  assertBoundedTime(QUADRATIC, sanitizeProjectIconSvg, { reps: 5_000, limitMs: 100 });
  // One far-away `>` that every opener's tag would run to.
  for (const run of ["<script", "<foreignObject", "<script <foreignObject "]) {
    const input = `${run.repeat(20_000)}>`;
    const started = performance.now();
    sanitizeProjectIconSvg(input);
    const took = performance.now() - started;
    assert.ok(took < 200, `${JSON.stringify(run)} x20000 + ">" took ${took.toFixed(0)} ms`);
  }
});

/** The patterns this sanitizer used before its one-pass scanners. Kept as the
 *  definition of what the scanners must remove: same output on every input. */
function sanitizeWithPatterns(svg: string): string {
  let clean = svg.replace(/^\uFEFF/, "");
  for (let previous = ""; previous !== clean;) {
    previous = clean;
    clean = clean.replace(/<\?xml[\s\S]*?\?>/gi, "");
    clean = clean.replace(/<!doctype[\s\S]*?>/gi, "");
    clean = clean.replace(/<(script|foreignObject)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
    clean = clean.replace(/<\/?(?:script|foreignObject)\b[^>]*>?/gi, "");
    clean = clean.replace(/\sxmlns:xlink\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
    clean = clean.replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"?|'(?!#)[^']*'?|[^\s"'>#][^\s>]*)/gi, "");
    clean = clean.replace(/\son\w+\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s"'>]+)/gi, "");
  }
  return clean.trim();
}

test("server sanitizeProjectIconSvg removes exactly what its patterns removed", () => {
  forEachFuzzInput(TOKENS, (input) => {
    assert.equal(sanitizeProjectIconSvg(input), sanitizeWithPatterns(input));
  });
  for (const input of [
    "<?xml version='1.0'?><svg><script>a</script><path/></svg>",
    "<?XML a ?><!DOCTYPE svg><svg/>",
    "<svg><script >a</SCRIPT ><foreignObject x='1'>b</foreignobject\n>c</svg>",
    // A closing tag of the other element does not end this one.
    "<foreignObject>A<script>B</foreignObject>C</script>D",
    "<script>B<foreignObject>A</script>C</foreignObject>D",
    // An opener inside another opener's tag, and openers that never close.
    "<script <script>x</script>y", "<script a<foreignObject>b</foreignObject>", "<script>a<foreignObject>b</foreignObject>c",
    "<foreignObject>a<script>b</script>c", "<script<script>>a</script></script>", "<scr<script></script>ipt>alert(1)</script>",
    "<?xml<?xml ?>x?>", "<!doctype<!doctype>>", "<?xml", "?><?xml?>", "<!doctype", "<scripty>keep</scripty><script-x>a</script-x>",
  ]) {
    assert.equal(sanitizeProjectIconSvg(input), sanitizeWithPatterns(input), input);
  }
});

test("sanitizeProjectIconSvg drops attribute values whose quote never closes", () => {
  for (const input of ["<svg><a xlink:href='javascript:x'></a>", "<svg><a href=\"javascript:x", "<svg onload=\"x", "<svg onload='x"]) {
    const clean = sanitizeProjectIconSvg(input);
    assert.equal(unsafeResidue(clean), null, clean);
    assert.ok(!/javascript:|onload=/.test(clean), clean);
  }
});
