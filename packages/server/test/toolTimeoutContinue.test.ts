// Tool-watchdog continuation: a tool that never returns is still hard-stopped
// (the safety limit is not weakened), but the cut turn is not thrown away — the
// agent is nudged forward with a hidden continuation prompt on the same native
// thread. The nudge is bounded, opt-out-able, and never replays the original
// prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeObservation, RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await flush(10);
  }
  throw new Error("condition was not reached");
};

const harness = (options: { continueLimit?: number; dir?: string; reconcileRetryDelaysMs?: number[] } = {}) => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const observers = new Set<(sessionId: string, observation: RuntimeObservation) => void>();
  const startedTexts: string[] = [];
  const aborted: string[] = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const endpoint: RuntimeEndpoint = {
    authorityId: "fake-runtime",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/fake" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (canonical) => `be_${canonical.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      startedTexts.push(request.text);
      emit(request.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    abort: async (sessionId) => {
      aborted.push(sessionId);
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    endpoint: async () => endpoint,
    reconcile: async (binding: RuntimeSessionBinding & { reconciliationOrdinal?: number }): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "idle", watermark: "1", comparison: { domain: "test", order: 1 } },
      completeness: { events: "partial", permissions: "partial", questions: "partial" },
      permissions: [],
      questions: [],
      events: [],
    }),
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    onObservation(callback) {
      observers.add(callback);
      return { dispose: () => observers.delete(callback) };
    },
    dispose: async () => {},
  };

  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "polyth-tool-timeout-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", spaceId: "space-a", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "ask", addRule: () => {}, rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
    toolExecutionTimeoutMs: 30,
    ...(options.reconcileRetryDelaysMs ? { reconcileRetryDelaysMs: options.reconcileRetryDelaysMs } : {}),
    ...(options.continueLimit === undefined
      ? {}
      : { toolTimeoutContinueLimit: options.continueLimit }),
  });
  return { sessions, store, emit, startedTexts, aborted, observers, endpoint, dir, runtime };
};

const NUDGE_EVENT = "user/message";
const nudges = async (store: ReturnType<typeof createStore>, sessionId: string) =>
  (await store.events(sessionId)).filter((event) => {
    if (event.type !== NUDGE_EVENT) return false;
    const data = event.data as { autoResume?: unknown; hiddenUserMessage?: unknown };
    return data.autoResume === true && data.hiddenUserMessage === true;
  });

test("a package tool can wait for human approval beyond the execution limit and is bounded after approval", async (t) => {
  const h = harness({ continueLimit: 0 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Peer approval" });
  await h.sessions.send(id, { text: "read the peer findings" });
  h.emit(id, { type: "tool/started", callId: "peer", tool: "polyth_peer", input: {} });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const decision = h.sessions.requestAgentToolPermission({
    spaceId: "space-a", projectId: "p1", sessionId: id, cwd: h.dir,
    toolId: "harness-runtime.peer-observations", toolName: "polyth_peer", owner: "harness-runtime",
    signal: controller.signal,
  });
  await waitFor(async () => (await h.store.events(id)).some(event => event.type === "permission/requested"));
  await flush(100);
  assert.deepEqual(h.aborted, [], "waiting for a person is not a stuck tool");
  assert.equal((await h.store.projection(id))?.status, "waiting");
  const request = (await h.store.events(id)).find(event => event.type === "permission/requested")!;
  await h.sessions.replyPermission(id, String(request.data.requestId), "once");
  assert.equal(await decision, "allow");
  assert.deepEqual(h.aborted, [], "approval gives the execution a fresh safety window");
  await waitFor(() => h.aborted.length === 1);
  assert.equal((await h.store.events(id)).some(event => event.type === "tool/error" && event.data.callId === "peer"), true);
});

test("native permission waits pause only their matching calls until answered", async (t) => {
  const h = harness({ continueLimit: 0 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Native approval" });
  await h.sessions.send(id, { text: "inspect" });
  for (const [callId, requestId] of [["first", "first"], ["last", "last-approval"]] as const) {
    h.emit(id, { type: "tool/started", callId, tool: "shell", input: {} });
    h.emit(id, { type: "permission/requested", requestId, permission: "bash", patterns: ["git status"], tool: callId });
  }
  await waitFor(async () => (await h.sessions.debug(id)).pending.permissions.length === 2);
  await flush(80);
  assert.deepEqual(h.aborted, []);
  await h.sessions.replyPermission(id, "first", "once");
  h.emit(id, { type: "tool/result", callId: "first", tool: "shell", input: {}, output: "done" });
  await flush(80);
  assert.deepEqual(h.aborted, [], "another pending approval keeps the execution timer paused");
  await h.sessions.replyPermission(id, "last-approval", "once");
  await waitFor(() => h.aborted.length === 1);
});

test("a completed tool is not rearmed by a later permission response", async (t) => {
  const h = harness({ continueLimit: 0 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Completed while waiting" });
  await h.sessions.send(id, { text: "inspect" });
  h.emit(id, { type: "tool/started", callId: "tool", tool: "shell", input: {} });
  h.emit(id, { type: "permission/requested", requestId: "tool", permission: "bash", patterns: ["git status"] });
  await waitFor(async () => (await h.store.projection(id))?.status === "waiting");
  h.emit(id, { type: "tool/result", callId: "tool", tool: "shell", input: {}, output: "done" });
  await waitFor(async () => (await h.store.events(id)).some(event => event.type === "tool/result"));
  await h.sessions.replyPermission(id, "tool", "once");
  await flush(80);
  assert.deepEqual(h.aborted, []);
});

test("a mirrored child permission does not pause a stuck parent tool", async (t) => {
  const h = harness({ continueLimit: 0 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Parent" });
  const child = await h.sessions.create({ projectId: "p1", title: "Child", parentId: id });
  await h.sessions.send(id, { text: "inspect" });
  await h.store.append(id, "permission/requested", {
    requestId: "child-approval", permission: "bash", patterns: ["git status"], sourceSessionId: child.id,
  });
  h.emit(id, { type: "tool/started", callId: "stuck-parent", tool: "shell", input: {} });
  await waitFor(() => h.aborted.length === 1);
});

test("watchdog rehydration restores the human wait and resumes the limit after approval", async (t) => {
  const first = harness({ continueLimit: 0 });
  const { id } = await first.sessions.create({ projectId: "p1", title: "Restart during approval" });
  await first.sessions.send(id, { text: "inspect" });
  first.emit(id, { type: "tool/started", callId: "tool", tool: "shell", input: {} });
  first.emit(id, { type: "permission/requested", requestId: "tool", permission: "bash", patterns: ["git status"] });
  await waitFor(async () => (await first.store.projection(id))?.status === "waiting");
  first.sessions.dispose();
  await first.store.close();

  const restored = harness({ continueLimit: 0, dir: first.dir });
  t.after(() => { restored.sessions.dispose(); return restored.store.close(); });
  const snapshot = restored.runtime.reconcile!;
  restored.runtime.reconcile = async (...args) => ({ ...(await snapshot(...args)), state: { value: "running" } });
  await flush(100);
  assert.deepEqual(restored.aborted, [], "an overdue timer must not cancel the durable approval on startup");
  await restored.sessions.replyPermission(id, "tool", "once");
  await waitFor(() => restored.aborted.length === 1);
});

test("a pending package approval does not shield an unrelated runaway tool", async (t) => {
  const h = harness({ continueLimit: 0 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Parallel tools" });
  await h.sessions.send(id, { text: "inspect and read the findings" });
  h.emit(id, { type: "tool/started", callId: "peer", tool: "polyth_peer", input: {} });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const decision = h.sessions.requestAgentToolPermission({
    spaceId: "space-a", projectId: "p1", sessionId: id, cwd: h.dir,
    toolId: "harness-runtime.peer-observations", toolName: "polyth_peer", owner: "harness-runtime",
    signal: controller.signal,
  });
  await waitFor(async () => (await h.store.projection(id))?.status === "waiting");
  h.emit(id, { type: "tool/started", callId: "runaway", tool: "shell", input: {} });
  await waitFor(() => h.aborted.length === 1);
  const failure = (await h.store.events(id)).find(event => event.type === "tool/error" && event.data.callId === "runaway");
  assert.match(String(failure?.data.error), /stopped after exceeding/);
  controller.abort();
  assert.equal(await decision, "deny");
});

test("disposing the service cancels its active watchdogs", async (t) => {
  const h = harness({ continueLimit: 0 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Dispose" });
  await h.sessions.send(id, { text: "inspect" });
  h.emit(id, { type: "tool/started", callId: "tool", tool: "shell", input: {} });
  await waitFor(async () => (await h.store.events(id)).some(event => event.type === "tool/started"));
  h.sessions.dispose();
  await flush(80);
  assert.deepEqual(h.aborted, []);
});

test("a stuck tool is stopped and the cut turn is continued with a hidden nudge", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Stuck tool" });
  await h.sessions.send(id, { text: "research the timeline" });

  h.emit(id, {
    type: "tool/started",
    callId: "call-stuck",
    tool: "shell",
    input: { command: "rg -n 'scrollTop' apps/web/src | head -n 700" },
  });

  await waitFor(async () => (await nudges(h.store, id)).length === 1);
  const events = await h.store.events(id);
  const toolError = events.find((event) => event.type === "tool/error");
  assert.ok(toolError, "the runaway tool is still recorded as a model-visible failure");
  assert.match(
    String((toolError!.data as { error?: unknown }).error),
    /stopped after exceeding the .* execution safety limit/,
  );
  assert.deepEqual(h.aborted, [id], "the runaway execution is hard-stopped, not merely nudged");

  const nudge = (await nudges(h.store, id))[0]!;
  const text = String((nudge.data as { text?: unknown }).text);
  assert.match(text, /Tool watchdog/);
  assert.match(text, /shell/, "the nudge names the tool that was stopped");
  assert.match(text, /scrollTop/, "the nudge quotes the stopped call so it is not repeated");
  assert.doesNotMatch(text, /research the timeline/, "the nudge is not a replay of the original prompt");

  const abortIntent = events.find((event) => event.type === "turn/abort-requested");
  assert.equal((abortIntent?.data as { reason?: unknown } | undefined)?.reason, "tool-timeout");
  assert.equal((abortIntent?.data as { source?: unknown } | undefined)?.source, "tool-watchdog");

  await waitFor(() => h.startedTexts.length === 2);
  assert.deepEqual(h.startedTexts, ["research the timeline", text]);
  assert.equal((await h.store.projection(id))?.status, "working");
  await h.store.close();
});

test("the watchdog identifies the timed-out call among concurrent tools", async () => {
  const h = harness({ continueLimit: 0 });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Concurrent tools" });
  await h.sessions.send(id, { text: "inspect the worktree" });
  h.emit(id, { type: "tool/started", callId: "stuck", tool: "shell", input: { command: "sleep forever" } });
  h.emit(id, { type: "tool/started", callId: "neighbor", tool: "shell", input: { command: "rg -n todo ." } });

  await waitFor(async () => (await h.store.events(id)).filter((event) => event.type === "tool/error").length === 2);
  const errors = (await h.store.events(id)).filter((event) => event.type === "tool/error");
  const byCall = Object.fromEntries(errors.map((event) => {
    const data = event.data as { callId?: string; error?: string };
    return [data.callId, data.error];
  }));
  assert.match(byCall.stuck ?? "", /stopped after exceeding/);
  assert.equal(byCall.neighbor, "Canceled because another tool exceeded its execution safety limit.");
  assert.equal((await h.store.projection(id))?.status, "idle");
  await h.store.close();
});

test("the watchdog nudge is bounded: a second stuck tool does not loop", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Stuck twice" });
  await h.sessions.send(id, { text: "research the timeline" });
  h.emit(id, { type: "tool/started", callId: "call-1", tool: "shell", input: { command: "sleep forever" } });
  await waitFor(async () => (await nudges(h.store, id)).length === 1);

  h.emit(id, { type: "tool/started", callId: "call-2", tool: "shell", input: { command: "sleep forever" } });
  await waitFor(async () => (await h.store.events(id))
    .filter((event) => event.type === "tool/error")
    .filter((event) => String((event.data as { callId?: unknown }).callId) === "call-2").length === 1);
  await flush(80);

  assert.equal((await nudges(h.store, id)).length, 1, "one nudge per stuck episode, never a loop");
  assert.equal(h.aborted.length, 2, "the second runaway execution is still stopped");
  assert.equal((await h.store.projection(id))?.status, "idle");
  await h.store.close();
});

test("a completed turn restores the nudge budget", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Recovers" });
  await h.sessions.send(id, { text: "first" });
  h.emit(id, { type: "tool/started", callId: "call-1", tool: "shell", input: { command: "sleep forever" } });
  await waitFor(async () => (await nudges(h.store, id)).length === 1);

  // The nudged turn finishes normally, so the agent is demonstrably moving.
  h.emit(id, { type: "turn/stopped", turnId: "t2", reason: "completed" });
  await waitFor(async () => (await h.store.projection(id))?.status === "idle");

  await h.sessions.send(id, { text: "second" });
  h.emit(id, { type: "tool/started", callId: "call-3", tool: "shell", input: { command: "sleep forever" } });
  await waitFor(async () => (await nudges(h.store, id)).length === 2);
  await h.store.close();
});

test("toolTimeoutContinueLimit 0 keeps the pure abort and never nudges", async () => {
  const h = harness({ continueLimit: 0 });
  const { id } = await h.sessions.create({ projectId: "p1", title: "No nudge" });
  await h.sessions.send(id, { text: "research the timeline" });
  h.emit(id, { type: "tool/started", callId: "call-stuck", tool: "shell", input: { command: "sleep forever" } });

  await waitFor(async () => (await h.store.events(id)).some((event) => event.type === "tool/error"));
  await flush(120);
  assert.deepEqual(h.aborted, [id]);
  assert.equal((await nudges(h.store, id)).length, 0);
  assert.equal((await h.store.projection(id))?.status, "idle");
  await h.store.close();
});

// Incident 2026-10-18: Pi answered the watchdog's abort just past the abort
// deadline and its status probe timed out while the killed tool was dying. The
// session was left idle behind an `unknown` reconciliation, the nudge was
// dropped, and nothing ever probed again — the agent simply stopped.
const unprovenAbortHarness = (retryDelays: number[]) => {
  const h = harness({ reconcileRetryDelaysMs: retryDelays });
  let statusAvailable = true;
  const snapshot = h.runtime.reconcile!;
  h.runtime.reconcile = async (...args) => {
    const result = await snapshot(...args);
    return statusAvailable ? result : { ...result, state: { value: "unknown" } };
  };
  h.runtime.abortOperation = async (sessionId, operationId) => {
    h.aborted.push(sessionId);
    statusAvailable = false;
    return { kind: "unknown", operationId, message: "abort was not acknowledged in time" };
  };
  return { ...h, setStatusAvailable: (value: boolean) => { statusAvailable = value; } };
};

const settledUnknown = async (store: ReturnType<typeof createStore>, sessionId: string) =>
  (await store.events(sessionId)).some((event) => event.type === "reconciliation/blocked"
    && (event.data as { state?: unknown }).state === "unknown");

test("an unproven watchdog abort re-probes the runtime and runs the nudge once it is proven idle", async (t) => {
  const h = unprovenAbortHarness([40, 40, 40]);
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Release captain" });
  await h.sessions.send(id, { text: "run the release gate" });
  h.emit(id, { type: "tool/started", callId: "gate", tool: "bash", input: { command: "node scripts/ci/release-quality.mjs" } });

  await waitFor(() => settledUnknown(h.store, id));
  assert.deepEqual(h.aborted, [id]);
  assert.equal((await nudges(h.store, id)).length, 0, "no more work while the abort is unproven");

  h.setStatusAvailable(true);
  await waitFor(async () => (await nudges(h.store, id)).length === 1);
  const text = String((await nudges(h.store, id))[0]!.data.text);
  assert.match(text, /Tool watchdog/);
  assert.match(text, /release-quality/);
  await waitFor(() => h.startedTexts.length === 2);
  assert.deepEqual(h.startedTexts, ["run the release gate", text]);
});

test("a deferred watchdog nudge is dropped once the user has started another turn", async (t) => {
  const h = unprovenAbortHarness([60, 60, 60]);
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "User moved on" });
  await h.sessions.send(id, { text: "first" });
  h.emit(id, { type: "tool/started", callId: "stuck", tool: "bash", input: { command: "sleep forever" } });
  await waitFor(() => settledUnknown(h.store, id));

  await h.sessions.send(id, { text: "do something else" });
  await waitFor(() => h.startedTexts.length === 2);
  h.emit(id, { type: "turn/stopped", turnId: "t2", reason: "completed" });
  h.setStatusAvailable(true);
  await waitFor(async () => {
    const events = await h.store.events(id);
    const stoppedSeq = events.findLast((event) => event.type === "turn/stopped")?.seq ?? 0;
    return events.some((event) => event.type === "reconciliation/completed"
      && (event.data as { state?: unknown }).state === "ready" && event.seq > stoppedSeq);
  });
  await flush(150);
  assert.equal((await nudges(h.store, id)).length, 0);
  assert.deepEqual(h.startedTexts, ["first", "do something else"]);
});

test("the status re-probe is bounded when the runtime never answers", async (t) => {
  const h = unprovenAbortHarness([20, 20]);
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Silent runtime" });
  await h.sessions.send(id, { text: "work" });
  h.emit(id, { type: "tool/started", callId: "stuck", tool: "bash", input: { command: "sleep forever" } });
  await waitFor(() => settledUnknown(h.store, id));
  await flush(250);
  const blocked = (await h.store.events(id)).filter((event) => event.type === "reconciliation/blocked").length;
  assert.equal(blocked, 3, "the first settle plus exactly two re-probes");
  assert.equal((await nudges(h.store, id)).length, 0);
});
