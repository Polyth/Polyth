import test from "node:test";
import assert from "node:assert/strict";
import { setLocale } from "../src/i18n/index.ts";
import {
  workflowNodeCount,
  workflowStatusLabel,
  workflowTimelineNodes,
} from "../src/workflowRun.ts";

test("workflow labels use localized plural and status messages", () => {
  setLocale("en");
  assert.equal(workflowNodeCount(0), "0 nodes");
  assert.equal(workflowNodeCount(1), "1 node");
  assert.equal(workflowNodeCount(2), "2 nodes");
  assert.equal(workflowStatusLabel("running"), "Running");
  assert.equal(workflowStatusLabel("error"), "Failed");
});

test("collapsed workflow windows expose exact omitted-range metadata", () => {
  const run = {
    id: "run",
    workflowId: "workflow",
    name: "Release",
    input: "Ship",
    status: "running" as const,
    startedAt: 1,
    layers: [],
    nodes: Array.from({ length: 12 }, (_, index) => ({
      id: `node-${index + 1}`,
      role: `Node ${index + 1}`,
      status: index < 7 ? "done" as const : index === 7 ? "running" as const : "queued" as const,
    })),
  };
  const window = workflowTimelineNodes(run, false);
  assert.deepEqual(
    {
      start: window.start,
      end: window.end,
      total: window.total,
      truncatedBefore: window.truncatedBefore,
      truncatedAfter: window.truncatedAfter,
    },
    { start: 5, end: 10, total: 12, truncatedBefore: true, truncatedAfter: true },
  );
});
