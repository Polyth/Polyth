import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWalkthroughPrompt, heuristicStages, parseGeneratedStages,
  parseUnifiedDiffText, parseReviewAssessment, sourceDigestOf,
} from "@polyth/walkthrough";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "+added",
  " line2",
  " line3",
  "@@ -10,2 +11,2 @@",
  "-old",
  "+new",
  " ctx",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -1,1 +1,2 @@",
  " title",
  "+more",
].join("\n");

test("parseUnifiedDiffText splits files and hunks with stable ids", () => {
  const files = parseUnifiedDiffText(DIFF);
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, "src/a.ts");
  assert.equal(files[0]?.hunks.length, 2);
  assert.equal(files[1]?.path, "docs/readme.md");

  // stable: same input, same ids
  const again = parseUnifiedDiffText(DIFF);
  assert.deepEqual(files[0]!.hunks.map((h) => h.id), again[0]!.hunks.map((h) => h.id));

  // hunks at different ranges have different ids even with identical content
  const twin = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts", "+++ b/x.ts",
    "@@ -1,1 +1,1 @@", "-a", "+b",
    "@@ -9,1 +9,1 @@", "-a", "+b",
  ].join("\n");
  const twinFiles = parseUnifiedDiffText(twin);
  const [h1, h2] = twinFiles[0]!.hunks;
  assert.notEqual(h1!.id, h2!.id);
  assert.notEqual(h1!.text, h2!.text); // header differs even when body matches
});

test("parseUnifiedDiffText handles renames and binary files", () => {
  const diff = [
    "diff --git a/old/name.ts b/new/name.ts",
    "similarity index 90%",
    "rename from old/name.ts",
    "rename to new/name.ts",
    "--- a/old/name.ts",
    "+++ b/new/name.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    "diff --git a/logo.png b/logo.png",
    "index 111..222 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");
  const files = parseUnifiedDiffText(diff);
  assert.equal(files[0]?.path, "new/name.ts");
  assert.equal(files[0]?.oldPath, "old/name.ts");
  assert.equal(files[1]?.binary, true);
  assert.equal(files[1]?.hunks.length, 0);
});

test("sourceDigestOf changes when the diff changes", () => {
  assert.equal(sourceDigestOf(DIFF), sourceDigestOf(DIFF));
  assert.notEqual(sourceDigestOf(DIFF), sourceDigestOf(DIFF + "\n+x"));
});

test("heuristicStages groups hunks by top-level directory and flags binaries", () => {
  const files = parseUnifiedDiffText(DIFF);
  const stages = heuristicStages(files);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages.map((s) => s.title), ["Changes in src", "Changes in docs"]);
  assert.equal(stages[0]?.stops.length, 2);
  assert.match(stages[0]!.explanation, /Heuristic/);

  const withBinary = heuristicStages(parseUnifiedDiffText(
    "diff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ",
  ));
  assert.equal(withBinary[0]?.title, "Binary files");
  assert.match(withBinary[0]!.stops[0]!.explanation, /binary/);
});

test("parseGeneratedStages validates hunk ids and appends unclaimed hunks", () => {
  const files = parseUnifiedDiffText(DIFF);
  const ids = files.flatMap((f) => f.hunks.map((h) => h.id));

  const good = parseGeneratedStages(JSON.stringify({
    stages: [{ title: "Core change", explanation: "why", stops: [{ hunkId: ids[0], explanation: "adds a line" }] }],
  }), files);
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.stages[0]?.stops[0]?.explanation, "adds a line");
    // 2 unclaimed hunks land in the trailing stage
    assert.equal(good.stages.at(-1)?.title, "Remaining changes");
    assert.equal(good.stages.at(-1)?.stops.length, 2);
  }

  const unknown = parseGeneratedStages(JSON.stringify({
    stages: [{ title: "x", stops: [{ hunkId: "nope" }] }],
  }), files);
  assert.equal(unknown.ok, false);

  const malformed = parseGeneratedStages("this is not json", files);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.error, /malformed/);

  const fenced = parseGeneratedStages(
    "```json\n" + JSON.stringify({ stages: [{ title: "t", stops: ids.map((hunkId) => ({ hunkId })) }] }) + "\n```",
    files,
  );
  assert.ok(fenced.ok);
});

test("buildWalkthroughPrompt lists every non-binary hunk by id", () => {
  const files = parseUnifiedDiffText(DIFF);
  const prompt = buildWalkthroughPrompt(files);
  for (const f of files) for (const h of f.hunks) assert.ok(prompt.includes(h.id));
  assert.match(prompt, /ONLY JSON/);
});

test("buildWalkthroughPrompt applies one global budget across many and enormous hunks", () => {
  const many = Array.from({ length: 300 }, (_, i) => [
    `diff --git a/src/${i}.ts b/src/${i}.ts`, `--- a/src/${i}.ts`, `+++ b/src/${i}.ts`,
    `@@ -${i + 1},1 +${i + 1},1 @@`, "-old", "+new",
  ].join("\n")).join("\n");
  const prompt = buildWalkthroughPrompt(parseUnifiedDiffText(many), 12_000);
  assert.ok(prompt.length <= 12_000);
  const huge = buildWalkthroughPrompt(parseUnifiedDiffText(
    `diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n${" context\n".repeat(20_000)}-old\n+new`,
  ), 2_000);
  assert.ok(huge.length <= 2_000);
  assert.match(huge, /\+new/);
});

// ---- review assessment parser ------------------------------------------------

test("parseReviewAssessment accepts a valid payload and clamps benign noise", () => {
  const r = parseReviewAssessment(JSON.stringify({
    summary: "solid change",
    findings: [
      { severity: "high", path: "a.ts", line: 3, body: "check null", confidence: 1.4 },
      { severity: "low", body: "style nit" },
    ],
    riskScore: 2.4,
    confidenceScore: 5,
  }));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.assessment.riskScore, 2);
    assert.equal(r.assessment.findings[0]?.confidence, 1);
    assert.equal(r.assessment.findings[1]?.confidence, 0.5);
    assert.equal(r.assessment.findings[1]?.path, undefined);
  }
});

test("parseReviewAssessment rejects malformed structures strictly", () => {
  const cases = [
    "not json",
    JSON.stringify({ findings: [], riskScore: 3, confidenceScore: 3 }),                     // no summary
    JSON.stringify({ summary: "s", findings: [], riskScore: 9, confidenceScore: 3 }),        // risk out of range
    JSON.stringify({ summary: "s", findings: [], riskScore: "high", confidenceScore: 3 }),   // risk from prose
    JSON.stringify({ summary: "s", findings: [{ severity: "urgent", body: "x" }], riskScore: 3, confidenceScore: 3 }),
    JSON.stringify({ summary: "s", findings: [{ severity: "high", body: "" }], riskScore: 3, confidenceScore: 3 }),
    JSON.stringify({ summary: "s", findings: "none", riskScore: 3, confidenceScore: 3 }),
  ];
  for (const c of cases) {
    const r = parseReviewAssessment(c);
    assert.equal(r.ok, false, c.slice(0, 60));
  }
});
