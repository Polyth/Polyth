import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";
import { handOffWorkflowLaunch, takeWorkflowLaunch } from "../src/workflowLaunch.ts";
import {
  fresherWorkflowRun,
  prioritizeWorkflowRuns,
  workflowHumanWait,
  workflowNodeDetail,
} from "../src/workflowRun.ts";

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

test("workflow status helpers keep action-required and terminal states honest", () => {
  assert.equal(workflowHumanWait({
    id: "permission",
    role: "Reviewer",
    status: "running",
    activity: "awaiting permission: bash",
  }), "permission");
  assert.equal(workflowHumanWait({
    id: "answer",
    role: "Reviewer",
    status: "running",
    activity: "awaiting answer",
  }), "answer");
  assert.equal(workflowNodeDetail({
    id: "failed",
    role: "Reviewer",
    status: "error",
    error: "The review command failed",
  }), "The review command failed");

  const running = {
    id: "run",
    workflowId: "workflow",
    name: "Release",
    input: "Ship",
    status: "running" as const,
    startedAt: 1,
    layers: [["review"]],
    nodes: [{ id: "review", role: "Reviewer", status: "running" as const }],
  };
  const stopped = {
    ...running,
    status: "stopped" as const,
    finishedAt: 2,
    nodes: [{ id: "review", role: "Reviewer", status: "stopped" as const }],
  };
  assert.equal(fresherWorkflowRun(stopped, running)?.status, "stopped");
});

test("global workflow indicators prioritize action-required runs", () => {
  const background = {
    id: "newer",
    workflowId: "background",
    name: "Background",
    input: "Run checks",
    status: "running" as const,
    startedAt: 20,
    layers: [["check"]],
    nodes: [{ id: "check", role: "Checker", status: "running" as const, activity: "thinking" }],
  };
  const blocked = {
    ...background,
    id: "older",
    workflowId: "approval",
    name: "Approval",
    startedAt: 10,
    nodes: [{
      id: "review",
      role: "Reviewer",
      status: "running" as const,
      activity: "awaiting permission: bash",
    }],
  };
  const finished = { ...background, id: "finished", status: "done" as const };
  assert.deepEqual(
    prioritizeWorkflowRuns([background, finished, blocked]).map((run) => run.id),
    ["older", "newer"],
  );
});

test("workflow journey surfaces expose task launch, chat progress, HITL, stop, and retry", async () => {
  const [launcher, composer, timeline, workflow, miniWidgets, status, styles] = await Promise.all([
    source("../src/components/WorkflowLauncher.tsx"),
    source("../src/components/Composer.tsx"),
    source("../src/components/Timeline.tsx"),
    source("../src/components/WorkflowView.tsx"),
    source("../src/widgets/builtinMiniWidgets.tsx"),
    source("../src/components/StatusBar.tsx"),
    source("../src/styles.css"),
  ]);
  assert.match(launcher, /Your draft becomes the shared task/);
  assert.match(launcher, /api\.runWorkflow/);
  assert.ok(
    launcher.indexOf("consumeDraft();") < launcher.indexOf("await api.runWorkflow"),
    "the workflow consumes the draft before run-started can remount Composer",
  );
  assert.ok(
    launcher.indexOf("consumeDraft();") < launcher.indexOf("publishWorkflowRun(started);"),
    "the accepted workflow consumes the draft before global indicators can remount Composer",
  );
  assert.match(launcher, /if \(draftConsumed\) requestComposerReplace\(submittedTask\)/);
  assert.match(composer, /workflowDraftText: text/);
  assert.match(composer, /workflowAttachmentCount: attachments\.length/);
  assert.match(composer, /activeSessionId === target\) requestComposerReplace\(""\)/);
  assert.match(timeline, /<WorkflowTimelineCard run=\{model\.workflowRun\}/);
  assert.match(timeline, /model\.messages\.length === 0 && !model\.workflowRun/);
  assert.match(await source("../src/components/WorkflowTimelineCard.tsx"), /handOffWorkflowLaunch/);
  assert.match(workflow, /Review & respond/);
  assert.match(workflow, /Retry full workflow/);
  assert.match(workflow, /Stop run/);
  assert.match(miniWidgets, /workflow\.active-run/);
  assert.match(status, /Approval needed/);
  assert.match(styles, /\.app\.view-session \.statusbar:has\(\.sb-workflow\) \{ display: flex; \}/);
  assert.match(styles, /\.app\.mode-chat\.view-session \.statusbar:has\(\.sb-workflow\) \{ display: flex; \}/);
});
