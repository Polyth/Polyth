import assert from "node:assert/strict";
import test from "node:test";
import { fileDiffStat, parseDiffHunks, parseDiffRows, splitFileDiffs } from "../src/diff.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["diff --git ", "a/", "b/", "--- ", "+++ ", "@@ -1,2 +3,4 @@", "@@", "rename from ", "rename to ", "/dev/null", "\\ No newline at end of file", "+", "-", " ", "\"", "\\\"", "\n", "\n+", "\n-", "\n diff --git a/x b/x\n"];

test("diff parsers never throw and keep one row per line", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const rows = parseDiffRows(input);
    assert.equal(rows.length, input ? input.replace(/\r\n/g, "\n").split("\n").length : 0);
    for (const row of rows) if (row.oldLine !== undefined) assert.ok(Number.isFinite(row.oldLine));
    parseDiffHunks(input);
    const stat = fileDiffStat(input);
    assert.ok(stat.add >= 0 && stat.del >= 0);
  });
});

test("splitFileDiffs yields a non-empty path per file and one file per git header", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const files = splitFileDiffs(input);
    for (const file of files) {
      assert.equal(typeof file.path, "string");
      assert.ok(file.path.length > 0, "empty path");
    }
  });
});

test("diff parsers handle 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => { splitFileDiffs(input); parseDiffRows(input); parseDiffHunks(input); fileDiffStat(input); });
});

// Regression: an empty `+++ ` / rename target used to yield an empty path.
test("splitFileDiffs falls back to the given path when a header names nothing", () => {
  for (const input of ["+++ \n++++ ", "diff --git a/x b/x\n+++ \"", "diff --git x y z\nrename to \n"]) {
    for (const file of splitFileDiffs(input, "fallback.txt")) assert.ok(file.path.length > 0, input);
  }
});
