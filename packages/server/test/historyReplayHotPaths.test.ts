// Streaming hot paths must not replay a session's whole event log. Long agent
// sessions reach tens of thousands of events (a 32k-event log costs ~0.4 s of
// CPU to read and parse); replaying it on every tool start and on every quiet
// check of a streaming turn kept the server's single thread busy. These tests
// count unbounded store.events() reads while those paths run, and check that
// the watchdog and the quiet-turn reconciliation still behave as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, EventPage, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  attempts = 300,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await flush(10);
  }
  throw new Error("condition was not reached");
};

const harness = (options: { quietTurnCheckMs?: number; toolExecutionTimeoutMs?: number; dir?: string } = {}) => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const startedTexts: string[] = [];
  const aborted: string[] = [];
  let reconciles = 0;
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
    reconcile: async (binding: RuntimeSessionBinding & { reconciliationOrdinal?: number }): Promise<RuntimeSnapshot> => {
      reconciles += 1;
      return {
        authorityId: binding.authorityId,
        generation: binding.generation,
        location: binding.location,
        backendSessionId: binding.backendSessionId!,
        reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
        state: { value: "running" },
        completeness: { events: "partial", permissions: "partial", questions: "partial" },
        permissions: [],
        questions: [],
        events: [],
      };
    },
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
    onObservation() {
      return { dispose: () => {} };
    },
    dispose: async () => {},
  };

  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "polyth-history-replay-"));
  const store = createStore(join(dir, "s.db"));
  // Every read of a whole log from its first event, with no page bound.
  const fullReads: string[] = [];
  const countedStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "events") {
        return (sessionId: string, afterSeq?: number, page?: EventPage) => {
          if (!afterSeq && page === undefined) fullReads.push(sessionId);
          return target.events(sessionId, afterSeq, page);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
    store: countedStore,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
    toolTimeoutContinueLimit: 0,
    ...(options.toolExecutionTimeoutMs === undefined ? {} : { toolExecutionTimeoutMs: options.toolExecutionTimeoutMs }),
    ...(options.quietTurnCheckMs === undefined ? {} : { quietTurnCheckMs: options.quietTurnCheckMs }),
  });
  return {
    sessions, store, emit, aborted, fullReads, dir,
    reconciles: () => reconciles,
  };
};

const toolCount = async (store: ReturnType<typeof createStore>, sessionId: string, type: string) =>
  (await store.events(sessionId)).filter((event) => event.type === type).length;

test("tool starts and approval checks do not replay the session log", async (t) => {
  const h = harness({ toolExecutionTimeoutMs: 60_000 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Long session" });
  await h.sessions.send(id, { text: "work through the backlog" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");

  const before = h.fullReads.length;
  for (let call = 0; call < 25; call += 1) {
    h.emit(id, { type: "tool/started", callId: `call-${call}`, tool: "shell", input: { command: `step ${call}` } });
    h.emit(id, { type: "tool/result", callId: `call-${call}`, tool: "shell", input: {}, output: "ok" });
  }
  h.emit(id, { type: "tool/started", callId: "waiting", tool: "shell", input: {} });
  h.emit(id, { type: "permission/requested", requestId: "waiting", permission: "bash", patterns: ["git status"] });
  await waitFor(async () => (await h.sessions.debug!(id)).pending.permissions.length === 1);
  await waitFor(async () => await toolCount(h.store, id, "tool/result") === 25);

  assert.equal(
    h.fullReads.length - before,
    0,
    "26 tool starts and an approval request must read only the turn's own tool events",
  );
});

test("the watchdog still stops a runaway tool once earlier calls finished", async (t) => {
  const h = harness({ toolExecutionTimeoutMs: 80 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Runaway after work" });
  await h.sessions.send(id, { text: "inspect" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  for (let call = 0; call < 5; call += 1) {
    h.emit(id, { type: "tool/started", callId: `done-${call}`, tool: "shell", input: {} });
    h.emit(id, { type: "tool/result", callId: `done-${call}`, tool: "shell", input: {}, output: "ok" });
  }
  h.emit(id, { type: "tool/started", callId: "runaway", tool: "shell", input: { command: "sleep forever" } });

  await waitFor(() => h.aborted.length === 1);
  const errors = (await h.store.events(id)).filter((event) => event.type === "tool/error");
  assert.deepEqual(errors.map((event) => event.data.callId), ["runaway"], "only the still-running call is stopped");
  assert.match(String(errors[0]?.data.error), /stopped after exceeding/);
});

test("a restart re-arms only the current turn's running tool", async (t) => {
  const first = harness({ toolExecutionTimeoutMs: 60_000 });
  const { id } = await first.sessions.create({ projectId: "p1", title: "Restart mid-tool" });
  await first.sessions.send(id, { text: "first task" });
  await waitFor(async () => (await first.store.projection(id))?.status === "working");
  first.emit(id, { type: "tool/started", callId: "abandoned", tool: "shell", input: {} });
  first.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await waitFor(async () => (await first.store.projection(id))?.status === "idle");
  await first.sessions.send(id, { text: "second task" });
  await waitFor(async () => (await first.store.projection(id))?.status === "working");
  first.emit(id, { type: "tool/started", callId: "finished", tool: "shell", input: {} });
  first.emit(id, { type: "tool/result", callId: "finished", tool: "shell", input: {}, output: "ok" });
  first.emit(id, { type: "tool/started", callId: "running", tool: "shell", input: {} });
  await waitFor(async () => await toolCount(first.store, id, "tool/started") === 3);
  first.sessions.dispose();
  await first.store.close();

  const restored = harness({ toolExecutionTimeoutMs: 80, dir: first.dir });
  t.after(() => { restored.sessions.dispose(); return restored.store.close(); });
  await waitFor(() => restored.aborted.length === 1);
  const errors = (await restored.store.events(id)).filter((event) => event.type === "tool/error");
  assert.deepEqual(errors.map((event) => event.data.callId), ["running"]);
  // A timer re-armed for the earlier turn's call would fire first and report
  // the running tool as "canceled because another tool exceeded" instead.
  assert.match(String(errors[0]?.data.error), /stopped after exceeding/, "only the current turn's tool is re-armed");
});

test("a streaming turn's quiet check reads cached facts and still reconciles once the stream goes silent", async (t) => {
  const h = harness({ quietTurnCheckMs: 40 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Streaming" });
  await h.sessions.send(id, { text: "explain the design" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");

  const before = h.fullReads.length;
  const reconcilesBefore = h.reconciles();
  h.emit(id, { type: "assistant/message", partId: "a1", text: "First part of the answer." });
  // Keep the stream busy for several check intervals: each check must find
  // recent activity and re-arm without reconciling.
  for (let step = 0; step < 12; step += 1) {
    await flush(15);
    h.emit(id, { type: "tool/started", callId: `read-${step}`, tool: "read", input: {} });
    h.emit(id, { type: "tool/result", callId: `read-${step}`, tool: "read", input: {}, output: "text" });
  }
  assert.equal(h.reconciles(), reconcilesBefore, "an active stream is not reconciled");
  assert.equal(h.fullReads.length - before, 0, "quiet checks during the stream must not replay the log");

  await waitFor(() => h.reconciles() > reconcilesBefore);
  assert.equal(h.fullReads.length - before, 0, "the silent-stream check found the open turn without a replay");
});

test("a quiet check for a turn that already stopped does not reconcile", async (t) => {
  const h = harness({ quietTurnCheckMs: 30 });
  t.after(() => { h.sessions.dispose(); return h.store.close(); });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Stopped" });
  await h.sessions.send(id, { text: "short answer" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  const reconcilesBefore = h.reconciles();
  h.emit(id, { type: "assistant/message", partId: "a1", text: "Done." });
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await waitFor(async () => (await h.store.projection(id))?.status === "idle");
  await flush(120);
  assert.equal(h.reconciles(), reconcilesBefore);
});
