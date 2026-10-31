// Moved from apps/web/test/modelSelectionUnification.test.ts: the multi-run
// view's model selection belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the multi-run view renders the shared model picker", async () => {
  const source = await readFile(new URL("../widgets/MultiRunView.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('from "@polyth/models/model-picker"'),
    "MultiRunView.tsx must import the canonical picker from its declared workspace export");
  assert.match(source, /<ModelPicker\b/, "MultiRunView.tsx must render <ModelPicker>");
  assert.doesNotMatch(source, /packages\/models\/widgets\/ModelPicker\.tsx/,
    "MultiRunView.tsx must not deep-import the picker implementation");
  assert.doesNotMatch(source, /<select\b/, "model selection must use ModelPicker, not a native <select>");
  assert.doesNotMatch(source, /<option\b/, "model selection must use ModelPicker, not native <option>s");
});
