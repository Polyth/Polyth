// Moved from apps/web/test/modelSelectionUnification.test.ts: the memory
// settings page's model selection belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the memory settings page picks its utility model instead of typing it", async () => {
  const source = await readFile(new URL("../widgets/MemorySettings.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('from "@polyth/models/model-picker"'),
    "MemorySettings.tsx must import the canonical picker from its declared workspace export");
  assert.match(source, /<ModelPicker\b/, "MemorySettings.tsx must render <ModelPicker>");
  assert.doesNotMatch(source, /packages\/models\/widgets\/ModelPicker\.tsx/,
    "MemorySettings.tsx must not deep-import the picker implementation");
  assert.doesNotMatch(source, /exact (provider|model) id/, "the utility model is picked, not typed");
});
