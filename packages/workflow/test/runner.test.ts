import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionService } from "@polyth/contracts";
import { createWorkflowRunNode } from "../src/runner.ts";

const event = (seq: number, type: string, data: Record<string, unknown>): SessionEvent => ({
  id: `event-${seq}`,
  sessionId: "child",
  seq,
  time: seq,
  type,
  data: data as SessionEvent["data"],
  v: 1,
});

test("manual workflow nodes expose approval activity and keep the child navigable", async () => {
  const settings: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async (_id: string, setting: string) => {
      settings.push(setting);
      return { setting, effective: setting === "on" };
    },
    send: async () => ({}),
    events: async () => [
      event(1, "permission/requested", { requestId: "p1", permission: "bash" }),
      event(2, "assistant/message", { partId: "answer", text: "finished" }),
      event(3, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => {},
  } as unknown as SessionService;

  const result = await createWorkflowRunNode(sessions)({
    parentSessionId: "parent",
    runId: "run",
    workflowId: "workflow",
    projectId: "project",
    node: { id: "node", role: "Reviewer", prompt: "Review" },
    prompt: "Review the change",
    permissions: "manual",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }, async (patch) => { updates.push(patch); });

  assert.deepEqual(settings, ["off"]);
  assert.equal(result.sessionId, "child");
  assert.equal(result.output, "finished");
  assert.ok(updates.some((patch) => patch.sessionId === "child"));
  assert.ok(updates.some((patch) => patch.activity === "awaiting permission: bash"));
});

test("workflow timeout error is human-readable and aborts the child", async () => {
  let aborted = false;
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async () => ({}),
    events: async () => [],
    abort: async () => { aborted = true; },
  } as unknown as SessionService;

  await assert.rejects(
    () => createWorkflowRunNode(sessions)({
      parentSessionId: "parent",
      runId: "run",
      workflowId: "workflow",
      projectId: "project",
      node: { id: "node", role: "Slow node", prompt: "Wait" },
      prompt: "Wait",
      permissions: "manual",
      timeoutMs: 5,
      signal: new AbortController().signal,
    }, async () => {}),
    /Timed out after 5ms\. Open the child session/,
  );
  assert.equal(aborted, true);
});

test("terminal assistant markers do not erase streamed workflow output", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => ({ setting: "on", effective: true }),
    send: async () => ({}),
    events: async () => [
      event(1, "assistant/chunk", { partId: "answer", text: "kept output" }),
      event(2, "assistant/message", { partId: "answer" }),
      event(3, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => {},
  } as unknown as SessionService;

  const result = await createWorkflowRunNode(sessions)({
    parentSessionId: "parent",
    runId: "run",
    workflowId: "workflow",
    projectId: "project",
    node: { id: "node", role: "Writer", prompt: "Write" },
    prompt: "Write the answer",
    permissions: "auto",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }, async (patch) => { updates.push(patch); });

  assert.equal(result.output, "kept output");
  assert.equal(updates.at(-1)?.output, "kept output");
});

test("stopping during permission setup aborts the child before sending work", async () => {
  let releaseSetup!: () => void;
  let setupStarted!: () => void;
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  const started = new Promise<void>((resolve) => { setupStarted = resolve; });
  let aborted = false;
  let sent = false;
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => {
      setupStarted();
      await setupGate;
      return { setting: "off", effective: false };
    },
    send: async () => { sent = true; return {}; },
    events: async () => [],
    abort: async () => { aborted = true; },
  } as unknown as SessionService;
  const controller = new AbortController();

  const run = createWorkflowRunNode(sessions)({
    parentSessionId: "parent",
    runId: "run",
    workflowId: "workflow",
    projectId: "project",
    node: { id: "node", role: "Reviewer", prompt: "Review" },
    prompt: "Review the change",
    permissions: "manual",
    timeoutMs: 1_000,
    signal: controller.signal,
  }, async () => {});
  await started;
  controller.abort();
  releaseSetup();

  await assert.rejects(run, (cause: unknown) =>
    cause instanceof Error && cause.name === "AbortError");
  assert.equal(aborted, true);
  assert.equal(sent, false);
});
