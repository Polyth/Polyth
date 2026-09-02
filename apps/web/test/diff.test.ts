import test from "node:test";
import assert from "node:assert/strict";
import {
  fileDiffsFromInput,
  fileDiffStat,
  normalizePatch,
  parseDiffRows,
  splitFileDiffs,
  unifiedDiff,
} from "../src/diff.ts";

test("unifiedDiff returns empty string when text is unchanged", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
});

test("unifiedDiff produces a standard hunk with context for a small edit", () => {
  const diff = unifiedDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n", "foo.txt");
  assert.ok(diff.startsWith("--- a/foo.txt\n+++ b/foo.txt\n"));
  assert.ok(diff.includes("@@ -1,3 +1,3 @@"));
  assert.ok(diff.includes("-line2"));
  assert.ok(diff.includes("+CHANGED"));
  assert.ok(diff.includes(" line1"));
  assert.ok(diff.includes(" line3"));
  assert.deepEqual(fileDiffStat(diff), { add: 1, del: 1 });
});

test("unifiedDiff treats a fresh write as an all-insert file", () => {
  const diff = unifiedDiff("", "hello\nworld\n", "new.txt");
  assert.ok(diff.startsWith("--- /dev/null\n+++ b/new.txt\n"));
  assert.ok(diff.includes("@@ -0,0 +1,2 @@"));
  assert.ok(diff.includes("+hello"));
  assert.ok(diff.includes("+world"));
  assert.deepEqual(fileDiffStat(diff), { add: 2, del: 0 });
});

test("unifiedDiff separates two distant changes into two hunks", () => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const newLines = [...oldLines];
  newLines[0] = "CHANGED0";
  newLines[19] = "CHANGED19";
  const diff = unifiedDiff(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`, "f");
  const hunkCount = diff.split("\n").filter((line) => line.startsWith("@@")).length;
  assert.equal(hunkCount, 2);
});

test("parseDiffRows assigns old and new source line numbers", () => {
  const rows = parseDiffRows([
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -10,3 +10,4 @@",
    " keep",
    "-old",
    "+new",
    "+also",
    " still",
  ].join("\n"));
  assert.equal(rows[0]?.kind, "meta");
  assert.equal(rows[2]?.kind, "hunk");
  assert.deepEqual(rows[3], { text: " keep", kind: "ctx", oldLine: 10, newLine: 10 });
  assert.deepEqual(rows[4], { text: "-old", kind: "del", oldLine: 11 });
  assert.deepEqual(rows[5], { text: "+new", kind: "add", newLine: 11 });
  assert.deepEqual(rows[6], { text: "+also", kind: "add", newLine: 12 });
  assert.deepEqual(rows[7], { text: " still", kind: "ctx", oldLine: 12, newLine: 13 });
});

test("normalizePatch turns apply_patch markers into git file headers", () => {
  const normalized = normalizePatch([
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "*** Add File: src/b.ts",
    "+hello",
    "*** End Patch",
  ].join("\n"));
  const files = splitFileDiffs(normalized);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "src/a.ts");
  assert.equal(files[0]?.status, "modified");
  assert.deepEqual(files[0]?.stats, { add: 1, del: 1 });
  assert.equal(files[1]?.path, "src/b.ts");
  assert.equal(files[1]?.status, "added");
  assert.deepEqual(files[1]?.stats, { add: 1, del: 0 });
});

test("parseDiffRows treats add/delete lines as content even without a hunk header", () => {
  const rows = parseDiffRows("--- /dev/null\n+++ b/src/b.ts\n+hello\n+world");
  assert.deepEqual(rows.filter((row) => row.kind !== "meta"), [
    { text: "+hello", kind: "add", newLine: 1 },
    { text: "+world", kind: "add", newLine: 2 },
  ]);
});

test("fileDiffsFromInput reads patchText, old/new strings, and edits arrays", () => {
  const fromPatch = fileDiffsFromInput({
    patchText: "*** Update File: src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  });
  assert.equal(fromPatch[0]?.path, "src/a.ts");
  assert.deepEqual(fromPatch[0]?.stats, { add: 1, del: 1 });

  const fromEdit = fileDiffsFromInput({
    filePath: "src/b.ts",
    oldString: "one\ntwo",
    newString: "one\nthree",
  });
  assert.equal(fromEdit[0]?.path, "src/b.ts");
  assert.deepEqual(fromEdit[0]?.stats, { add: 1, del: 1 });

  const fromEdits = fileDiffsFromInput({
    filePath: "src/c.ts",
    edits: [{ old_string: "a", new_string: "b" }],
  });
  assert.deepEqual(fromEdits[0]?.stats, { add: 1, del: 1 });
});
