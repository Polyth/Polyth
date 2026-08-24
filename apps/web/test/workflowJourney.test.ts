import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";
import { handOffWorkflowLaunch, takeWorkflowLaunch } from "../src/workflowLaunch.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("chat hands its draft and direct-run result to the workflow surface", () => {
  handOffWorkflowLaunch({
    projectId: "project",
    sessionId: "parent",
    workflowId: "workflow",
    input: "Audit the release",
    run: {
      id: "run",
      workflowId: "workflow",
      projectId: "project",
      parentSessionId: "parent",
      name: "Release",
      input: "Audit the release",
      status: "running",
      startedAt: 1,
      layers: [["review"]],
      nodes: [{ id: "review", role: "Reviewer", status: "queued" }],
    },
  });
  assert.equal(takeWorkflowLaunch("other"), null, "another project cannot consume the hand-off");
  const launch = takeWorkflowLaunch("project");
  assert.equal(launch?.input, "Audit the release");
  assert.equal(launch?.run?.parentSessionId, "parent");
  assert.equal(takeWorkflowLaunch("project"), null, "the hand-off is one-shot");
});

test("workflow event replay preserves global monitoring and retry metadata", () => {
  const started: SessionEvent = {
    id: "e1",
    sessionId: "parent",
    seq: 1,
    time: 10,
    type: "workflow/run-started",
    data: {
      runId: "run",
      workflowId: "workflow",
      projectId: "project",
      parentSessionId: "parent",
      name: "Release",
      input: "Ship safely",
      options: { pipe: "direct", permissions: "manual", maxParallel: 2, nodeTimeoutMs: 60_000 },
      startedAt: 10,
      layers: [["review"]],
      nodes: [{ id: "review", role: "Reviewer", status: "queued" }],
    },
    v: 1,
  };
  const waiting: SessionEvent = {
    id: "e2",
    sessionId: "parent",
    seq: 2,
    time: 11,
    type: "workflow/node-progress",
    data: {
      runId: "run",
      nodeId: "review",
      node: {
        id: "review",
        role: "Reviewer",
        status: "running",
        sessionId: "child",
        activity: "awaiting permission: bash",
      },
    },
    v: 1,
  };
  const run = buildModel([started, waiting]).workflowRun;
  assert.equal(run?.projectId, "project");
  assert.equal(run?.parentSessionId, "parent");
  assert.equal(run?.options?.permissions, "manual");
  assert.equal(run?.nodes[0]?.sessionId, "child");
});

test("workflow journey surfaces expose task launch, chat progress, HITL, stop, and retry", async () => {
  const [launcher, composer, timeline, workflow, miniWidgets, status] = await Promise.all([
    source("../src/components/WorkflowLauncher.tsx"),
    source("../src/components/Composer.tsx"),
    source("../src/components/Timeline.tsx"),
    source("../src/components/WorkflowView.tsx"),
    source("../src/widgets/builtinMiniWidgets.tsx"),
    source("../src/components/StatusBar.tsx"),
  ]);
  assert.match(launcher, /Your draft becomes the shared task/);
  assert.match(launcher, /api\.runWorkflow/);
  assert.match(composer, /workflowDraftText: text/);
  assert.match(timeline, /<WorkflowTimelineCard run=\{model\.workflowRun\}/);
  assert.match(workflow, /Review & respond/);
  assert.match(workflow, /Retry full workflow/);
  assert.match(workflow, /Stop run/);
  assert.match(miniWidgets, /workflow\.active-run/);
  assert.match(status, /Approval needed/);
});
