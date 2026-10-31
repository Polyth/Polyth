// Moved from apps/web/test/modelSelectionUnification.test.ts: the fusion view's
// model selection belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the Fusion view renders the shared model picker", async () => {
  const source = await read("../widgets/FusionView.tsx");
  assert.ok(source.includes('from "@polyth/models/model-picker"'),
    "FusionView.tsx must import the canonical picker from its declared workspace export");
  assert.match(source, /<ModelPicker\b/, "FusionView.tsx must render <ModelPicker>");
  assert.doesNotMatch(source, /packages\/models\/widgets\/ModelPicker\.tsx/,
    "FusionView.tsx must not deep-import the picker implementation");
});

test("Fusion sources use the shared picker's multi-select mode", async () => {
  const fusion = await read("../widgets/FusionView.tsx");
  assert.match(fusion, /<ModelPicker\b[\s\S]*?\bselection=\{[\s\S]*?\bonToggle=\{/,
    "FusionView.tsx must pick its set through ModelPicker");
  assert.doesNotMatch(fusion, /fusion-model-chip|fusion-model-filter/, "Fusion sources are not a chip-grid fork");
});
