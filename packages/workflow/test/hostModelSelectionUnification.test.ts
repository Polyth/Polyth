// Moved from apps/web/test/modelSelectionUnification.test.ts: the workflow
// view's model selection belongs with the package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the Workflow view renders the shared model picker", async () => {
  const source = await read("../widgets/WorkflowView.tsx");
  assert.ok(source.includes('from "@polyth/models/model-picker"'),
    "WorkflowView.tsx must import the canonical picker from its declared workspace export");
  assert.match(source, /<ModelPicker\b/, "WorkflowView.tsx must render <ModelPicker>");
  assert.doesNotMatch(source, /packages\/models\/widgets\/ModelPicker\.tsx/,
    "WorkflowView.tsx must not deep-import the picker implementation");
});

test("the workflow Auto allow-list uses the shared picker's multi-select mode", async () => {
  const workflow = await read("../widgets/WorkflowView.tsx");
  assert.match(workflow, /<ModelPicker\b[\s\S]*?\bselection=\{[\s\S]*?\bonToggle=\{/,
    "WorkflowView.tsx must pick its set through ModelPicker");
  assert.doesNotMatch(workflow, /kind: "checkbox"/, "the Auto allow-list is not a checkbox menu fork");
});
