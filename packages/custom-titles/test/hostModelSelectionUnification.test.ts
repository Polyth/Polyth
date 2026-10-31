// Moved from apps/web/test/modelSelectionUnification.test.ts: the custom-titles
// settings page's model selection belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the custom-titles settings page renders the shared model picker", async () => {
  const source = await readFile(new URL("../widgets/CustomTitlesSettingsPage.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('from "@polyth/models/model-picker"'),
    "CustomTitlesSettingsPage.tsx must import the canonical picker from its declared workspace export");
  assert.match(source, /<ModelPicker\b/, "CustomTitlesSettingsPage.tsx must render <ModelPicker>");
  assert.doesNotMatch(source, /packages\/models\/widgets\/ModelPicker\.tsx/,
    "CustomTitlesSettingsPage.tsx must not deep-import the picker implementation");
  // The composer's picker is the catalog plus the harness-tabs header seam, not
  // a bare list. Reimplementing either is how this page drifted before.
  assert.ok(source.includes('from "@polyth/models/runtime-catalog"'),
    "CustomTitlesSettingsPage.tsx must read the composer's runtime catalog");
  assert.match(source, /slot="modelPicker.header"/,
    "the picker must mount the shared harness-tabs header seam");
  // The default free generator is the picker's leading row, not a second
  // dropdown next to it.
  assert.match(source, /emptyLabel=\{FREE_MODEL_LABEL\}/,
    "the free default must be the picker's leading row");
  assert.doesNotMatch(source, /value=\{draft\.generator\.kind\}/,
    "the redundant generator-kind Select must stay removed");
});
