import test from "node:test";
import assert from "node:assert/strict";
import { setLocale } from "../../../apps/web/src/i18n/index.ts";
import {
  workflowDisplayText,
  workflowNodeCount,
  workflowStatusLabel,
  workflowTimelineNodes,
} from "../widgets/workflowRun.ts";

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

test("recorded workflow output keeps at most one blank line between blocks", () => {
  const gapped = [
    "Reviewing the diff.", "", "", "", "",
    "Tests pass.", "", "", "", "", "",
    "Checking the layout profile.",
  ].join("\n\n");
  assert.equal(workflowDisplayText(gapped), "Reviewing the diff.\n\nTests pass.\n\nChecking the layout profile.");
  assert.equal(workflowDisplayText("A\r\n\r\n\r\n\r\nB"), "A\n\nB", "CRLF output collapses too");
  assert.equal(workflowDisplayText("\n\n  \nA  \n \n \n\nB\n\n"), "A\n\nB", "whitespace-only lines count as blank");
  assert.equal(workflowDisplayText("A\n\nB\nC"), "A\n\nB\nC", "single blank lines and line breaks are untouched");
  assert.equal(workflowDisplayText("  indented first line"), "  indented first line", "leading indentation of text is kept");
  assert.equal(workflowDisplayText(" \n\n\n "), "");
  assert.equal(workflowDisplayText(undefined), "");
});
