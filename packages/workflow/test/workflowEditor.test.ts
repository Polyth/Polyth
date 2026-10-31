import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowDto } from "@polyth/contracts";
import {
  insertWorkflowNode,
  moveWorkflowNode,
  resizeWorkflowGroup,
} from "../widgets/workflowGraph.ts";
import {
  shouldAdoptWorkflowSnapshot,
  shouldApplyWorkflowSave,
} from "../widgets/workflowSave.ts";

const graph = (ids: string[], links: Array<[string, string]>): Pick<WorkflowDto, "nodes" | "edges"> => ({
  nodes: ids.map((id) => ({ id, role: id, prompt: id })),
  edges: links.map(([source, target]) => ({ id: `${source}-${target}`, source, target })),
});

const node = (id: string) => ({ id, role: id, prompt: id });
const edgePairs = (value: Pick<WorkflowDto, "nodes" | "edges">) =>
  value.edges.map(({ source, target }) => [source, target]);

test("editor insertion changes dependency roles around the selected node", () => {
  const value = graph(["lead", "review"], [["lead", "review"]]);
  const before = insertWorkflowNode(value, node("research"), "review", "before", (source, target) => `${source}-${target}`);
  assert.deepEqual(edgePairs(before), [["research", "review"], ["lead", "research"]]);

  const after = insertWorkflowNode(value, node("publish"), "lead", "after", (source, target) => `${source}-${target}`);
  assert.deepEqual(edgePairs(after), [["lead", "publish"], ["publish", "review"]]);
});

test("parallel insertion keeps the selected node's incoming and outgoing roles", () => {
  const value = graph(["lead", "review"], [["lead", "review"]]);
  const next = insertWorkflowNode(value, { ...node("tests"), group: "workers" }, "lead", "parallel", (source, target) => `${source}-${target}`);
  assert.deepEqual(edgePairs(next), [["lead", "review"], ["tests", "review"]]);
});

test("moving a node rewires the graph instead of only changing array order", () => {
  const value = graph(["lead", "worker", "review"], [["lead", "worker"], ["worker", "review"]]);
  const next = moveWorkflowNode(value, "worker", -1, (source, target) => `${source}-${target}`);
  assert.deepEqual(edgePairs(next), [["lead", "review"], ["worker", "lead"]]);
});

test("group count creates and removes ordinary replicas with surrounding edges", () => {
  const value = graph(
    ["lead", "worker-a", "review"],
    [["lead", "worker-a"], ["worker-a", "review"]]
  );
  value.nodes[1]!.group = "workers";
  const grown = resizeWorkflowGroup(value, "workers", 3, (() => {
    let next = 0;
    return () => `worker-${++next}`;
  })(), (source, target) => `${source}-${target}`);
  assert.equal(grown.nodes.filter((item) => item.group === "workers").length, 3);
  assert.deepEqual(grown.edges.filter(({ source }) => source === "lead").map(({ target }) => target).sort(), ["worker-1", "worker-2", "worker-a"]);
  assert.deepEqual(grown.edges.filter(({ target }) => target === "review").map(({ source }) => source).sort(), ["worker-1", "worker-2", "worker-a"]);
  const shrunk = resizeWorkflowGroup(grown, "workers", 1, () => "unused", (source, target) => `${source}-${target}`);
  assert.equal(shrunk.nodes.filter((item) => item.group === "workers").length, 1);
  assert.equal(shrunk.edges.some(({ source, target }) => source === "lead" && target === "review"), false);
});

test("autosave ignores stale scopes and preserves newer local edits", () => {
  assert.equal(shouldApplyWorkflowSave("project-a:workflow", "project-b:workflow"), false);
  assert.equal(shouldAdoptWorkflowSnapshot("project-a:workflow", "project-a:workflow", 2, 3), false);
  assert.equal(shouldAdoptWorkflowSnapshot("project-a:workflow", "project-a:workflow", 3, 3), true);
});
