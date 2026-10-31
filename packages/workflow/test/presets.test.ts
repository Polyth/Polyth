import test from "node:test";
import assert from "node:assert/strict";
import { layerize } from "../src/graph.ts";
import { getWorkflowPreset, orderWorkflows, topologySummary, workflowPresets } from "../src/presets.ts";

test("the small canonical catalog is valid and does not share mutable user state", () => {
  const first = workflowPresets("project-a");
  assert.equal(first.length, 7);
  assert.equal(new Set(first.map((preset) => preset.id)).size, 7);
  for (const preset of first) {
    assert.equal(preset.builtin, true);
    assert.equal(preset.preset?.version, 1);
    assert.equal(layerize(preset).ok, true);
    assert.equal(preset.defaults?.permissions, "manual");
    assert.ok(preset.nodes.every((node) => node.role && node.prompt));
  }
  first[0]!.nodes[0]!.role = "Changed";
  assert.equal(workflowPresets("project-a")[0]!.nodes[0]!.role, "Builder");
  assert.deepEqual(workflowPresets(" "), []);
});

test("preset identifiers preserve project identity and fail closed for malformed ids", () => {
  const preset = workflowPresets("project:with/characters")[2]!;
  assert.deepEqual(getWorkflowPreset(preset.id), preset);
  assert.notEqual(preset.id, workflowPresets("other")[2]!.id);
  assert.equal(getWorkflowPreset("preset:%broken:development"), null);
  assert.equal(getWorkflowPreset("preset:project:missing"), null);
  assert.equal(getWorkflowPreset("custom-workflow"), null);
});

test("the single-agent Simple workflow is not in the catalog", () => {
  assert.ok(!workflowPresets("p").some((preset) => preset.preset?.id === "simple" || preset.name === "Simple"));
  assert.equal(getWorkflowPreset("preset:p:simple"), null, "an old Simple id no longer resolves");
});

test("compact topology teaches sequential and repeated parallel execution", () => {
  const presets = workflowPresets("p");
  assert.equal(topologySummary(presets.find((preset) => preset.name === "Build + Review")!), "Builder → Reviewer");
  assert.equal(topologySummary(presets.find((preset) => preset.name === "Development")!), "Lead → Worker ×2 → Reviewer");
  assert.equal(topologySummary(presets.find((preset) => preset.name === "Visual Development")!), "Lead → UI Worker ×2 → Visual Reviewer");
});

test("favorites, selection, recents, and category reorder without hiding any workflows", () => {
  const presets = workflowPresets("p");
  const ordered = orderWorkflows(presets, {
    pinnedIds: [presets[3]!.id], selectedId: presets[5]!.id,
    recentIds: [presets[0]!.id], category: "review",
  });
  assert.deepEqual(ordered.slice(0, 4).map((preset) => preset.name), ["Visual Development", "Research", "Build + Review", "Review"]);
  assert.deepEqual(new Set(ordered.map((preset) => preset.id)), new Set(presets.map((preset) => preset.id)));
  assert.equal(presets[0]!.name, "Build + Review", "ordering does not mutate cached catalog");
});
