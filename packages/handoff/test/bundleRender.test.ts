import test from "node:test";
import assert from "node:assert/strict";
import { bundleCopyText, renderBundleMarkdown } from "../src/bundleRender.ts";
import { hashText } from "../src/hash.ts";
import type { ContextBundleDto } from "@polyth/contracts";

function sampleBundle(sections: ContextBundleDto["sections"]): ContextBundleDto {
  return {
    id: "b1",
    projectId: "p1",
    sessionId: "s1",
    presetId: "review",
    label: "Review",
    instruction: "Please review",
    sections,
    sources: [],
    markdown: "",
    tokens: 10,
    createdAt: Date.now(),
    fingerprints: {},
  };
}

test("renderBundleMarkdown keeps sections with heading-like file bodies intact", () => {
  const md = renderBundleMarkdown([
    { title: "src/a.ts", body: "# not a section\nline two" },
    { title: "Task", body: "fix bug" },
  ], "go");
  assert.match(md, /# src\/a\.ts/);
  assert.match(md, /# not a section/);
  assert.match(md, /# Task/);
  assert.match(md, /# Instruction/);
});

test("bundleCopyText respects excluded section ids", () => {
  const bundle = sampleBundle([
    { id: "keep", sourceId: "a", title: "Keep", body: "stay", tokens: 1, fingerprint: "1" },
    { id: "drop", sourceId: "b", title: "Drop", body: "gone", tokens: 1, fingerprint: "2" },
  ]);
  const text = bundleCopyText(bundle, new Set(["drop"]));
  assert.match(text, /Keep/);
  assert.doesNotMatch(text, /gone/);
});

test("hashText changes when content changes with same length prefix", () => {
  const a = "x".repeat(100);
  const b = "y".repeat(100);
  assert.notEqual(hashText(a), hashText(b));
});
