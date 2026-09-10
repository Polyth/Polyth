import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowService, layerize } from "../src/index.ts";
import { createWorkflowSampleSeeder, WORKFLOW_SAMPLES } from "../src/samples.ts";

const serviceIn = (dir: string) => createWorkflowService({
  file: join(dir, "workflows.json"),
  append: async () => {},
  runNode: async () => ({ output: "ok" }),
});

test("bundled workflow samples are valid DAGs with parallel work", () => {
  assert.deepEqual(
    WORKFLOW_SAMPLES.map((sample) => sample.key),
    ["build-review", "research-decide", "content-studio"],
  );

  for (const sample of WORKFLOW_SAMPLES) {
    const result = layerize(sample);
    assert.equal(result.ok, true, `${sample.name} should be a valid DAG`);
    if (!result.ok) continue;
    assert.ok(result.layers.some((layer) => layer.length > 1), `${sample.name} should demonstrate parallel execution`);
    assert.ok(sample.nodes.length >= 6, `${sample.name} should demonstrate a meaningful multi-agent workflow`);
  }
});

test("samples are copied into each project once and become normal editable workflows", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-workflow-samples-"));
  const workflow = serviceIn(dir);
  const ensureSamples = createWorkflowSampleSeeder(workflow, join(dir, "workflow-samples.json"));

  ensureSamples("project-a");
  assert.deepEqual(
    workflow.list("project-a").map((item) => item.name).sort(),
    WORKFLOW_SAMPLES.map((sample) => sample.name).sort(),
  );

  ensureSamples("project-a");
  assert.equal(workflow.list("project-a").length, WORKFLOW_SAMPLES.length);

  const removed = workflow.list("project-a")[0]!;
  assert.equal(workflow.remove(removed.id), true);
  ensureSamples("project-a");
  assert.equal(workflow.list("project-a").length, WORKFLOW_SAMPLES.length - 1);

  ensureSamples("project-b");
  assert.equal(workflow.list("project-b").length, WORKFLOW_SAMPLES.length);
});

test("sample seed state survives service restart and does not resurrect deleted samples", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-workflow-samples-reload-"));
  const marker = join(dir, "workflow-samples.json");

  const first = serviceIn(dir);
  createWorkflowSampleSeeder(first, marker)("project");
  const removed = first.list("project")[0]!;
  first.remove(removed.id);

  const second = serviceIn(dir);
  createWorkflowSampleSeeder(second, marker)("project");
  assert.equal(second.list("project").length, WORKFLOW_SAMPLES.length - 1);
  assert.equal(second.list("project").some((item) => item.name === removed.name), false);
});
