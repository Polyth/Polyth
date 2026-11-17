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

const harness = (options: {
  continueLimit?: number; dir?: string; reconcileRetryDelaysMs?: number[];
  toolExecutionTimeoutMs?: number; toolExecutionHardLimitMs?: number; toolRehydrateGraceMs?: number;
  toolQuietNoticeMs?: number;
} = {}) => {
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
  const progressed: string[] = [];
  const quiet: Array<{ sessionId: string; callId: string; tool: string; startedAt: number; quietSince: number; stopsAt: number; at: number }> = [];
  const broadcast: Broadcaster = { event: () => {}, projection: () => {}, toolProgress: (_sessionId, callId) => { progressed.push(callId); } };
  const sessions = createSessionService({ autoContinueIncomplete: false,
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
    toolExecutionTimeoutMs: options.toolExecutionTimeoutMs ?? 30,
    ...(options.toolExecutionHardLimitMs === undefined ? {} : { toolExecutionHardLimitMs: options.toolExecutionHardLimitMs }),
    ...(options.toolRehydrateGraceMs === undefined ? {} : { toolRehydrateGraceMs: options.toolRehydrateGraceMs }),
    ...(options.toolQuietNoticeMs === undefined ? {} : {
      toolQuietNoticeMs: options.toolQuietNoticeMs,
      notify: { attention: () => {}, turnStopped: () => {}, toolQuiet: (event) => { quiet.push({ ...event, at: Date.now() }); } },
    }),
    ...(options.reconcileRetryDelaysMs ? { reconcileRetryDelaysMs: options.reconcileRetryDelaysMs } : {}),
    ...(options.continueLimit === undefined
      ? {}
      : { toolTimeoutContinueLimit: options.continueLimit }),
  });
  return { sessions, store, emit, startedTexts, aborted, observers, endpoint, dir, runtime, progressed, quiet };
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
  assert.match(String(failure?.data.error), /stopped after .* without output/);
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
    /stopped after .* without output/,
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
  assert.match(byCall.stuck ?? "", /stopped after .* without output/);
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

const toolErrors = async (store: ReturnType<typeof createStore>, sessionId: string, callId: string) =>
  (await store.events(sessionId)).filter((event) => event.type === "tool/error" && event.data.callId === callId);

test("a call that keeps showing activity survives past the silence limit, then is stopped once it goes quiet", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 200, toolExecutionHardLimitMs: 60_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Chatty tool" });
  await h.sessions.send(id, { text: "long read loop" });
  const input = { command: "for f in *; do cat $f; done" };
  h.emit(id, { type: "tool/started", callId: "loop", tool: "shell", input });
  // Well past the 200ms silence limit in total, never silent for 200ms.
  for (let step = 0; step < 12; step += 1) {
    await flush(50);
    h.emit(id, { type: "tool/call", callId: "loop", tool: "shell", input, status: "running" });
  }
  assert.deepEqual(h.aborted, [], "activity every 50ms keeps a 200ms-silence call alive for 600ms");
  const quietSince = Date.now();
  await waitFor(() => h.aborted.length === 1);
  assert.ok(Date.now() - quietSince >= 150, "the limit counts from the last activity");
  const [failure] = await toolErrors(h.store, id, "loop");
  assert.match(String(failure?.data.error), /stopped after 200ms without output.*background/s);
});

test("a call with activity is still stopped at the hard ceiling", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 200, toolExecutionHardLimitMs: 500 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Endless chatty tool" });
  await h.sessions.send(id, { text: "never ends" });
  const input = { command: "tail -f log" };
  const startedAt = Date.now();
  h.emit(id, { type: "tool/started", callId: "forever", tool: "shell", input });
  while (h.aborted.length === 0 && Date.now() - startedAt < 3_000) {
    await flush(40);
    h.emit(id, { type: "tool/started", callId: "forever", tool: "shell", input });
  }
  assert.equal(h.aborted.length, 1);
  assert.ok(Date.now() - startedAt >= 450, "not stopped by the silence limit while active");
  await waitFor(async () => (await toolErrors(h.store, id, "forever")).length === 1);
  const [failure] = await toolErrors(h.store, id, "forever");
  assert.match(String(failure?.data.error), /hard execution limit/);
});

test("a harness that emits nothing after the start is stopped at the silence limit from the start", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 120, toolExecutionHardLimitMs: 60_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Silent tool" });
  await h.sessions.send(id, { text: "silent" });
  const startedAt = Date.now();
  h.emit(id, { type: "tool/started", callId: "mute", tool: "shell", input: {} });
  await waitFor(() => h.aborted.length === 1);
  assert.ok(Date.now() - startedAt >= 100);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("tool/progress keeps a call alive past the silence limit, is relayed live, and is never persisted", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 200, toolExecutionHardLimitMs: 60_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Progress" });
  await h.sessions.send(id, { text: "sleep a while" });
  h.emit(id, { type: "tool/started", callId: "slow", tool: "shell", input: { command: "sleep 900" } });
  for (let step = 0; step < 12; step += 1) {
    await flush(50);
    h.emit(id, { type: "tool/progress", callId: "slow", at: Date.now() });
  }
  assert.deepEqual(h.aborted, [], "progress every 50ms keeps a 200ms-silence call alive for 600ms");
  assert.ok(h.progressed.length >= 10 && h.progressed.every((callId) => callId === "slow"));
  assert.equal((await h.store.events(id)).some((event) => event.type === "tool/progress"), false, "never appended to the log");
  await waitFor(() => h.aborted.length === 1);
});

test("tool/progress outside an admitted turn is dropped: no relay, no watchdog activity, no log row", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 200, toolExecutionHardLimitMs: 60_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Unadmitted progress" });
  h.emit(id, { type: "tool/progress", callId: "ghost", at: Date.now() });
  await flush(60);
  assert.deepEqual(h.progressed, []);
  assert.equal((await h.store.events(id)).some((event) => event.type === "tool/progress"), false);
});

const restartedRunning = async (first: ReturnType<typeof harness>, options: Parameters<typeof harness>[0]) => {
  first.sessions.dispose();
  await first.store.close();
  const restored = harness({ ...options, dir: first.dir });
  const snapshot = restored.runtime.reconcile!;
  restored.runtime.reconcile = async (...args) => ({ ...(await snapshot(...args)), state: { value: "running" } });
  return restored;
};

test("a call older than the silence window is not stopped at boot; silence is measured from boot", async (t) => {
  const first = harness({ continueLimit: 0, toolExecutionTimeoutMs: 600_000 });
  const { id } = await first.sessions.create({ projectId: "p1", title: "Old call" });
  await first.sessions.send(id, { text: "inspect" });
  first.emit(id, { type: "tool/started", callId: "old", tool: "shell", input: {} });
  await waitFor(async () => (await first.store.events(id)).some(event => event.type === "tool/started"));
  await flush(400);
  const bootedAt = Date.now();
  const restored = await restartedRunning(first, { continueLimit: 0, toolExecutionTimeoutMs: 300 });
  t.after(() => { restored.sessions.dispose(); return restored.store.close(); });
  await flush(150);
  assert.deepEqual(restored.aborted, [], "a pre-boot call must not be stopped at boot");
  await waitFor(() => restored.aborted.length === 1);
  assert.ok(Date.now() - bootedAt >= 290, "stopped only after the silence window measured from boot");
});

test("a rehydrated call past its hard ceiling fires only after the grace", async (t) => {
  const options = { continueLimit: 0, toolExecutionTimeoutMs: 2_000, toolExecutionHardLimitMs: 100, toolRehydrateGraceMs: 600 };
  const first = harness({ continueLimit: 0, toolExecutionTimeoutMs: 600_000 });
  const { id } = await first.sessions.create({ projectId: "p1", title: "Past ceiling" });
  await first.sessions.send(id, { text: "inspect" });
  first.emit(id, { type: "tool/started", callId: "old", tool: "shell", input: {} });
  await waitFor(async () => (await first.store.events(id)).some(event => event.type === "tool/started"));
  await flush(150);
  const bootedAt = Date.now();
  const restored = await restartedRunning(first, options);
  t.after(() => { restored.sessions.dispose(); return restored.store.close(); });
  await flush(300);
  assert.deepEqual(restored.aborted, [], "the ceiling waits out the grace");
  await waitFor(() => restored.aborted.length === 1);
  assert.ok(Date.now() - bootedAt >= 590);
});

const keepEvents = async (store: ReturnType<typeof createStore>, id: string) =>
  (await store.events(id)).filter((event) => event.type === "tool/keep-running");

test("keep-running turns off the silence stop for that call, records one event, is idempotent", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 120, toolExecutionHardLimitMs: 60_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Slow silent" });
  await h.sessions.send(id, { text: "slow" });
  h.emit(id, { type: "tool/started", callId: "slow", tool: "shell", input: {} });
  await waitFor(async () => (await h.store.events(id)).some((e) => e.type === "tool/started"));
  await h.sessions.keepToolRunning!(id, "slow", { userId: "usr_max" });
  await h.sessions.keepToolRunning!(id, "slow", { userId: "usr_max" });
  const events = await keepEvents(h.store, id);
  assert.equal(events.length, 1, "a second press appends nothing");
  assert.deepEqual(events[0]!.data, { callId: "slow", byUserId: "usr_max" });
  await flush(400);
  assert.deepEqual(h.aborted, [], "3x the silence limit passed without a stop");
  assert.deepEqual((await toolErrors(h.store, id, "slow")), [], "the kept call is not stopped for silence");
});

test("a kept call is still stopped at the hard ceiling", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 100, toolExecutionHardLimitMs: 500 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Kept ceiling" });
  await h.sessions.send(id, { text: "slow" });
  const startedAt = Date.now();
  h.emit(id, { type: "tool/started", callId: "slow", tool: "shell", input: {} });
  await waitFor(async () => (await h.store.events(id)).some((e) => e.type === "tool/started"));
  await h.sessions.keepToolRunning!(id, "slow");
  assert.equal((await keepEvents(h.store, id))[0]!.data.byUserId, undefined);
  await flush(250);
  assert.deepEqual(h.aborted, [], "silence limit passed without a stop");
  await waitFor(() => h.aborted.length === 1);
  assert.ok(Date.now() - startedAt >= 450);
  await waitFor(async () => (await toolErrors(h.store, id, "slow")).length === 1);
  assert.match(String((await toolErrors(h.store, id, "slow"))[0]!.data.error), /hard execution limit/);
});

test("keep-running is refused for an unknown or finished call and an unknown session", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 600_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Refusals" });
  await h.sessions.send(id, { text: "x" });
  h.emit(id, { type: "tool/started", callId: "done", tool: "shell", input: {} });
  h.emit(id, { type: "tool/result", callId: "done", tool: "shell", output: "ok" } as RuntimeEvent);
  await waitFor(async () => (await h.store.events(id)).some((e) => e.type === "tool/result"));
  await assert.rejects(() => h.sessions.keepToolRunning!(id, "done"), { code: "conflict" });
  await assert.rejects(() => h.sessions.keepToolRunning!(id, "never"), { code: "conflict" });
  await assert.rejects(() => h.sessions.keepToolRunning!("sess_missing", "x"), { code: "not-found" });
  assert.equal((await keepEvents(h.store, id)).length, 0);
});

test("a kept call survives a restart: rehydration arms it without the silence stop", async (t) => {
  const first = harness({ continueLimit: 0, toolExecutionTimeoutMs: 600_000 });
  const { id } = await first.sessions.create({ projectId: "p1", title: "Kept restart" });
  await first.sessions.send(id, { text: "inspect" });
  first.emit(id, { type: "tool/started", callId: "slow", tool: "shell", input: {} });
  await waitFor(async () => (await first.store.events(id)).some((e) => e.type === "tool/started"));
  await first.sessions.keepToolRunning!(id, "slow");
  const restored = await restartedRunning(first, { continueLimit: 0, toolExecutionTimeoutMs: 150, toolExecutionHardLimitMs: 60_000 });
  t.after(() => { restored.sessions.dispose(); return restored.store.close(); });
  await flush(500);
  assert.deepEqual(restored.aborted, [], "a kept call is not stopped for silence after boot");
  await restored.sessions.keepToolRunning!(id, "slow");
  assert.equal((await keepEvents(restored.store, id)).length, 1, "still idempotent after restart");
});

test("a quiet call is announced once before its silence stop; activity starts a new quiet stretch", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 300, toolExecutionHardLimitMs: 60_000, toolQuietNoticeMs: 150 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Quiet" });
  await h.sessions.send(id, { text: "build" });
  h.emit(id, { type: "tool/started", callId: "slow", tool: "shell", input: { command: "make all" } });
  await waitFor(() => h.quiet.length === 1);
  const first = h.quiet[0]!;
  assert.equal(first.sessionId, id);
  assert.equal(first.callId, "slow");
  assert.equal(first.tool, "shell");
  assert.equal(first.stopsAt - first.quietSince, 300);
  assert.ok(first.at - first.quietSince >= 140, "announced after the notice delay, not at the start");
  assert.deepEqual(h.aborted, [], "the notice comes before the stop");
  // Activity before the stop: a new quiet stretch, announced again.
  h.emit(id, { type: "tool/progress", callId: "slow", at: Date.now() });
  await waitFor(() => h.quiet.length === 2);
  assert.ok(h.quiet[1]!.quietSince > first.quietSince);
  await waitFor(() => h.aborted.length === 1);
  assert.equal(h.quiet.length, 2, "one notice per quiet stretch");
});

test("a judge keeps a quiet call: no stop, the event says judge, and a kept call is never announced", async (t) => {
  const h = harness({ continueLimit: 0, toolExecutionTimeoutMs: 300, toolExecutionHardLimitMs: 60_000, toolQuietNoticeMs: 150 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Judge keeps" });
  await h.sessions.send(id, { text: "test" });
  h.emit(id, { type: "tool/started", callId: "slow", tool: "shell", input: { command: "npm test" } });
  await waitFor(() => h.quiet.length === 1);
  await h.sessions.keepToolRunning!(id, "slow", { via: "judge", useId: "judges.quiet-command", userId: "system:judge" });
  await flush(450);
  assert.deepEqual(h.aborted, [], "kept by the judge: no silence stop");
  const kept = (await h.store.events(id)).filter((event) => event.type === "tool/keep-running");
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0]!.data, { callId: "slow", via: "judge", useId: "judges.quiet-command" }, "system ids are never recorded as a person");

  // Kept by a person before the notice: never announced.
  h.emit(id, { type: "tool/started", callId: "other", tool: "shell", input: { command: "sleep 900" } });
  await h.sessions.keepToolRunning!(id, "other", { userId: "usr_max" });
  await flush(400);
  assert.equal(h.quiet.filter((event) => event.callId === "other").length, 0);
  const person = (await h.store.events(id)).filter((event) => event.type === "tool/keep-running").at(-1)!;
  assert.deepEqual(person.data, { callId: "other", byUserId: "usr_max" });
});
