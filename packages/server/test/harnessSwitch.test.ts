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
import { createSharedRuntimeOccupancy } from "../src/runtimeOccupancy.ts";

const until = async (condition: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) { if (await condition()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail("condition not reached");
};

function fixture(path = ":memory:") {
  let store = createStore(path);
  const detach: Array<() => void> = [];
  let shuttingDown = false;
  const beginShutdown = () => { shuttingDown = true; };
  const registry = createHarnessRegistry();
  const engines: Array<AgentRuntime & { complete(): void; requests: CanonicalTurnRequest[]; harnessId: string }> = [];
  const executing = new Set<string>();
  let releaseUnknown = false;
  let createUnknown = false;
  let exposeReceipt = true;
  let abortStops = false;
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
        capabilities: async () => ({
          streaming: true,
          permissions: false,
          questions: false,
          compaction: false,
          subagents: false,
          resume: true,
          commands: { discovery: "native", invoke: "raw-native-input" },
        }),
        commands: async () => [{
          id: `native:${id}:status`,
          name: "status",
          owner: "native",
          harnessId: id,
          invocation: "raw-native-input",
        }],
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
        abortOperation: async () => {
          // Acknowledgement alone does not stop this fake. A provider that
          // actually interrupted can opt in so stop-now can prove idle.
          if (abortStops) executing.delete(authorityId);
          return { kind: "confirmed", value: {} };
        },
        releaseExecution: async (binding, operationId) => {
          if (releaseUnknown) return { kind: "unknown", operationId, message: "old worker may still run" };
          if (!binding.backendSessionId) {
            return { kind: "unknown", operationId, message: "release requires a backend session identity" };
          }
          if (executing.has(authorityId)) {
            return { kind: "unknown", operationId, message: "Old execution has not been proven idle" };
          }
          return {
            kind: "confirmed",
            value: {
              authorityId: binding.authorityId,
              generation: binding.generation,
              backendSessionId: binding.backendSessionId,
            },
          };
        },
        replyPermission: async () => {}, replyQuestion: async () => {},
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        dispose: async () => {},
      };
      engines.push(runtime); return runtime;
    },
  });
  registry.register(provider("fake-a")); registry.register(provider("fake-b")); registry.register(provider("fake-c"));
  const pool = createHarnessPool({ registry, legacyHarnessId: "fake-a", context: async (projectId, cwd, sessionId) => ({ projectId, cwd: cwd ?? "/same/worktree", sessionId, spaceId: "space-a" }) });
  const projects = { get: async () => ({ id: "p", name: "p", path: "/same/worktree", spaceId: "space-a", createdAt: 0 }), list: async () => [] } as unknown as ProjectService;
  const makeSessions = () => createSessionService({ store, projects, runtimes: pool, permissions: { evaluate: () => "ask" } as unknown as PermissionService, broadcast: { event() {}, projection() {} }, queue: store, isShuttingDown: () => shuttingDown });
  let sessions = makeSessions();
  const drain = () => new Promise((resolve) => setTimeout(resolve, 40));
  return { get store() { return store; }, get sessions() { return sessions; }, engines, nativeCreates, beginShutdown,
    async idle(id: string) { await until(async () => { const events = await store.events(id); return (await store.projection(id))?.status === "idle" && (events.findLast(e => e.type === "turn/stopped")?.seq ?? 0) > (events.findLast(e => e.type === "user/message")?.seq ?? 0); }); },
    async close() { await drain(); detach.forEach((off) => off()); await store.close(); },
    async restart() { await drain(); detach.forEach((off) => off()); await store.close(); store = createStore(path); sessions = makeSessions(); }, setReleaseUnknown(value: boolean) { releaseUnknown = value; }, setCreateUnknown(value: boolean, receipt = true) { createUnknown = value; exposeReceipt = receipt; }, setAbortStops(value: boolean) { abortStops = value; } };
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

test("runtime features follow the newly selected harness", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  assert.equal((await f.sessions.runtimeFeatures!(id)).commands[0]?.harnessId, "fake-a");
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal((await f.sessions.runtimeFeatures!(id)).commands[0]?.harnessId, "fake-b");
  await f.close();
});

test("stop-now cannot start B on an abort acknowledgement or unknown release", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "mutating" });
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now"), { code: "outcome-unknown" });
  assert.equal(f.engines.length, 1, "abort acknowledgement must not start the target harness");
  f.setReleaseUnknown(true);
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now"), { code: "outcome-unknown" });
  assert.equal(f.engines.length, 1);
  f.setReleaseUnknown(false);
  f.engines[0]!.complete();
  await f.idle(id);
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
  const failed = (await f.store.projection(id))!.harnessTransition;
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.stage, "publishing-route");
  assert.equal(f.nativeCreates.length, 2); f.store.transitionRuntimeEpoch = originalTransition;
  await f.restart();
  const result = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(f.nativeCreates.length, 2); assert.equal(result.title, "Retained title"); assert.equal(result.resolvedHarnessId, "fake-b");
  await f.sessions.send(id, { text: "One prompt" });
  assert.equal((await f.store.events(id)).filter((e) => e.type === "user/message").length, 1);
  f.engines.at(-1)!.complete(); await f.idle(id); await f.close(); await rm(dir, { recursive: true, force: true });
});

test("a failed target can be replaced after release without restoring old authority", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  const originalTransition = f.store.transitionRuntimeEpoch;
  f.store.transitionRuntimeEpoch = async () => { throw new Error("target publication failed"); };
  await assert.rejects(
    f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }),
    /target publication failed/,
  );
  const failed = (await f.store.projection(id))!;
  assert.equal(failed.harnessTransition?.phase, "failed");
  assert.equal(failed.harnessTransition?.released?.authorityId, failed.runtimeBinding?.authorityId);

  f.store.transitionRuntimeEpoch = originalTransition;
  const recovered = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-a" });
  assert.equal(recovered.harnessTransition, undefined);
  assert.equal(recovered.resolvedHarnessId, "fake-a");
  assert.notEqual(recovered.backendSessionId, failed.backendSessionId);
  assert.equal((await f.store.events(id)).filter((event) => event.type === "harness/switch-retargeted").length, 1);
  await f.close();
});

test("a requested switch can be cancelled while the old harness still owns execution", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "keep working" });
  const pending = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(pending.harnessTransition?.phase, "requested");
  const cancelled = await f.sessions.cancelHarnessSwitch!(id);
  assert.equal(cancelled.harnessTransition, undefined);
  f.engines[0]!.complete(); await f.idle(id);
  assert.equal((await f.store.projection(id))!.resolvedHarnessId, "fake-a");
  assert.equal(f.engines.length, 1);
  assert.equal((await f.store.events(id)).filter((event) => event.type === "harness/switched").length, 0);
  await f.close();
});

test("retargeting a requested switch back to the current harness cancels without releasing authority", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "active" });
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  const retained = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-a" });
  assert.equal(retained.harnessTransition, undefined);
  f.engines[0]!.complete(); await f.idle(id);
  assert.equal(f.engines.length, 1);
  assert.equal((await f.store.projection(id))!.resolvedHarnessId, "fake-a");
  await f.close();
});

test("retargeting before release changes the destination without creating either target early", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "active" });
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  const retargeted = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-c" });
  assert.equal(retargeted.harnessTransition?.phase, "requested");
  assert.equal(retargeted.harnessTransition?.targetHarnessId, "fake-c");
  assert.equal(f.engines.length, 1, "prospective targets are not started before release");
  f.engines[0]!.complete();
  await until(async () => (await f.store.projection(id))?.resolvedHarnessId === "fake-c");
  assert.equal(f.engines.at(-1)!.harnessId, "fake-c");
  assert.equal(f.engines.some((runtime) => runtime.harnessId === "fake-b"), false);
  await f.close();
});

test("changing Auto pinning while it resolves to the sticky harness does not create a runtime leg", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  const initial = (await f.store.projection(id))!;
  const pinned = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-a" });
  const automatic = await f.sessions.switchHarness!(id, { mode: "auto" });
  assert.equal(pinned.resolvedHarnessId, "fake-a");
  assert.equal(automatic.resolvedHarnessId, "fake-a");
  assert.equal(automatic.runtimeLeg?.id, initial.runtimeLeg?.id);
  assert.equal(f.engines.length, 1);
  assert.equal((await f.store.events(id)).filter((event) => event.type === "harness/switched").length, 0);
  await f.close();
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
    f.setAbortStops(true);
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

function sharedFixture() {
  const store = createStore(":memory:");
  const detach: Array<() => void> = [];
  const registry = createHarnessRegistry();
  const occupancy = createSharedRuntimeOccupancy("shared-fake-a");
  const executing = new Set<string>();
  const releaseUnknown = new Set<string>();
  const nativeCreates: string[] = [];
  const engines: Array<AgentRuntime & { complete(): void; requests: CanonicalTurnRequest[]; harnessId: string }> = [];
  let sharedOwner: AgentRuntime | undefined;
  let sharedDisposed = 0;
  const provider = (id: string, shared: boolean): HarnessProvider => ({
    descriptor: { id, name: id, integration: "fake", priority: id === "fake-a" ? 0 : id === "fake-b" ? 1 : 2 },
    runtimeLifetime: shared ? "workspace" : "session",
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    async createRuntime(context: HarnessContext) {
      const sessionId = context.sessionId!;
      const makeOwner = () => {
        const authorityId = randomUUID();
        const endpoint = {
          authorityId,
          generation: 1,
          continuity: "verified" as const,
          url: "http://fake",
          location: { directory: context.cwd },
          control: { kind: "owned" as const, instanceToken: authorityId },
          config: { kind: "read-only" as const },
          authentication: { kind: "none" as const },
        };
        const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
        detach.push(() => listeners.clear());
        const emit = (sid: string, event: RuntimeEvent) => { for (const cb of listeners) cb(sid, event); };
        const nativeBySession = new Map<string, string>();
        const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
        let order = 0;
        const lastCreate = new Map<string, string>();
        const create = async (request: { sessionId: string }, operationId: string) => {
          assert.equal(
            executing.has(request.sessionId),
            false,
            "switching session is still executing on the previous engine",
          );
          const nativeId = randomUUID();
          nativeBySession.set(request.sessionId, nativeId);
          lastCreate.set(request.sessionId, operationId);
          nativeCreates.push(nativeId);
          accepted.push({ operationId, mutationKind: "session-reset", backendSessionId: nativeId, receipt: nativeId });
          return { kind: "confirmed" as const, value: { backendSessionId: nativeId }, receipt: nativeId };
        };
        const runtime: AgentRuntime & { emit(sid: string, event: RuntimeEvent): void } = {
          capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false, resume: true }),
          models: async () => [],
          agents: async () => [],
          ensureSession: async (input) => {
            const existing = input.backendSessionId ?? nativeBySession.get(input.sessionId);
            if (existing) nativeBySession.set(input.sessionId, existing);
            return existing ?? (await create(input, randomUUID())).value.backendSessionId;
          },
          createSessionOperation: create,
          resetSessionOperation: create,
          sessions: async () => [...nativeBySession.values()].map((nid) => ({
            id: nid, title: "fake", createdAt: 0, updatedAt: 0,
          })),
          history: async () => [],
          endpoint: async () => endpoint,
          protocol: async () => "legacy",
          reconcile: async (binding) => ({
            ...endpoint,
            backendSessionId: binding.backendSessionId!,
            reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
            state: {
              value: executing.has(binding.canonicalSessionId) ? "running" : "idle",
              comparison: { domain: binding.canonicalSessionId, order: ++order },
              causalOperationId: lastCreate.get(binding.canonicalSessionId) ?? "",
            },
            completeness: { events: "complete", permissions: "complete", questions: "complete" },
            permissions: [],
            questions: [],
            events: [],
            acceptedOperations: accepted,
          }),
          async startTurnOperation(request, operationId) {
            executing.add(request.sessionId);
            if (shared) occupancy.beginExecution(request.sessionId);
            accepted.push({ operationId, mutationKind: "turn-submit", receipt: operationId });
            emit(request.sessionId, { type: "turn/started", turnId: operationId });
            return { kind: "confirmed", value: {}, receipt: operationId };
          },
          startTurn: async () => {},
          abort: async () => {},
          abortOperation: async () => ({ kind: "confirmed", value: {} }),
          releaseExecution: async (binding, operationId) => {
            if (releaseUnknown.has(binding.canonicalSessionId)) {
              return { kind: "unknown", operationId, message: "old worker may still run" };
            }
            if (!binding.backendSessionId) {
              return { kind: "unknown", operationId, message: "release requires a backend session identity" };
            }
            if (executing.has(binding.canonicalSessionId)) {
              return { kind: "unknown", operationId, message: "Old execution has not been proven idle" };
            }
            return {
              kind: "confirmed",
              value: {
                authorityId: binding.authorityId,
                generation: binding.generation,
                backendSessionId: binding.backendSessionId,
              },
            };
          },
          replyPermission: async () => {},
          replyQuestion: async () => {},
          onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
          dispose: async () => { if (shared) sharedDisposed += 1; },
          emit,
        };
        return runtime;
      };
      let owner: AgentRuntime & { emit(sid: string, event: RuntimeEvent): void };
      if (shared) {
        if (!sharedOwner) sharedOwner = makeOwner();
        owner = sharedOwner as typeof owner;
      } else {
        owner = makeOwner();
      }
      const requests: CanonicalTurnRequest[] = [];
      const originalStart = owner.startTurnOperation!.bind(owner);
      owner.startTurnOperation = async (request, operationId) => {
        if (request.sessionId === sessionId) requests.push(request);
        return originalStart(request, operationId);
      };
      engines.push({
        harnessId: id,
        requests,
        complete() {
          owner.emit(sessionId, { type: "assistant/message", partId: randomUUID(), text: `confirmed answer from ${id}` });
          executing.delete(sessionId);
          if (shared) occupancy.endExecution(sessionId);
          owner.emit(sessionId, { type: "turn/stopped", reason: "completed" });
        },
      } as typeof engines[number]);
      return owner;
    },
  });
  registry.register(provider("fake-a", true));
  registry.register(provider("fake-b", false));
  registry.register(provider("fake-c", false));
  const pool = createHarnessPool({
    registry,
    legacyHarnessId: "fake-a",
    context: async (projectId, cwd, sessionId) => ({ projectId, cwd: cwd ?? "/same/worktree", sessionId, spaceId: "space-a" }),
  });
  const projects = { get: async () => ({ id: "p", name: "p", path: "/same/worktree", spaceId: "space-a", createdAt: 0 }), list: async () => [] } as unknown as ProjectService;
  const runtimes = {
    ...pool,
    bindSession(sessionId: string, runtime: AgentRuntime) {
      if (sharedOwner && runtime === sharedOwner) occupancy.acquireBinding(sessionId);
    },
    unbindSession(sessionId: string, runtime: AgentRuntime) {
      if (sharedOwner && runtime === sharedOwner) occupancy.releaseBinding(sessionId);
    },
  };
  const sessions = createSessionService({
    store,
    projects,
    runtimes,
    permissions: { evaluate: () => "ask" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
  });
  return {
    store,
    sessions,
    engines,
    nativeCreates,
    executing,
    occupancy,
    pool,
    get sharedOwner() { return sharedOwner; },
    get sharedDisposed() { return sharedDisposed; },
    setReleaseUnknown(sessionId: string, value: boolean) {
      if (value) releaseUnknown.add(sessionId);
      else releaseUnknown.delete(sessionId);
    },
    async idle(id: string) {
      await until(async () => {
        const events = await store.events(id);
        return (await store.projection(id))?.status === "idle"
          && (events.findLast((e) => e.type === "turn/stopped")?.seq ?? 0)
            > (events.findLast((e) => e.type === "user/message")?.seq ?? 0);
      });
    },
    async close() {
      await new Promise((resolve) => setTimeout(resolve, 40));
      detach.forEach((off) => off());
      await store.close();
    },
  };
}

test("A switches off a shared runtime while B is executing without interrupting B", async () => {
  const f = sharedFixture();
  const a = await f.sessions.create({ projectId: "p", title: "A" });
  const b = await f.sessions.create({ projectId: "p", title: "B" });
  await f.sessions.send(a.id, { text: "A ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("A ready")))!.complete();
  await f.idle(a.id);
  await f.sessions.send(b.id, { text: "B working" });
  const beforeB = (await f.store.projection(b.id))!.runtimeBinding!;
  assert.equal(f.executing.has(b.id), true);
  assert.equal(f.occupancy.snapshot().bindings, 2);
  assert.equal(f.sharedDisposed, 0);

  const switched = await f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(switched.resolvedHarnessId, "fake-b");
  assert.equal(switched.harnessTransition, undefined);
  assert.equal(f.executing.has(b.id), true, "B must keep executing on the shared runtime");
  assert.equal(f.sharedDisposed, 0);
  const afterB = (await f.store.projection(b.id))!.runtimeBinding!;
  assert.equal(afterB.authorityId, beforeB.authorityId);
  assert.equal(afterB.generation, beforeB.generation);
  assert.equal(afterB.backendSessionId, beforeB.backendSessionId);
  assert.notEqual(switched.runtimeBinding!.authorityId, beforeB.authorityId);
  assert.equal(f.occupancy.snapshot().bindings, 1);
  assert.equal(f.occupancy.snapshot().executions, 1);

  const bEngine = f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("B working")))!;
  bEngine.complete();
  await f.idle(b.id);
  assert.equal(f.executing.has(b.id), false);
  await f.close();
});

test("A switches while neighbor B has durable unknown operation state", async () => {
  const f = sharedFixture();
  const a = await f.sessions.create({ projectId: "p", title: "A" });
  const b = await f.sessions.create({ projectId: "p", title: "B" });
  await f.sessions.send(a.id, { text: "A ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("A ready")))!.complete();
  await f.idle(a.id);
  await f.sessions.send(b.id, { text: "B ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("B ready")))!.complete();
  await f.idle(b.id);
  const unknown = await f.store.prepareOperation({
    sessionId: b.id,
    mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text: "lost B turn" } },
  });
  await f.store.claimOperation(unknown.operation.operationId);
  await f.store.settleOperation(unknown.operation.operationId, {
    kind: "unknown",
    message: "B submission outcome was lost",
  });
  const beforeB = (await f.store.projection(b.id))!.runtimeBinding!;
  const switched = await f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(switched.resolvedHarnessId, "fake-b");
  assert.equal((await f.store.operation(unknown.operation.operationId))?.state, "unknown");
  const afterB = (await f.store.projection(b.id))!.runtimeBinding!;
  assert.equal(afterB.authorityId, beforeB.authorityId);
  assert.equal(afterB.generation, beforeB.generation);
  await f.close();
});

test("own unknown release still blocks the switching session's target harness", async () => {
  const f = sharedFixture();
  const a = await f.sessions.create({ projectId: "p", title: "A" });
  const b = await f.sessions.create({ projectId: "p", title: "B" });
  await f.sessions.send(a.id, { text: "mutating" });
  await f.sessions.send(b.id, { text: "neighbor" });
  f.setReleaseUnknown(a.id, true);
  const beforeEngines = f.engines.length;
  await assert.rejects(
    f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-b" }, "stop-now"),
    { code: "outcome-unknown" },
  );
  assert.equal(f.engines.some((engine) => engine.harnessId === "fake-b"), false);
  assert.equal(f.engines.length, beforeEngines);
  assert.equal((await f.store.projection(b.id))!.resolvedHarnessId ?? "fake-a", "fake-a");
  await f.close();
});

test("simultaneous switches off a shared runtime do not deadlock or double-dispose", async () => {
  const f = sharedFixture();
  const a = await f.sessions.create({ projectId: "p", title: "A" });
  const b = await f.sessions.create({ projectId: "p", title: "B" });
  await f.sessions.send(a.id, { text: "A ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("A ready")))!.complete();
  await f.idle(a.id);
  await f.sessions.send(b.id, { text: "B ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("B ready")))!.complete();
  await f.idle(b.id);
  const [switchedA, switchedB] = await Promise.all([
    f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-b" }),
    f.sessions.switchHarness!(b.id, { mode: "pinned", harnessId: "fake-c" }),
  ]);
  assert.equal(switchedA.resolvedHarnessId, "fake-b");
  assert.equal(switchedB.resolvedHarnessId, "fake-c");
  assert.equal(f.sharedDisposed, 0);
  assert.equal(f.occupancy.snapshot().bindings, 0);
  await f.pool.dispose();
  assert.equal(f.sharedDisposed, 0, "session handles must not physically dispose the shared owner");
  await f.sharedOwner!.dispose();
  assert.equal(f.sharedDisposed, 1);
  await f.close();
});

test("releasing the last shared-runtime lease leaves the process eligible for idle cleanup", async () => {
  const f = sharedFixture();
  const a = await f.sessions.create({ projectId: "p", title: "A" });
  const b = await f.sessions.create({ projectId: "p", title: "B" });
  await f.sessions.send(a.id, { text: "A ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("A ready")))!.complete();
  await f.idle(a.id);
  await f.sessions.send(b.id, { text: "B ready" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("B ready")))!.complete();
  await f.idle(b.id);
  assert.equal(f.occupancy.snapshot().bindings, 2);
  await f.sessions.archive(a.id);
  assert.equal(f.occupancy.snapshot().bindings, 1);
  assert.equal(f.sharedDisposed, 0);
  await f.sessions.archive(b.id);
  assert.equal(f.occupancy.snapshot().bindings, 0);
  assert.equal(f.occupancy.snapshot().executions, 0);
  assert.equal(f.sharedDisposed, 0);
  await f.close();
});

test("quiesce leaves a requested harness transition durable; queued work stays", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "working" });
  const pending = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(pending.harnessTransition?.phase, "requested");
  await f.sessions.send(id, { text: "after-quiesce", delivery: "queue" });
  f.beginShutdown();
  f.engines[0]!.complete();
  await f.idle(id);
  const after = (await f.store.projection(id))!;
  assert.equal(after.harnessTransition?.phase, "requested");
  assert.equal(after.resolvedHarnessId ?? "fake-a", "fake-a");
  assert.equal(f.engines.some((engine) => engine.harnessId === "fake-b"), false);
  const queued = await f.sessions.queueList(id);
  assert.equal(queued.some((item) => item.text === "after-quiesce"), true);
  assert.equal(
    f.engines.some((engine) => engine.requests.some((request) => request.text.endsWith("after-quiesce"))),
    false,
  );
  await f.close();
});

test("A→B→A rebind then switch to C needs this incarnation, not a stale sibling proof", async () => {
  const f = sharedFixture();
  const a = await f.sessions.create({ projectId: "p", title: "A" });
  const b = await f.sessions.create({ projectId: "p", title: "B" });
  await f.sessions.send(a.id, { text: "A first" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("A first")))!.complete();
  await f.idle(a.id);
  await f.sessions.send(b.id, { text: "B stays" });
  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("B stays")))!.complete();
  await f.idle(b.id);
  const firstA = (await f.store.projection(a.id))!;
  const firstB = (await f.store.projection(b.id))!;
  assert.ok(firstA.backendSessionId);
  assert.equal(firstA.runtimeBinding!.authorityId, firstB.runtimeBinding!.authorityId);

  const switchedB = await f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-b" }, "stop-now");
  assert.equal(switchedB.resolvedHarnessId, "fake-b");
  assert.equal((await f.store.projection(b.id))!.backendSessionId, firstB.backendSessionId);

  const rebound = await f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-a" }, "stop-now");
  assert.equal(rebound.resolvedHarnessId, "fake-a");
  assert.notEqual(rebound.backendSessionId, firstA.backendSessionId);
  assert.equal(rebound.runtimeBinding!.authorityId, firstB.runtimeBinding!.authorityId);
  assert.equal((await f.store.projection(b.id))!.backendSessionId, firstB.backendSessionId);

  await f.sessions.send(a.id, { text: "A mutating again" });
  assert.equal(f.executing.has(a.id), true);
  await assert.rejects(
    f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-c" }, "stop-now"),
    { code: "outcome-unknown" },
  );
  assert.equal((await f.store.projection(a.id))!.resolvedHarnessId ?? "fake-a", "fake-a");
  assert.equal(f.engines.some((engine) => engine.harnessId === "fake-c"), false);

  f.engines.find((engine) => engine.requests.some((request) => request.text.endsWith("A mutating again")))!.complete();
  await f.idle(a.id);
  const switchedC = await f.sessions.switchHarness!(a.id, { mode: "pinned", harnessId: "fake-c" }, "stop-now");
  assert.equal(switchedC.resolvedHarnessId, "fake-c");
  assert.equal((await f.store.projection(b.id))!.resolvedHarnessId ?? "fake-a", "fake-a");
  assert.equal((await f.store.projection(b.id))!.backendSessionId, firstB.backendSessionId);
  await f.close();
});

test("release proof is re-verifiable for the same incarnation", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "ready" });
  f.engines[0]!.complete();
  await f.idle(id);
  const binding = (await f.store.projection(id))!.runtimeBinding!;
  const first = await f.engines[0]!.releaseExecution!(binding, "first");
  assert.equal(first.kind, "confirmed");
  const again = await f.engines[0]!.releaseExecution!(binding, "again");
  assert.equal(again.kind, "confirmed");
  if (again.kind === "confirmed") {
    assert.equal(again.value.backendSessionId, binding.backendSessionId);
    assert.equal(again.value.authorityId, binding.authorityId);
    assert.equal(again.value.generation, binding.generation);
  }
  const switched = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now");
  assert.equal(switched.resolvedHarnessId, "fake-b");
  await f.close();
});
