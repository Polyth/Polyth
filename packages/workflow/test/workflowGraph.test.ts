import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowDto } from "@polyth/contracts";
import { layerizeWorkflow, wouldWorkflowCycle } from "../widgets/workflowGraph.ts";

const graph = (
  ids: string[],
  links: Array<[string, string]>,
): Pick<WorkflowDto, "nodes" | "edges"> => ({
  nodes: ids.map((id) => ({ id, role: id, prompt: `Do ${id}` })),
  edges: links.map(([source, target], index) => ({ id: `edge-${index}`, source, target })),
});

test("workflow preview produces deterministic parallel execution layers", () => {
  assert.deepEqual(
    layerizeWorkflow(graph(
      ["publish", "write", "research", "review"],
      [["research", "write"], ["write", "review"], ["review", "publish"]],
    )),
    { ok: true, layers: [["research"], ["write"], ["review"], ["publish"]] },
  );
  assert.deepEqual(
    layerizeWorkflow(graph(["final", "beta", "alpha"], [["beta", "final"], ["alpha", "final"]])),
    { ok: true, layers: [["alpha", "beta"], ["final"]] },
  );
});

test("workflow preview ignores duplicate edges and reports malformed graphs", () => {
  assert.deepEqual(
    layerizeWorkflow(graph(["a", "b"], [["a", "b"], ["a", "b"]])),
    { ok: true, layers: [["a"], ["b"]] },
  );
  assert.deepEqual(layerizeWorkflow(graph([], [])), { ok: false, error: "workflow has no nodes" });
  assert.deepEqual(
    layerizeWorkflow(graph(["a", "b"], [["a", "b"], ["b", "a"]])),
    { ok: false, error: "workflow contains a cycle" },
  );
});

test("dependency toggles reject only edges that close a path", () => {
  const value = graph(["research", "write", "review"], [
    ["research", "write"],
    ["write", "review"],
  ]);
  assert.equal(wouldWorkflowCycle(value, "review", "research"), true);
  assert.equal(wouldWorkflowCycle(value, "research", "review"), false);
  assert.equal(wouldWorkflowCycle(value, "write", "write"), true);
});
