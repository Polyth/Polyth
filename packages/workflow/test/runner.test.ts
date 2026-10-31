import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionService } from "@polyth/contracts";
import { createWorkflowRunNode } from "../src/runner.ts";
import { buildNodePrompt } from "../src/prompt.ts";

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
  let reads = 0;
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async (_id: string, setting: string) => {
      settings.push(setting);
      return { setting, effective: setting === "on" };
    },
    send: async () => ({}),
    // The session owner marks the child waiting once its policy holds the
    // request for a person.
    snapshot: async () => ({ id: "child", status: "waiting" }),
    events: async () => ++reads === 1 ? [
      event(1, "permission/requested", { requestId: "p1", permission: "bash" }),
    ] : [
      event(2, "permission/resolved", { requestId: "p1", reply: "once" }),
      event(3, "assistant/message", { partId: "answer", text: "finished" }),
      event(4, "turn/stopped", { reason: "completed" }),
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

  assert.deepEqual(settings, ["inherit"], "a manual node follows the launching chat's approval level");
  assert.equal(result.sessionId, "child");
  assert.equal(result.output, "finished");
  assert.ok(updates.some((patch) => patch.sessionId === "child"));
  const activities = updates.map((patch) => patch.activity).filter(Boolean);
  const waiting = activities.indexOf("awaiting permission: bash");
  assert.ok(waiting >= 0);
  assert.equal(activities[waiting + 1], "thinking", "the answered request ends the person's turn");
});

test("an expired question or secret request stops asking the person to answer", async () => {
  for (const [asked, expired] of [["question/asked", "question/expired"], ["secret/requested", "secret/expired"]] as const) {
    const updates: Array<Record<string, unknown>> = [];
    let reads = 0;
    const sessions = {
      create: async () => ({ id: "child" }),
      autoAcceptSet: async (_id: string, setting: string) => ({ setting, effective: false }),
      send: async () => ({}),
      events: async () => ++reads === 1 ? [event(1, asked, { requestId: "q1" })] : reads === 2 ? [
        event(2, expired, { requestId: "q1" }),
      ] : [
        event(3, "assistant/message", { partId: "answer", text: "finished" }),
        event(4, "turn/stopped", { reason: "completed" }),
      ],
      abort: async () => {},
    } as unknown as SessionService;
    await createWorkflowRunNode(sessions)(runContext(), async (patch) => { updates.push(patch); });
    const activities = updates.map((patch) => patch.activity).filter(Boolean);
    const waiting = activities.indexOf("awaiting answer");
    assert.ok(waiting >= 0, asked);
    assert.equal(activities[waiting + 1], "thinking", `${expired} ends the wait`);
  }
});

test("auto nodes get routine Auto-Approve but keep the chat's Full access", async () => {
  for (const [chatLevel, expected] of [["off", "on"], ["routine", "on"], ["all", "inherit"], [undefined, "on"]] as const) {
    const settings: string[] = [];
    const reads: string[] = [];
    const sessions = {
      create: async () => ({ id: "child" }),
      ...(chatLevel ? {
        autoAcceptGet: async (id: string) => {
          reads.push(id);
          return { setting: "inherit", effective: chatLevel !== "off", level: chatLevel };
        },
      } : {}),
      autoAcceptSet: async (_id: string, setting: string) => {
        settings.push(setting);
        return { setting, effective: true };
      },
      send: async () => ({}),
      events: async () => [
        event(1, "assistant/message", { partId: "answer", text: "finished" }),
        event(2, "turn/stopped", { reason: "completed" }),
      ],
      abort: async () => {},
    } as unknown as SessionService;
    await createWorkflowRunNode(sessions)({ ...runContext(), permissions: "auto" }, async () => {});
    assert.deepEqual(settings, [expected], `chat level ${chatLevel}`);
    assert.deepEqual(reads, chatLevel ? ["parent"] : []);
  }
});

test("requests the node's own policy answers never show as waiting for a person", async () => {
  // Full access: the child log records each request before the policy answers
  // it. A poll can land between the two, in the same batch or across batches.
  for (const split of [false, true]) {
    const updates: Array<Record<string, unknown>> = [];
    let reads = 0;
    let snapshots = 0;
    const requested = event(1, "permission/requested", { requestId: "p1", permission: "bash" });
    const rest = [
      event(2, "permission/resolved", { requestId: "p1", reply: "once", auto: true }),
      event(3, "assistant/message", { partId: "answer", text: "finished" }),
      event(4, "turn/stopped", { reason: "completed" }),
    ];
    const sessions = {
      create: async () => ({ id: "child" }),
      autoAcceptSet: async (_id: string, setting: string) => ({ setting, effective: true }),
      send: async () => ({}),
      snapshot: async () => { snapshots++; return { id: "child", status: "working" }; },
      events: async () => split ? (++reads === 1 ? [requested] : rest) : (++reads === 1 ? [requested, ...rest] : []),
      abort: async () => {},
    } as unknown as SessionService;
    const result = await createWorkflowRunNode(sessions)(
      { ...runContext(), permissions: "auto" },
      async (patch) => { updates.push(patch); },
    );
    assert.equal(result.output, "finished");
    assert.equal(updates.some((patch) => /^awaiting/.test(String(patch.activity ?? ""))), false);
    assert.equal(snapshots, split ? 1 : 0);
  }
});

const runContext = () => ({
  parentSessionId: "parent", projectId: "project", workflowId: "workflow", runId: "run",
  node: { id: "verify", role: "Verifier", prompt: "Verify the change" },
  prompt: "Verify the change", permissions: "manual" as const,
  timeoutMs: 1_000, signal: new AbortController().signal,
});

test("a scheduled capacity resume keeps verification running without submitting another turn", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let sends = 0;
  let reads = 0;
  const sessions = {
    create: async () => ({ id: "child" }),
    send: async () => { sends++; return {}; },
    events: async () => ++reads === 1 ? [
      event(1, "assistant/message", { partId: "progress", text: "I will run the checks." }),
      event(2, "turn/stopped", {
        reason: "error", error: "Selected model is at capacity.",
        retry: { scope: "overloaded", resumeAt: Date.now() + 10, attempt: 1 },
      }),
    ] : [
      event(3, "turn/resume-cancelled", { reason: "resumed" }),
      event(4, "turn/started", { turnId: "resumed" }),
      event(5, "assistant/message", { partId: "result", text: "Tests passed; fix the missing icon." }),
      event(6, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => assert.fail("the server owns the scheduled continuation"),
  } as unknown as SessionService;
  const result = await createWorkflowRunNode(sessions)(runContext(), async (patch) => { updates.push(patch); });
  assert.equal(sends, 1, "the workflow must not replay an admitted mutation");
  assert.equal(result.output, "Tests passed; fix the missing icon.");
  assert.ok(updates.some((patch) => patch.activity === "waiting for provider capacity"));
});

test("cancelling a scheduled capacity resume stops the node", async () => {
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [
      event(1, "turn/stopped", { reason: "error", retry: { resumeAt: Date.now() + 100, attempt: 1 } }),
      event(2, "turn/resume-cancelled", { reason: "user" }),
    ],
  } as unknown as SessionService;
  await assert.rejects(() => createWorkflowRunNode(sessions)(runContext(), async () => {}), { name: "AbortError" });
});

test("a node a person paused keeps waiting for Continue, and their Stop ends it", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let reads = 0;
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => ++reads === 1 ? [
      event(1, "assistant/message", { partId: "progress", text: "Halfway there." }),
      event(2, "turn/stopped", { reason: "aborted", paused: true }),
    ] : [
      event(3, "session/pause-ended", { outcome: "continued" }),
      event(4, "turn/started", { turnId: "continued" }),
      event(5, "assistant/message", { partId: "result", text: "Done after the pause." }),
      event(6, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => assert.fail("a pause is the person's; the node does not stop it"),
  } as unknown as SessionService;
  const result = await createWorkflowRunNode(sessions)(runContext(), async (patch) => { updates.push(patch); });
  assert.equal(result.output, "Done after the pause.");
  assert.ok(updates.some((patch) => patch.activity === "paused by a person"));

  const stopped = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [
      event(1, "turn/stopped", { reason: "aborted", paused: true }),
      event(2, "session/pause-ended", { outcome: "stopped" }),
    ],
  } as unknown as SessionService;
  await assert.rejects(() => createWorkflowRunNode(stopped)(runContext(), async () => {}), { name: "AbortError" });
});

test("workflow timeout cancels the pending server resume before aborting", async () => {
  const actions: string[] = [];
  let reads = 0;
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => reads++ === 0 ? [
      event(1, "turn/stopped", { reason: "error", retry: { resumeAt: Date.now() + 100_000, attempt: 1 } }),
    ] : [],
    cancelResume: async () => { actions.push("cancel resume"); },
    abort: async () => { actions.push("abort"); },
  } as unknown as SessionService;
  await assert.rejects(() => createWorkflowRunNode(sessions)({ ...runContext(), timeoutMs: 10 }, async () => {}), /Timed out/);
  assert.deepEqual(actions, ["cancel resume", "abort"]);
});

test("a verifier handoff contains its final report after lengthy progress", async () => {
  const report = "Tests: 12 passed. Remaining finding: complete the Gallery icon mapping.";
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [
      event(1, "assistant/message", { partId: "progress", text: "Working on verification. ".repeat(4_000) }),
      event(2, "assistant/message", { partId: "final", text: report }),
      event(3, "turn/stopped", { reason: "completed" }),
    ],
  } as unknown as SessionService;
  const result = await createWorkflowRunNode(sessions)(runContext(), async () => {});
  assert.equal(result.output, report);
});

test("a streamed verifier conclusion survives a full progress buffer", async () => {
  const report = "Checks passed; remaining finding: replace the generic Gallery icon.";
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [
      event(1, "assistant/chunk", { partId: "progress", text: "Progress ".repeat(10_000) }),
      event(2, "assistant/chunk", { partId: "final", text: report }),
      event(3, "assistant/message", { partId: "final" }),
      event(4, "turn/stopped", { reason: "completed" }),
    ],
  } as unknown as SessionService;
  const result = await createWorkflowRunNode(sessions)(runContext(), async () => {});
  assert.equal(result.output, report);
});

test("error text and raw retry hints never authorize workflow-owned replay", async () => {
  for (const retry of [undefined, { scope: "overloaded", retryable: true }, { resumeAt: Date.now(), retryable: false }]) {
    let sends = 0;
    const sessions = {
      create: async () => ({ id: "child" }), send: async () => { sends++; return {}; },
      events: async () => [event(1, "turn/stopped", { reason: "error", error: "At capacity", ...(retry ? { retry } : {}) })],
    } as unknown as SessionService;
    await assert.rejects(() => createWorkflowRunNode(sessions)(runContext(), async () => {}), (cause: unknown) =>
      (cause as { workflow: { retryable: boolean } }).workflow.retryable === false);
    assert.equal(sends, 1);
  }
});

test("workflow stop cancels a pending server resume", async () => {
  const actions: string[] = [];
  const controller = new AbortController();
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [event(1, "turn/stopped", { reason: "error", retry: { resumeAt: Date.now() + 100_000 } })],
    cancelResume: async () => { actions.push("cancel resume"); },
    abort: async () => { actions.push("abort"); },
  } as unknown as SessionService;
  await assert.rejects(() => createWorkflowRunNode(sessions)({ ...runContext(), signal: controller.signal }, async (patch) => {
    if (patch.activity === "waiting for provider capacity") controller.abort();
  }), { name: "AbortError" });
  assert.deepEqual(actions, ["cancel resume", "abort"]);
});

test("completion without an assistant result does not count as finished work", async () => {
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [event(1, "turn/stopped", { reason: "completed" })],
  } as unknown as SessionService;
  await assert.rejects(() => createWorkflowRunNode(sessions)(runContext(), async () => {}), /without an assistant result/);
});

test("reasoning-only output cannot substitute for a verifier report", async () => {
  const sessions = {
    create: async () => ({ id: "child" }), send: async () => ({}),
    events: async () => [
      ...Array.from({ length: 150 }, (_, i) => event(i + 1, "assistant/message", { partId: `reasoning-${i}`, text: "", reasoning: "Checking" })),
      event(151, "turn/stopped", { reason: "completed" }),
    ],
  } as unknown as SessionService;
  await assert.rejects(() => createWorkflowRunNode(sessions)(runContext(), async () => {}), /without an assistant result/);
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
    (cause: unknown) => {
      const metadata = (cause as { workflow?: { retryable?: boolean; phase?: string } }).workflow;
      return metadata?.retryable === false && metadata.phase === "runtime" &&
        /Timed out after 5ms\. Open the child session/.test(String((cause as Error).message));
    },
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

test("adjacent assistant output is coalesced while boundaries flush in order", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async () => ({}),
    events: async () => [
      event(1, "assistant/chunk", { partId: "answer", text: "a" }),
      event(2, "assistant/chunk", { partId: "answer", text: "b" }),
      event(3, "tool/call", { callId: "c1", tool: "bash" }),
      event(4, "assistant/chunk", { partId: "answer", text: "c" }),
      event(5, "assistant/message", { partId: "answer" }),
      event(6, "turn/stopped", { reason: "completed" }),
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
    permissions: "manual",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }, async (patch) => { updates.push(patch); });

  const outputs = updates.filter((patch) => typeof patch.output === "string");
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0]?.output, "ab");
  assert.equal(updates[updates.indexOf(outputs[0]!) + 1]?.activity, "tool: bash");
  assert.equal(outputs[1]?.output, "abc");
  assert.equal(result.output, "abc");
});

test("empty reasoning and marker parts never add blank paragraphs to node output", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async () => ({}),
    events: async () => [
      event(1, "assistant/chunk", { partId: "note-1", text: "Reading the diff." }),
      event(2, "assistant/chunk", { partId: "reasoning-1", text: "" }),
      event(3, "assistant/chunk", { partId: "marker", text: "\n" }),
      event(4, "assistant/message", { partId: "reasoning-2", text: "" }),
      event(5, "assistant/chunk", { partId: "note-2", text: "Running the checks." }),
      event(6, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => {},
  } as unknown as SessionService;

  const result = await createWorkflowRunNode(sessions)(runContext(), async (patch) => { updates.push(patch); });

  const outputs = updates.filter((patch) => typeof patch.output === "string").map((patch) => patch.output as string);
  assert.ok(outputs.length > 0);
  assert.deepEqual(outputs.filter((output) => /\n{3,}/.test(output)), [], "progress never carries runs of blank lines");
  assert.equal(outputs.at(-1), "Reading the diff.\n\nRunning the checks.");
  assert.equal(result.output, "Reading the diff.\n\nRunning the checks.");
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

test("entry-node attachments cross the canonical child session boundary", async () => {
  let delivered: Record<string, unknown> | undefined;
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async (_id: string, input: Record<string, unknown>) => {
      delivered = input;
      return {};
    },
    events: async () => [
      event(1, "assistant/message", { partId: "answer", text: "Attachment reviewed." }),
      event(2, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => {},
  } as unknown as SessionService;
  await createWorkflowRunNode(sessions)({
    parentSessionId: "parent",
    runId: "run",
    workflowId: "workflow",
    projectId: "project",
    node: { id: "node", role: "Writer", prompt: "Write" },
    prompt: "Write",
    permissions: "manual",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    context: {
      attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 3, path: "notes.txt" }],
    },
  }, async () => {});
  assert.deepEqual(delivered?.attachments, [
    { id: "a", name: "notes.txt", mime: "text/plain", size: 3, path: "notes.txt" },
  ]);
});

test("uncertain child creation failure is fenced without release proof", async () => {
  const sessions = {
    create: async () => { throw new Error("provider unavailable"); },
    abort: async () => {},
  } as unknown as SessionService;
  await assert.rejects(
    () => createWorkflowRunNode(sessions)({
      parentSessionId: "parent",
      runId: "run",
      workflowId: "workflow",
      projectId: "project",
      node: { id: "node", role: "Writer", prompt: "Write" },
      prompt: "Write",
      permissions: "manual",
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    }, async () => {}),
    (cause: unknown) => {
      const metadata = (cause as { workflow?: { retryable?: boolean; phase?: string }; }).workflow;
      return metadata?.retryable === false && metadata.phase === "pre-admission";
    },
  );
});

test("catalog rejection uses canonical admission evidence and cleans only empty children", async () => {
  for (const sample of [
    { state: "absent", code: "invalid-model", evidence: false, retryable: true, deleted: true },
    { state: "absent", code: "unexpected", evidence: false, retryable: false, deleted: false },
    { state: "unknown", code: "invalid-model", evidence: false, retryable: false, deleted: false },
    { state: "confirmed", code: "invalid-model", evidence: false, retryable: false, deleted: false },
    { state: "rejected", code: "model-unavailable", evidence: true, retryable: true, deleted: false },
  ]) {
    let operationId = "";
    let deleted = false;
    const sessions = {
      create: async () => ({ id: "child" }),
      autoAcceptSet: async () => ({ setting: "off", effective: false }),
      send: async (_id: string, input: { clientOperationId: string }) => {
        operationId = input.clientOperationId;
        throw Object.assign(new Error("catalog refused model"), { code: sample.code });
      },
      clientMutationStatus: async (id: string, token: string) => {
        assert.equal(id, "child");
        assert.equal(token, operationId);
        return { state: sample.state, mutationKind: "turn-submit" };
      },
      events: async () => [event(1, "session/created", {}), ...(sample.evidence ? [event(2, "tool/call", { tool: "read" })] : [])],
      delete: async (id: string, options: { expectedLastEventSeq: number }) => {
        assert.equal(id, "child");
        assert.equal(options.expectedLastEventSeq, 1);
        deleted = true;
      },
    } as unknown as SessionService;
    await assert.rejects(() => createWorkflowRunNode(sessions)({
      parentSessionId: "parent", projectId: "project", workflowId: "workflow", runId: "run", attempt: 2,
      node: { id: "worker", role: "Worker", prompt: "Work" }, prompt: "Work", permissions: "manual",
      timeoutMs: 1000, signal: new AbortController().signal,
    }, async () => {}), (cause: unknown) =>
      (cause as { workflow: { retryable: boolean } }).workflow.retryable === sample.retryable);
    assert.equal(deleted, sample.deleted, `${sample.state}/${sample.code}`);
    assert.equal(operationId, "workflow:run:worker:2");
  }
});

test("workflow output memory stays bounded while the canonical child retains its transcript", async () => {
  const events = Array.from({ length: 200 }, (_, index) => event(index + 1, "assistant/chunk", {
    partId: `part-${index}`, text: `${index}:` + "x".repeat(1_000),
  }));
  const sessions = {
    create: async () => ({ id: "child" }),
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async () => ({}),
    events: async () => [...events, event(201, "turn/stopped", { reason: "completed" })],
  } as unknown as SessionService;
  let largest = 0;
  const result = await createWorkflowRunNode(sessions)({
    parentSessionId: "parent", projectId: "project", workflowId: "workflow", runId: "run",
    node: { id: "worker", role: "Worker", prompt: "Work" }, prompt: "Work", permissions: "manual",
    timeoutMs: 1000, signal: new AbortController().signal,
  }, async (update) => { largest = Math.max(largest, update.output?.length ?? 0); });
  assert.ok(largest <= 64_000, `largest workflow projection was ${largest} characters`);
  assert.ok(result.output.length <= 64_000);
  assert.match(result.output, /Output shortened/);
  assert.equal(events.length, 200, "canonical child events remain intact");
});

test("a workflow child keeps its role as the title instead of the prompt heading", async () => {
  const created: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const sessions = {
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: "child" };
    },
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async (_id: string, input: Record<string, unknown>) => { sent.push(input); return {}; },
    events: async () => [
      event(1, "assistant/message", { partId: "answer", text: "Review finished." }),
      event(2, "turn/stopped", { reason: "completed" }),
    ],
  } as unknown as SessionService;
  for (const role of ["Reviewer", "  Розробник інтерфейсу  ", "Team lead"]) {
    const node = { id: "execution-unit", role, prompt: "Complete the assigned work" };
    const prompt = buildNodePrompt(node, "Check the workflow");
    assert.match(prompt, /^# Role\n\n/);
    await createWorkflowRunNode(sessions)({
      parentSessionId: "parent", projectId: "project", workflowId: "workflow", runId: "run",
      node,
      prompt,
      permissions: "manual",
      timeoutMs: 1000,
      signal: new AbortController().signal,
    }, async () => {});
    assert.equal(created.at(-1)?.title, role.trim());
    assert.equal(created.at(-1)?.purpose, "workflow");
    assert.equal(created.at(-1)?.parentId, "parent");
    assert.equal(sent.at(-1)?.text, prompt, "the full role instructions still reach the agent");
    assert.equal(sent.at(-1)?.autoTitle, false, "prompt-based titles must not replace the role");
  }
});

test("workflow runner lets a pinned harness choose its default when Auto has no model", async () => {
  let created: Record<string, unknown> | undefined;
  const sessions = {
    create: async (input: Record<string, unknown>) => {
      created = input;
      return { id: "child" };
    },
    autoAcceptSet: async () => ({ setting: "off", effective: false }),
    send: async () => ({}),
    events: async () => [
      event(1, "assistant/message", { partId: "answer", text: "Work finished." }),
      event(2, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => {},
  } as unknown as SessionService;

  await createWorkflowRunNode(sessions)({
    parentSessionId: "parent", projectId: "project", workflowId: "workflow", runId: "run",
    node: {
      id: "auto", role: "Worker", prompt: "Work",
      harness: { mode: "pinned", harnessId: "other-harness" },
    },
    prompt: "Work",
    permissions: "manual",
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }, async () => {});

  assert.deepEqual(created, {
    projectId: "project",
    parentId: "parent",
    purpose: "workflow",
    title: "Worker",
    harness: { mode: "pinned", harnessId: "other-harness" },
  });
  assert.equal("model" in (created ?? {}), false,
    "the runner must not forward a model when Auto left it unset");
});

test("a rework continues in the unit's own child session and ignores its earlier turns", async () => {
  const sent: Array<{ sessionId: string; text: string }> = [];
  const reads: number[] = [];
  const sessions = {
    create: async () => { throw new Error("a resumed unit must not create a new child"); },
    snapshot: async (id: string) => ({ id, status: "idle" }),
    autoAcceptSet: async (_id: string, setting: string) => ({ setting, effective: false }),
    send: async (sessionId: string, input: { text: string }) => { sent.push({ sessionId, text: input.text }); return {}; },
    events: async (_id: string, afterSeq: number, page?: { limit?: number }) => {
      if (page?.limit === 1) return [event(7, "turn/stopped", { reason: "completed" })];
      reads.push(afterSeq);
      return afterSeq >= 7 ? [
        event(8, "turn/started", {}),
        event(9, "assistant/message", { partId: "answer", text: "reworked" }),
        event(10, "turn/stopped", { reason: "completed" }),
      ] : [event(7, "turn/stopped", { reason: "completed" })];
    },
    abort: async () => {},
  } as unknown as SessionService;
  const result = await createWorkflowRunNode(sessions)(
    { ...runContext(), prompt: "Rework round 2", round: 2, resumeSessionId: "child" },
    async () => {},
  );
  assert.equal(result.sessionId, "child");
  assert.equal(result.output, "reworked", "the earlier completed turn before the mark never ends the rework");
  assert.deepEqual(sent, [{ sessionId: "child", text: "Rework round 2" }]);
  assert.ok(reads.every((seq) => seq >= 7), `polling starts after the resume mark: ${reads.join(",")}`);
});

test("an unreachable child session falls back to a fresh one for the rework", async () => {
  let created = 0;
  const sessions = {
    create: async () => { created++; return { id: "fresh" }; },
    snapshot: async () => { throw new Error("gone"); },
    autoAcceptSet: async (_id: string, setting: string) => ({ setting, effective: false }),
    send: async () => ({}),
    events: async () => [
      event(1, "assistant/message", { partId: "answer", text: "rebuilt" }),
      event(2, "turn/stopped", { reason: "completed" }),
    ],
    abort: async () => {},
  } as unknown as SessionService;
  const result = await createWorkflowRunNode(sessions)(
    { ...runContext(), round: 2, resumeSessionId: "missing" },
    async () => {},
  );
  assert.equal(created, 1);
  assert.equal(result.sessionId, "fresh");
  assert.equal(result.output, "rebuilt");
});
