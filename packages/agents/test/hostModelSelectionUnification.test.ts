// Moved from apps/web/test/modelSelectionUnification.test.ts: the schedule
// Agent editor's model selection belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the Agent editor renders the shared model picker", async () => {
  const source = await read("../widgets/AgentEditor.tsx");
  assert.ok(source.includes('from "@polyth/models/model-picker"'),
    "AgentEditor.tsx must import the canonical picker from its declared workspace export");
  assert.match(source, /<ModelPicker\b/, "AgentEditor.tsx must render <ModelPicker>");
  assert.doesNotMatch(source, /packages\/models\/widgets\/ModelPicker\.tsx/,
    "AgentEditor.tsx must not deep-import the picker implementation");
});
