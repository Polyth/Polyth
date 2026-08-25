// WP7 pure logic: commit-graph lane layout and review-comment anchoring.
import test from "node:test";
import assert from "node:assert";
import { layoutGraph } from "../src/git/graph.ts";
import { commentState, hunkDigest, splitHunks, type ReviewComment } from "../src/review/anchors.ts";
import { GIT_PREFS_KEY, getGitPrefs, parseGitPrefs, setGitPrefs, splitDiffRows } from "../src/gitPrefs.ts";
import { parsePrDiffLines, splitPrDiff } from "../src/prDiff.ts";

test("graph: linear history stays in lane 0", () => {
  const rows = layoutGraph([
    { sha: "c3", parents: ["c2"] },
    { sha: "c2", parents: ["c1"] },
    { sha: "c1", parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.through), [[], [], []]);
});

test("graph: merge opens a second lane and converges at the fork point", () => {
  // merge M has parents main(c2) and feature(f1); both branched from c1.
  const rows = layoutGraph([
    { sha: "M", parents: ["c2", "f1"] },
    { sha: "c2", parents: ["c1"] },
    { sha: "f1", parents: ["c1"] },
    { sha: "c1", parents: [] },
  ]);
  assert.equal(rows[0]!.lane, 0);
  assert.equal(rows[0]!.edges.length, 2);       // two parent edges = merge
  assert.equal(rows[1]!.lane, 0);                // main continues in lane 0
  assert.deepEqual(rows[1]!.through, [1]);       // feature passes through
  assert.equal(rows[2]!.lane, 1);                // feature dot in lane 1
  assert.equal(rows[3]!.lane, 0);                // fork point back to lane 0
  assert.deepEqual(rows[3]!.through, []);        // lanes converged
});

test("graph: unrelated roots get separate lanes", () => {
  const rows = layoutGraph([
    { sha: "a2", parents: ["a1"] },
    { sha: "b1", parents: [] },
    { sha: "a1", parents: [] },
  ]);
  assert.equal(rows[0]!.lane, 0);
  assert.equal(rows[1]!.lane, 1);
  assert.equal(rows[2]!.lane, 0);
});

test("git prefs parse, persist, and split diffs align replacement runs", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
    },
  });
  assert.deepEqual(parseGitPrefs("bad"), {
    layout: "unified", ignoreWhitespace: false, wrap: false, changesView: "tree",
  });
  setGitPrefs({ layout: "split", ignoreWhitespace: true, wrap: true, changesView: "flat" });
  assert.deepEqual(parseGitPrefs(values.get(GIT_PREFS_KEY) ?? null), getGitPrefs());

  const rows = splitDiffRows("@@ -1,2 +1,2 @@\n-old one\n-old two\n+new one\n context");
  assert.deepEqual(rows.slice(1, 3), [
    { left: "-old one", right: "+new one", kind: "change" },
    { left: "-old two", right: "", kind: "change" },
  ]);
});

const DIFF = `diff --git a/x.ts b/x.ts
index 111..222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,4 @@
 line one
+added line
 line two
 line three
@@ -10,2 +11,2 @@ function f() {
-old body
+new body
`;

test("review: splitHunks parses headers, bodies, and start lines", () => {
  const hunks = splitHunks(DIFF);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.startNew, 1);
  assert.equal(hunks[1]!.startNew, 11);
  assert.deepEqual(hunks[0]!.body, [" line one", "+added line", " line two", " line three"]);
  assert.ok(!hunks[0]!.body.some((l) => l.startsWith("+++") || l.startsWith("---")));
});

test("review: digest is content-based and line-number independent", () => {
  const a = splitHunks(DIFF)[0]!;
  const shifted = { ...a, header: "@@ -50,3 +51,4 @@", startNew: 51 };
  assert.equal(hunkDigest(a), hunkDigest(shifted));
  const changed = { ...a, body: [...a.body.slice(0, 1), "+different line", ...a.body.slice(2)] };
  assert.notEqual(hunkDigest(a), hunkDigest(changed));
});

test("review: comments stay current while their hunk exists, then go outdated", () => {
  const hunks = splitHunks(DIFF);
  const c: ReviewComment = {
    id: "rc1", path: "x.ts", digest: hunkDigest(hunks[0]!), line: 2, text: "check this", createdAt: 1,
  };
  assert.equal(commentState(c, hunks), "current");
  // Source changed: the anchored hunk is gone.
  const newDiff = DIFF.replace("+added line", "+a very different line");
  assert.equal(commentState(c, splitHunks(newDiff)), "outdated");
  assert.equal(commentState(c, []), "outdated");
});

test("PR diff splits files and preserves rename metadata", () => {
  const files = splitPrDiff([
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/README.md b/README.md",
    "index 111..222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    " title",
    "+details",
  ].join("\n"));

  assert.equal(files.length, 2);
  assert.deepEqual(
    { path: files[0]!.path, previousPath: files[0]!.previousPath },
    { path: "src/new.ts", previousPath: "src/old.ts" },
  );
  assert.equal(files[1]!.path, "README.md");
  assert.match(files[1]!.diff, /\+details/);
});

test("PR diff keeps deletion paths and handles empty patches", () => {
  const files = splitPrDiff([
    "diff --git a/obsolete.txt b/obsolete.txt",
    "deleted file mode 100644",
    "--- a/obsolete.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
  ].join("\n"));
  assert.equal(files[0]!.path, "obsolete.txt");
  assert.deepEqual(splitPrDiff(""), []);
});

test("PR diff handles quoted rename and mode-only metadata without inventing line numbers", () => {
  const files = splitPrDiff([
    'diff --git "a/docs/old name.md" "b/docs/new name.md"',
    "similarity index 100%",
    "rename from docs/old name.md",
    "rename to docs/new name.md",
    'diff --git "a/bin/tool script" "b/bin/tool script"',
    "old mode 100644",
    "new mode 100755",
  ].join("\n"));
  assert.deepEqual(
    files.map(({ path, previousPath }) => ({ path, previousPath })),
    [
      { path: "docs/new name.md", previousPath: "docs/old name.md" },
      { path: "bin/tool script", previousPath: undefined },
    ],
  );

  const rows = parsePrDiffLines([
    "diff --git a/a.ts b/a.ts",
    "old mode 100644",
    "new mode 100755",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -4,2 +4,2 @@",
    " context",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n"));
  assert.deepEqual(
    rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })),
    [
      { kind: "meta", oldLine: undefined, newLine: undefined },
      { kind: "meta", oldLine: undefined, newLine: undefined },
      { kind: "meta", oldLine: undefined, newLine: undefined },
      { kind: "meta", oldLine: undefined, newLine: undefined },
      { kind: "meta", oldLine: undefined, newLine: undefined },
      { kind: "hunk", oldLine: undefined, newLine: undefined },
      { kind: "context", oldLine: 4, newLine: 4 },
      { kind: "delete", oldLine: 5, newLine: undefined },
      { kind: "add", oldLine: undefined, newLine: 5 },
      { kind: "sentinel", oldLine: undefined, newLine: undefined },
      { kind: "meta", oldLine: undefined, newLine: undefined },
    ],
  );
});

test("PR diff treats --- and +++ lines inside hunks as file content", () => {
  const rows = parsePrDiffLines([
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -10,2 +10,2 @@",
    "--- old heading",
    "+++ new heading",
    " context",
  ].join("\n"));

  assert.deepEqual(
    rows.slice(1).map(({ text, kind, oldLine, newLine }) => ({ text, kind, oldLine, newLine })),
    [
      { text: "--- a/notes.md", kind: "meta", oldLine: undefined, newLine: undefined },
      { text: "+++ b/notes.md", kind: "meta", oldLine: undefined, newLine: undefined },
      { text: "@@ -10,2 +10,2 @@", kind: "hunk", oldLine: undefined, newLine: undefined },
      { text: "--- old heading", kind: "delete", oldLine: 10, newLine: undefined },
      { text: "+++ new heading", kind: "add", oldLine: undefined, newLine: 10 },
      { text: " context", kind: "context", oldLine: 11, newLine: 11 },
    ],
  );
});
