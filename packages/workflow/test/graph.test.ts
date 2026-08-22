import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowDto } from "@polyth/contracts";
import { ancestors, layerize, upstream, wouldCycle } from "../src/graph.ts";

const graph = (
  ids: string[],
  links: Array<[string, string]>,
): Pick<WorkflowDto, "nodes" | "edges"> => ({
  nodes: ids.map((id) => ({ id, role: id, prompt: `Do ${id}` })),
  edges: links.map(([source, target], index) => ({ id: `e${index}`, source, target })),
});

test("layerize produces deterministic topological execution layers", () => {
  const result = layerize(graph(
    ["review", "research", "write", "plan"],
    [["research", "plan"], ["plan", "write"], ["write", "review"]],
  ));
  assert.deepEqual(result, {
    ok: true,
    layers: [["research"], ["plan"], ["write"], ["review"]],
  });
});

test("layerize keeps independent nodes in the same layer", () => {
  const result = layerize(graph(
    ["synthesize", "beta", "alpha"],
    [["alpha", "synthesize"], ["beta", "synthesize"]],
  ));
  assert.deepEqual(result, {
    ok: true,
    layers: [["alpha", "beta"], ["synthesize"]],
  });
});

test("layerize rejects empty, invalid, duplicate, and cyclic graphs", () => {
  assert.deepEqual(layerize(graph([], [])), { ok: false, error: "workflow has no nodes" });
  const invalid = layerize(graph(["a"], [["missing", "a"]]));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.error, /unknown source/);
  const duplicate = graph(["a", "a"], []);
  const duplicateResult = layerize(duplicate);
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.match(duplicateResult.error, /duplicate/);
  const cyclic = layerize(graph(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]));
  assert.deepEqual(cyclic, { ok: false, error: "workflow contains a cycle" });
});

test("duplicate edges do not inflate indegrees", () => {
  const value = graph(["a", "b"], [["a", "b"], ["a", "b"]]);
  assert.deepEqual(layerize(value), { ok: true, layers: [["a"], ["b"]] });
});

test("wouldCycle detects only edges that close a path", () => {
  const value = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  assert.equal(wouldCycle(value, "c", "a"), true);
  assert.equal(wouldCycle(value, "a", "c"), false);
  assert.equal(wouldCycle(value, "b", "b"), true);
});

test("upstream and ancestors return direct and transitive dependencies", () => {
  const value = graph(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]);
  assert.deepEqual(upstream(value, "d").sort(), ["b", "c"]);
  assert.deepEqual([...ancestors(value, "d")].sort(), ["a", "b", "c"]);
});
