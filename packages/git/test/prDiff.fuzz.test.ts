import assert from "node:assert/strict";
import test from "node:test";
import { parsePrDiffLines, splitPrDiff } from "../widgets/prDiff.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["diff --git ", "a/", "b/", "--- ", "+++ ", "@@ -1,2 +3,4 @@", "rename from ", "copy to ", "/dev/null", "\\ No newline at end of file", "+", "-", " ", "\"", "\\\"", "\n", "\n+", "\n-", "\ndiff --git a/x b/x\n"];

test("splitPrDiff never throws and emits one patch per git header", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const headers = input.replace(/\r\n/g, "\n").split("\n").filter((line) => line.startsWith("diff --git ")).length;
    const files = splitPrDiff(input);
    if (input.trim() && headers) {
      assert.equal(files.length, headers);
      for (const file of files) assert.ok(file.diff.startsWith("diff --git "), "patch must start at its header");
    }
    for (const file of files) assert.ok(file.path.length > 0, "empty path");
  });
});

test("parsePrDiffLines keeps one row per line with finite line numbers", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const rows = parsePrDiffLines(input);
    assert.equal(rows.length, input.split("\n").length);
    for (const row of rows) for (const n of [row.oldLine, row.newLine]) if (n !== undefined) assert.ok(Number.isFinite(n));
  });
});

test("PR diff parsers handle 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => { splitPrDiff(input); parsePrDiffLines(input); });
});

// Regression: an empty `+++ ` / copy target used to yield an empty path.
test("splitPrDiff never returns an empty path", () => {
  for (const input of ["diff --git a/x b/x\n+++ \"", "diff --git a/x b/x\ncopy to \n", "diff --git x y z\nrename to \n"]) {
    for (const file of splitPrDiff(input)) assert.ok(file.path.length > 0, input);
  }
});
