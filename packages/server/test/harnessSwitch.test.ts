import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, CanonicalTurnRequest, HarnessContext, HarnessProvider, ProjectService, RuntimeEvent, RuntimeSnapshot } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createHarnessPool, createHarnessRegistry } from "@polyth/harness-runtime";
import { createSessionService } from "../src/sessions.ts";

const until = async (condition: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) { if (await condition()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail("condition not reached");
};

function fixture(path = ":memory:") {
  let store = createStore(path);
  const detach: Array<() => void> = [];
  const registry = createHarnessRegistry();
  const engines: Array<AgentRuntime & { complete(): void; requests: CanonicalTurnRequest[]; harnessId: string }> = [];
  const executing = new Set<string>();
  let releaseUnknown = false;
  let createUnknown = false;
  let exposeReceipt = true;
  const nativeCreates: string[] = [];
  const provider = (id: string): HarnessProvider => ({
    descriptor: { id, name: id, integration: "fake", priority: id === "fake-a" ? 0 : 1 },
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    async createRuntime(context: HarnessContext) {
      const authorityId = randomUUID();
      const endpoint = { authorityId, generation: 1, continuity: "verified" as const, url: "http://fake", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
      const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
      detach.push(() => listeners.clear());
      const emit = (event: RuntimeEvent) => { for (const cb of listeners) cb(context.sessionId!, event); };
      let nativeId = "";
      let order = 0;
      let lastCreateId = "";
      const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
      const create = async (request: { sessionId: string }, operationId: string) => {
        assert.equal(executing.size, 0, "no target native session while previous engine can execute");
        nativeId = randomUUID(); lastCreateId = operationId; nativeCreates.push(nativeId);
        accepted.push({ operationId, mutationKind: "session-reset", backendSessionId: nativeId, receipt: nativeId });
        if (createUnknown) return { kind: "unknown" as const, operationId, message: "response lost" };
        return { kind: "confirmed" as const, value: { backendSessionId: nativeId }, receipt: nativeId };
      };
      const runtime: AgentRuntime & { complete(): void; requests: CanonicalTurnRequest[]; harnessId: string } = {
        harnessId: id,
        requests: [],
        capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false, resume: true }),
        models: async () => [], agents: async () => [],
        ensureSession: async (input) => nativeId = input.backendSessionId ?? nativeId,
        createSessionOperation: create, resetSessionOperation: create,
        sessions: async () => nativeId ? [{ id: nativeId, title: "fake", createdAt: 0, updatedAt: 0, ...(exposeReceipt ? { operationId: lastCreateId } : {}) }] : [],
        history: async () => [], endpoint: async () => endpoint, protocol: async () => "legacy",
        reconcile: async (binding) => ({
          ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
          state: { value: executing.has(authorityId) ? "running" : "idle", comparison: { domain: authorityId, order: ++order }, causalOperationId: lastCreateId },
          completeness: { events: "complete", permissions: "complete", questions: "complete" }, permissions: [], questions: [], events: [], acceptedOperations: accepted,
        }),
        async startTurnOperation(request, operationId) {
          runtime.requests.push(request); executing.add(authorityId); order++;
          accepted.push({ operationId, mutationKind: "turn-submit", receipt: operationId });
          emit({ type: "turn/started", turnId: operationId });
          return { kind: "confirmed", value: {}, receipt: operationId };
        },
        startTurn: async () => {},
        complete() { emit({ type: "assistant/message", partId: randomUUID(), text: `confirmed answer from ${id}` }); executing.delete(authorityId); order++; emit({ type: "turn/stopped", reason: "completed" }); },
        abort: async () => {},
        abortOperation: async () => ({ kind: "confirmed", value: {} }), // acknowledgement alone does NOT stop this fake
        releaseExecution: async (binding, operationId) => {
          if (releaseUnknown) return { kind: "unknown", operationId, message: "old worker may still run" };
          executing.delete(authorityId); return { kind: "confirmed", value: { authorityId: binding.authorityId, generation: binding.generation } };
        },
        replyPermission: async () => {}, replyQuestion: async () => {},
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        dispose: async () => {},
      };
      engines.push(runtime); return runtime;
    },
  });
  registry.register(provider("fake-a")); registry.register(provider("fake-b"));
  const pool = createHarnessPool({ registry, legacyHarnessId: "fake-a", context: async (projectId, cwd, sessionId) => ({ projectId, cwd: cwd ?? "/same/worktree", sessionId, spaceId: "space-a" }) });
  const projects = { get: async () => ({ id: "p", name: "p", path: "/same/worktree", spaceId: "space-a", createdAt: 0 }), list: async () => [] } as unknown as ProjectService;
  const makeSessions = () => createSessionService({ store, projects, runtimes: pool, permissions: { evaluate: () => "ask" } as unknown as PermissionService, broadcast: { event() {}, projection() {} }, queue: store });
  let sessions = makeSessions();
  const drain = () => new Promise((resolve) => setTimeout(resolve, 40));
  return { get store() { return store; }, get sessions() { return sessions; }, engines, nativeCreates,
    async idle(id: string) { await until(async () => { const events = await store.events(id); return (await store.projection(id))?.status === "idle" && (events.findLast(e => e.type === "turn/stopped")?.seq ?? 0) > (events.findLast(e => e.type === "user/message")?.seq ?? 0); }); },
    async close() { await drain(); detach.forEach((off) => off()); await store.close(); },
    async restart() { await drain(); detach.forEach((off) => off()); await store.close(); store = createStore(path); sessions = makeSessions(); }, setReleaseUnknown(value: boolean) { releaseUnknown = value; }, setCreateUnknown(value: boolean, receipt = true) { createUnknown = value; exposeReceipt = receipt; } };
}

test("A1 A2 → B1 → A retains one canonical session, cwd and confirmed context; stale A gets a new native leg", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  for (const text of ["A1", "A2"]) {
    await f.sessions.send(id, { text }); f.engines.at(-1)!.complete();
    await f.idle(id);
  }
  const original = (await f.store.projection(id))!;
  const b = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(b.id, id); assert.equal(b.resolvedHarnessId, "fake-b");
  await f.sessions.send(id, { text: "B1" });
  assert.match(f.engines.at(-1)!.requests[0]!.text, /A1/);
  assert.match(f.engines.at(-1)!.requests[0]!.text, /confirmed answer from fake-a/);
  assert.equal((await f.store.events(id)).filter((e) => e.type === "user/message").length, 3);
  assert.equal((await f.store.events(id)).filter((e) => e.type === "user/message").at(-1)!.data.text, "B1");
  f.engines.at(-1)!.complete(); await f.idle(id);
  const a = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-a" });
  assert.notEqual(a.backendSessionId, original.backendSessionId);
  assert.equal(a.runtimeBinding!.location.directory, original.runtimeBinding!.location.directory);
  assert.equal((await f.store.projections()).length, 1);
  await f.close();
});

test("active switch waits for completion; queued admission uses the new harness", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "working" });
  const pending = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(pending.harnessTransition?.phase, "requested"); assert.equal(f.engines.length, 1);
  await f.sessions.send(id, { text: "next" });
  f.engines[0]!.complete();
  await until(async () => f.engines.at(-1)?.requests.some((r) => r.text.endsWith("next")) ?? false);
  assert.equal(f.engines.at(-1)!.harnessId, "fake-b");
  f.engines.at(-1)!.complete(); await f.idle(id);
  await f.close();
});

test("stop-now cannot start B on an abort acknowledgement or unknown release", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "mutating" }); f.setReleaseUnknown(true);
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now"), { code: "outcome-unknown" });
  assert.equal(f.engines.length, 1);
  f.setReleaseUnknown(false);
  const result = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now");
  assert.equal(result.resolvedHarnessId, "fake-b"); await f.close();
});

test("lost target create response is never replayed; exact receipt resumes transition", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  f.setCreateUnknown(true, false);
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), { code: "outcome-unknown" });
  const count = f.nativeCreates.length;
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), { code: "outcome-unknown" });
  assert.equal(f.nativeCreates.length, count);
  f.setCreateUnknown(false, true);
  assert.equal((await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" })).resolvedHarnessId, "fake-b");
  assert.equal(f.nativeCreates.length, count); await f.close();
});


test("synchronized native history resumes after disk/server restart without a second native create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-restart-")); const f = fixture(join(dir, "events.db"));
  const { id } = await f.sessions.create({ projectId: "p", title: "Canonical title" });
  await f.sessions.send(id, { text: "A1" }); f.engines[0]!.complete();
  await f.idle(id);
  const original = (await f.store.projection(id))!;
  await f.restart();
  await f.sessions.send(id, { text: "A2" });
  const resumed = (await f.store.projection(id))!;
  assert.equal(resumed.backendSessionId, original.backendSessionId); assert.equal(resumed.runtimeLeg?.id, original.runtimeLeg?.id);
  assert.equal(f.nativeCreates.length, 1); assert.equal(f.engines[0]!.requests.length, 2);
  f.engines[0]!.complete(); await f.idle(id);
  await f.close(); await rm(dir, { recursive: true, force: true });
});

test("canonical dialogue added outside the active native leg forces a fresh leg on the same harness", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "A1" }); f.engines[0]!.complete();
  await f.idle(id);
  const original = (await f.store.projection(id))!;
  await f.store.append(id, "assistant/message", { partId: "canonical-only", text: "Additional confirmed canonical outcome" });
  await f.sessions.send(id, { text: "Continue" });
  assert.notEqual((await f.store.projection(id))!.backendSessionId, original.backendSessionId);
  assert.match(f.engines.at(-1)!.requests[0]!.text, /Additional confirmed canonical outcome/);
  f.engines.at(-1)!.complete(); await f.idle(id); await f.close();
});

test("crash after target creation before atomic route publication resumes its exact receipt once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-transition-")); const f = fixture(join(dir, "events.db"));
  const { id } = await f.sessions.create({ projectId: "p", title: "Retained title" });
  const originalTransition = f.store.transitionRuntimeEpoch;
  f.store.transitionRuntimeEpoch = async () => { throw new Error("simulated crash before publication"); };
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), /simulated crash/);
  assert.equal((await f.store.projection(id))!.harnessTransition?.phase, "released");
  assert.equal(f.nativeCreates.length, 2); f.store.transitionRuntimeEpoch = originalTransition;
  await f.restart();
  const result = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(f.nativeCreates.length, 2); assert.equal(result.title, "Retained title"); assert.equal(result.resolvedHarnessId, "fake-b");
  await f.sessions.send(id, { text: "One prompt" });
  assert.equal((await f.store.events(id)).filter((e) => e.type === "user/message").length, 1);
  f.engines.at(-1)!.complete(); await f.idle(id); await f.close(); await rm(dir, { recursive: true, force: true });
});

test("a deferred switch can be escalated to stop-now; continuity redacts environment secrets and reasoning", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  process.env.POLYTH_TEST_SECRET = "private-test-value";
  try {
    await f.sessions.send(id, { text: "Task private-test-value" }); f.engines[0]!.complete();
    await f.idle(id);
    await f.store.append(id, "assistant/reasoning", { text: "private scratch reasoning" }, { ignorable: true });
    await f.sessions.send(id, { text: "Working" });
    await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
    await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now");
    await f.sessions.send(id, { text: "Inspect current workspace" });
    const text = f.engines.at(-1)!.requests.at(-1)!.text;
    assert.doesNotMatch(text, /private-test-value|private scratch reasoning/); assert.match(text, /workspace is authoritative/i);
    f.engines.at(-1)!.complete(); await f.idle(id);
  } finally { delete process.env.POLYTH_TEST_SECRET; await f.close(); }
});

test("Snapshot continues through a fresh harness after its external source disappears", async () => {
  const { importSnapshot } = await import("../../session-import/src/index.ts");
  const f = fixture();
  const projection = await importSnapshot({
    store: f.store,
    project: { id: "p", name: "p", path: "/same/worktree", spaceId: "space-a", createdAt: 0 },
    context: { spaceId: "space-a", projectId: "p", cwd: "/same/worktree" },
    providerId: "external", ref: "deleted-source", requestId: "snapshot-continuation-test", title: "Imported task",
    source: { list: async () => [], async *read() { yield { role: "user", text: "Remember the imported design decision" }; yield { role: "assistant", text: "The confirmed decision is SQLite" }; } },
  });
  assert.equal(f.engines.length, 0);
  await f.sessions.send(projection.id, { text: "Continue the task" });
  assert.match(f.engines[0]!.requests[0]!.text, /confirmed decision is SQLite/);
  assert.equal((await f.engines[0]!.endpoint!()).location.directory, "/same/worktree");
  assert.deepEqual((await f.store.events(projection.id)).filter(e => e.type === "user/message").map(e => e.data.text), ["Remember the imported design decision", "Continue the task"]);
  f.engines[0]!.complete(); await f.idle(projection.id);
  assert.equal((await f.store.projections()).length, 1);
  await f.close();
});

test("a deleted native conversation cannot erase canonical history or prevent a positively released switch", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "Durable task intent" }); f.engines[0]!.complete(); await f.idle(id);
  f.engines[0]!.ensureSession = async () => { throw Object.assign(new Error("native session deleted"), { code: "unknown-session" }); };
  f.engines[0]!.history = async () => [];
  f.engines[0]!.sessions = async () => [];
  const switched = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now");
  assert.equal(switched.id, id);
  await f.sessions.send(id, { text: "Continue from the workspace" });
  assert.match(f.engines.at(-1)!.requests[0]!.text, /Durable task intent/);
  assert.match(f.engines.at(-1)!.requests[0]!.text, /confirmed answer from fake-a/);
  f.engines.at(-1)!.complete(); await f.idle(id); await f.close();
});
