// WP7 pure logic: commit-graph lane layout and review-comment anchoring.
import test from "node:test";
import assert from "node:assert";
import { layoutGraph } from "../src/git/graph.ts";
import { commentState, hunkDigest, splitHunks, type ReviewComment } from "../src/review/anchors.ts";

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
