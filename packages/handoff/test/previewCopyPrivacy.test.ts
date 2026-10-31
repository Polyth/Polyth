import test from "node:test";
import assert from "node:assert/strict";
import { bundleCopyText } from "../src/bundleRender.ts";

test("bundleCopyText excludes removed preview sections", () => {
  const bundle = {
    id: "b1",
    projectId: "p",
    sessionId: "s",
    presetId: "review",
    label: "Review",
    instruction: "Review this",
    sections: [
      { id: "keep", sourceId: "git-diff", title: "Diff", body: "KEEP_ME", tokens: 1, fingerprint: "a" },
      { id: "drop", sourceId: "changed-files", title: "Files", body: "DROP_ME", tokens: 1, fingerprint: "b" },
    ],
    sources: [],
    markdown: "unused",
    tokens: 2,
    createdAt: Date.now(),
    fingerprints: {},
  };
  const text = bundleCopyText(bundle, new Set(["drop"]));
  assert.match(text, /KEEP_ME/);
  assert.doesNotMatch(text, /DROP_ME/);
});
