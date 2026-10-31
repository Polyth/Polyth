import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";
import { drainComposerReplacement, requestComposerCompareReplace } from "../src/composerInsert.ts";

const event = (seq: number, type: string, data: JsonObject): SessionEvent => ({
  id: `e${seq}`, seq, type, data, sessionId: "parent", time: seq, v: 1,
});

test("workflow replay retains retry provenance, assignments, and final synthesis", () => {
  const model = buildModel([
    event(1, "workflow/run-started", {
      runId: "run", workflowId: "workflow", name: "Development", input: "Build",
      projectId: "project", parentSessionId: "parent", clientOperationId: "launch", retryOf: "previous",
      layers: [["review"]], nodes: [{ id: "review", role: "Review", status: "queued", harness: { mode: "pinned", harnessId: "codex" }, attempt: 2 }],
    }),
    event(2, "workflow/node-progress", { runId: "run", nodeId: "review", node: { id: "review", role: "Review", status: "done", output: "Verified", attempt: 2 } }),
    event(3, "workflow/run-completed", { runId: "run", status: "done", result: "The implementation is verified.", finishedAt: 3 }),
  ]);
  assert.equal(model.workflowRun?.clientOperationId, "launch");
  assert.equal(model.workflowRun?.retryOf, "previous");
  assert.equal(model.workflowRun?.nodes[0]?.attempt, 2);
  assert.equal(model.workflowRun?.result, "The implementation is verified.");
  assert.equal(model.workflowRun?.status, "done");
  assert.equal(model.workflowRunSeq, 1, "the chat card anchors at its start event");
});

test("old workflow events replay and interrupted execution remains distinct", () => {
  const model = buildModel([
    event(1, "workflow/run-started", { runId: "old", workflowId: "legacy", name: "Old", input: "Task", layers: [], nodes: [] }),
    event(2, "workflow/run-completed", { runId: "old", status: "error", interrupted: true }),
    event(3, "workflow/unknown-future-event", {}),
  ]);
  assert.equal(model.workflowRun?.interrupted, true);
  assert.equal(model.workflowRun?.status, "error");
  assert.equal(model.workflowRun?.clientOperationId, undefined);
});

test("partial node progress merges over the known node while legacy snapshots replace it", () => {
  const model = buildModel([
    event(1, "workflow/run-started", {
      runId: "run", workflowId: "workflow", name: "Delta", input: "Build", layers: [["a"]],
      nodes: [{ id: "a", role: "Writer", status: "queued" }],
    }),
    // First publish: a full snapshot carrying the prompt.
    event(2, "workflow/node-progress", { runId: "run", nodeId: "a", node: { id: "a", role: "Writer", status: "running", prompt: "# Role", activity: "thinking", attempt: 1 } }),
    // Streamed output grows by deltas; the prompt is never repeated.
    event(3, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "running", sessionId: "child" }, outputDelta: "Hello" }),
    event(4, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "running", activity: "tool: bash" }, outputDelta: " world" }),
    // A full output rewrite and a cleared activity.
    event(5, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "done", output: "Final", activity: null, finishedAt: 5 } }),
  ]);
  const node = model.workflowRun?.nodes[0];
  assert.equal(node?.status, "done");
  assert.equal(node?.prompt, "# Role");
  assert.equal(node?.sessionId, "child");
  assert.equal(node?.attempt, 1);
  assert.equal(node?.output, "Final");
  assert.equal(node?.activity, undefined);
  assert.equal("activity" in (node ?? {}), false);
  assert.equal(node?.finishedAt, 5);

  const streamed = buildModel([
    event(1, "workflow/run-started", { runId: "run", workflowId: "workflow", name: "Delta", input: "Build", layers: [["a"]], nodes: [{ id: "a", role: "Writer", status: "queued" }] }),
    event(2, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "running" }, outputDelta: "Hello" }),
    event(3, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "running" }, outputDelta: " world" }),
    // A legacy full snapshot after partial events replaces the node wholesale.
    event(4, "workflow/node-progress", { runId: "run", nodeId: "a", node: { id: "a", role: "Writer", status: "done", output: "Replaced" } }),
  ]);
  assert.equal(streamed.workflowRun?.nodes[0]?.output, "Replaced");
  assert.equal(streamed.workflowRun?.nodes[0]?.role, "Writer");
  assert.equal(buildModel([
    event(1, "workflow/run-started", { runId: "run", workflowId: "workflow", name: "Delta", input: "Build", layers: [["a"]], nodes: [{ id: "a", role: "Writer", status: "queued" }] }),
    event(2, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "running" }, outputDelta: "Hello" }),
    event(3, "workflow/node-progress", { runId: "run", nodeId: "a", partial: true, node: { id: "a", status: "running" }, outputDelta: " world" }),
  ]).workflowRun?.nodes[0]?.output, "Hello world");
});

test("a late conditional draft replacement never queues into a future composer", () => {
  drainComposerReplacement();
  assert.equal(requestComposerCompareReplace({ scopeKey: "old-space/session", expectedText: "", text: "Failed request" }), false);
  assert.equal(drainComposerReplacement(), undefined);
});
