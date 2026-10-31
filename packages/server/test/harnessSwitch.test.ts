import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, CanonicalTurnRequest, HarnessContext, HarnessProvider, ModelRef, ProjectService, RuntimeEvent, RuntimeSnapshot } from "@polyth/contracts";
import { createAutoAcceptStore, type PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createHarnessPool, createHarnessRegistry } from "@polyth/harness-runtime";
import { createSessionService } from "../src/sessions.ts";
import { createSharedRuntimeOccupancy } from "../src/runtimeOccupancy.ts";

const until = async (condition: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) { if (await condition()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail("condition not reached");
};

function fixture(path = ":memory:", options: {
  workspaceInstructions?: {
    read(root: string, projectId: string): Promise<string | null>;
  };
  workspaceInstructionsEnabled?: boolean;
  branchOutcome?: "confirmed" | "mismatch" | "unknown";
  resetUnsupportedHarness?: string;
  /** When set, the fake target resolves its own launch selection (as a
   *  launch-locked CLI would) instead of echoing the requested one. */
  observedLaunch?: ModelRef;
  /** Model OpenCode's create seam: an existing in-memory canonical mapping
   *  makes ensure/create reuse it, while reset must still create a new leg. */
  reuseExistingBackendOnCreate?: boolean;
  /** Hold provider construction after the canonical session row is durable. */
  runtimeGate?: Promise<void>;
  compactionSummary?: Parameters<typeof createSessionService>[0]["compactionSummary"];
  /** Engines report native compaction that ends in the background with this
   *  outcome (as Claude's `/compact` does). */
  nativeCompaction?: "compacted" | "failed";
  /** Harnesses that declare `privateSessions`, and the Space preferences. */
  privateSessions?: { supported: string[]; preferences: Record<string, { privateSessions?: boolean }> };
} = {}) {
  let store = createStore(path);
  const detach: Array<() => void> = [];
  let shuttingDown = false;
  const beginShutdown = () => { shuttingDown = true; };
  const registry = createHarnessRegistry();
  type FakeEngine = AgentRuntime & {
    complete(): void;
    rateLimit(): void;
    requestPermission(requestId: string): void;
    requests: CanonicalTurnRequest[];
    permissionReplies: Array<{ requestId: string; reply: string }>;
    harnessId: string;
  };
  const engines: FakeEngine[] = [];
  const executing = new Set<string>();
  let releaseUnknown = false;
  let createUnknown = false;
  let createRejected = false;
  let exposeReceipt = true;
  let abortStops = false;
  const nativeCreates: string[] = [];
  const nativeResets: string[] = [];
  const nativeCompactions: string[] = [];
  const nativeBranches: string[] = [];
  const createRequests: Array<{ model?: ModelRef; agent?: string }> = [];
  const broadcasts: string[] = [];
  const launches: Array<{ harnessId: string; privateSession: boolean }> = [];
  const provider = (id: string): HarnessProvider => ({
    descriptor: { id, name: id, integration: "fake", priority: id === "fake-a" ? 0 : 1, ...(options.privateSessions?.supported.includes(id) ? { privateSessions: true as const } : {}) },
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    async createRuntime(context: HarnessContext) {
      await options.runtimeGate;
      launches.push({ harnessId: id, privateSession: context.privateSession === true });
      const authorityId = randomUUID();
      const endpoint = { authorityId, generation: 1, continuity: "verified" as const, url: "http://fake", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
      const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
      detach.push(() => listeners.clear());
      const emit = (event: RuntimeEvent) => { for (const cb of listeners) cb(context.sessionId!, event); };
      let nativeId = "";
      let order = 0;
      let lastCreateId = "";
      const nativePermissions = new Map<string, { permission: string; patterns: string[] }>();
      const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
      const create = async (
        request: { sessionId: string; model?: ModelRef; agent?: string },
        operationId: string,
        mode: "create" | "reset" = "create",
      ) => {
        assert.equal(executing.size, 0, "no target native session while previous engine can execute");
        if (createRejected) return { kind: "rejected" as const, code: "native-failure", message: "target bridge failed to connect" };
        if (mode === "create" && options.reuseExistingBackendOnCreate && nativeId) {
          return { kind: "confirmed" as const, value: { backendSessionId: nativeId }, receipt: nativeId };
        }
        nativeId = randomUUID(); lastCreateId = operationId; nativeCreates.push(nativeId);
        createRequests.push({ ...(request.model ? { model: request.model } : {}), ...(request.agent ? { agent: request.agent } : {}) });
        accepted.push({ operationId, mutationKind: "session-reset", backendSessionId: nativeId, receipt: nativeId });
        if (createUnknown) return { kind: "unknown" as const, operationId, message: "response lost" };
        return {
          kind: "confirmed" as const,
          value: {
            backendSessionId: nativeId,
            ...(options.observedLaunch ? { launch: { model: options.observedLaunch } } : {}),
          },
          receipt: nativeId,
        };
      };
      const runtime: FakeEngine = {
        harnessId: id,
        requests: [],
        permissionReplies: [],
        capabilities: async () => ({
          streaming: true,
          permissions: true,
          questions: false,
          compaction: Boolean(options.nativeCompaction),
          subagents: false,
          resume: true,
          commands: { discovery: "native", invoke: "raw-native-input" },
        }),
        ...(options.nativeCompaction ? {
          compactOperation: async () => {
            nativeCompactions.push(id);
            setTimeout(() => emit(options.nativeCompaction === "compacted"
              ? { type: "session/compacted", backendEventId: randomUUID(), summary: "NATIVE-SUMMARY" }
              : { type: "session/compaction-failed", error: "native compact failed" }), 30);
            return { kind: "confirmed" as const, value: { completion: "pending" as const } };
          },
        } satisfies Partial<AgentRuntime> : {}),
        commands: async () => [{
          id: `native:${id}:status`,
          name: "status",
          owner: "native",
          harnessId: id,
          invocation: "raw-native-input",
        }],
        models: async () => [], agents: async () => [],
        ensureSession: async (input) => nativeId = input.backendSessionId ?? nativeId,
        createSessionOperation: (request, operationId) => create(request, operationId, "create"),
        resetSessionOperation: async (request, operationId) => {
          nativeResets.push(operationId);
          return options.resetUnsupportedHarness === id
            ? { kind: "rejected" as const, code: "unsupported", message: "exact native history reset is unavailable" }
            : create(request, operationId, "reset");
        },
        ...(options.branchOutcome ? {
          branchSessionOperation: async (_request, operationId) => {
            if (options.branchOutcome === "confirmed") {
              const branchId = `branch-${randomUUID()}`;
              nativeBranches.push(branchId);
              nativeId = branchId;
              return { kind: "confirmed" as const, value: { backendSessionId: branchId }, receipt: branchId };
            }
            return options.branchOutcome === "mismatch"
              ? { kind: "rejected" as const, code: "history-mismatch", message: "requested history prefix is not present in the backend session" }
              : { kind: "unknown" as const, operationId, message: "branch response lost" };
          },
        } satisfies Partial<AgentRuntime> : {}),
        sessions: async () => nativeId ? [{ id: nativeId, title: "fake", createdAt: 0, updatedAt: 0, ...(exposeReceipt ? { operationId: lastCreateId } : {}) }] : [],
        history: async () => [], endpoint: async () => endpoint, protocol: async () => "legacy",
        reconcile: async (binding) => ({
          ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
          state: { value: executing.has(authorityId) ? "running" : "idle", comparison: { domain: authorityId, order: ++order }, causalOperationId: lastCreateId },
          completeness: { events: "complete", permissions: "complete", questions: "complete" },
          permissions: [...nativePermissions].map(([requestId, request]) => ({ requestId, ...request, revision: "pending" })),
          questions: [], events: [], acceptedOperations: accepted,
        }),
        async startTurnOperation(request, operationId) {
          runtime.requests.push(request); executing.add(authorityId); order++;
          accepted.push({ operationId, mutationKind: "turn-submit", receipt: operationId });
          emit({ type: "turn/started", turnId: operationId });
          return { kind: "confirmed", value: {}, receipt: operationId };
        },
        startTurn: async () => {},
        requestPermission(requestId) {
          nativePermissions.set(requestId, { permission: "bash", patterns: ["git status"] });
          emit({ type: "permission/requested", requestId, permission: "bash", patterns: ["git status"] });
        },
        complete() { emit({ type: "assistant/message", partId: randomUUID(), text: `confirmed answer from ${id}` }); executing.delete(authorityId); order++; emit({ type: "turn/stopped", reason: "completed" }); },
        rateLimit() {
          executing.delete(authorityId);
          order++;
          emit({
            type: "turn/stopped",
            reason: "error",
            error: "rate limited",
            retry: { scope: "rate", provider: id, retryAfterSec: 30 },
          });
        },
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
        replyPermission: async (_sessionId, requestId, reply) => {
          nativePermissions.delete(requestId);
          runtime.permissionReplies.push({ requestId, reply });
        },
        replyQuestion: async () => {},
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        dispose: async () => {},
      };
      engines.push(runtime); return runtime;
    },
  });
  registry.register(provider("fake-a")); registry.register(provider("fake-b")); registry.register(provider("fake-c"));
  let privatePreferences = options.privateSessions?.preferences ?? {};
  registry.configurePolicy(async () => privatePreferences);
  const pool = createHarnessPool({ registry, legacyHarnessId: "fake-a", context: async (projectId, cwd, sessionId) => ({ projectId, cwd: cwd ?? "/same/worktree", sessionId, spaceId: "space-a" }) });
  const projects = { get: async () => ({ id: "p", name: "p", path: "/same/worktree", spaceId: "space-a", createdAt: 0 }), list: async () => [] } as unknown as ProjectService;
  const autoAcceptPath = path === ":memory:"
    ? join(mkdtempSync(join(tmpdir(), "harness-auto-accept-")), "auto-accept.json")
    : `${path}.auto-accept.json`;
  const makeSessions = () => createSessionService({
    store,
    projects,
    runtimes: pool,
    permissions: { evaluate: () => "ask" } as unknown as PermissionService,
    autoAccept: createAutoAcceptStore(autoAcceptPath),
    broadcast: { event(event) { broadcasts.push(event.type); }, projection() {} },
    queue: store,
    isShuttingDown: () => shuttingDown,
    ...(options.workspaceInstructions ? { workspaceInstructions: options.workspaceInstructions } : {}),
    ...(options.workspaceInstructionsEnabled !== undefined
      ? { workspaceInstructionsEnabled: async () => options.workspaceInstructionsEnabled! }
      : {}),
    ...(options.compactionSummary ? { compactionSummary: options.compactionSummary } : {}),
  });
  let sessions = makeSessions();
  const drain = () => new Promise((resolve) => setTimeout(resolve, 40));
  return { get store() { return store; }, get sessions() { return sessions; }, pool, engines, nativeCreates, nativeResets, nativeCompactions, nativeBranches, createRequests, broadcasts, beginShutdown, launches,
    setPrivatePreferences(next: Record<string, { privateSessions?: boolean }>) { privatePreferences = next; },
    async idle(id: string) { await until(async () => { const events = await store.events(id); return (await store.projection(id))?.status === "idle" && (events.findLast(e => e.type === "turn/stopped")?.seq ?? 0) > (events.findLast(e => e.type === "user/message")?.seq ?? 0); }); },
    async close() { await drain(); detach.forEach((off) => off()); await store.close(); },
    async restart() { await drain(); detach.forEach((off) => off()); await store.close(); store = createStore(path); sessions = makeSessions(); }, setReleaseUnknown(value: boolean) { releaseUnknown = value; }, setCreateUnknown(value: boolean, receipt = true) { createUnknown = value; exposeReceipt = receipt; }, setCreateRejected(value: boolean) { createRejected = value; }, setAbortStops(value: boolean) { abortStops = value; } };
}

test("a first prompt queues while its matching new-session runtime is still starting", async () => {
  let releaseRuntime!: () => void;
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const f = fixture(":memory:", { runtimeGate });
  const id = randomUUID();
  const selection = { mode: "pinned" as const, harnessId: "fake-a" };
  const model: ModelRef = { providerID: "fake-a", modelID: "a-flagship", variant: "high" };
  const creating = f.sessions.create({ id, projectId: "p", harness: selection, model });
  let released = false;
  try {
    await until(async () => Boolean(await f.store.projection(id)));

    const sent = await f.sessions.send(id, {
      text: "run after startup",
      harness: selection,
      model,
    });

    assert.equal(sent.queued, true);
    assert.equal((await f.store.projection(id))?.harnessTransition, undefined);
    assert.equal((await f.sessions.queueList(id))[0]?.text, "run after startup");

    released = true;
    releaseRuntime();
    await creating;
    await until(async () => f.engines[0]?.requests.some((request) => request.text.endsWith("run after startup")) ?? false);
    assert.equal(f.engines[0]?.harnessId, "fake-a");
    assert.deepEqual(f.engines[0]?.requests.at(-1)?.model, model);
    f.engines[0]!.complete();
    await f.idle(id);
  } finally {
    if (!released) releaseRuntime();
    await creating.catch(() => {});
    await f.close();
  }
});

test("a matching pre-binding switch left by an older sender is collapsed", async () => {
  let releaseRuntime!: () => void;
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const f = fixture(":memory:", { runtimeGate });
  const id = randomUUID();
  const selection = { mode: "pinned" as const, harnessId: "fake-a" };
  const model: ModelRef = { providerID: "fake-a", modelID: "a-flagship", variant: "high" };
  const creating = f.sessions.create({ id, projectId: "p", harness: selection, model });
  let released = false;
  try {
    await until(async () => Boolean(await f.store.projection(id)));
    const projection = (await f.store.projection(id))!;
    await f.store.upsertProjection({
      ...projection,
      harnessTransition: {
        id: randomUUID(),
        selection,
        targetHarnessId: "fake-a",
        timing: "stop-now",
        launch: { model },
        phase: "requested",
      },
    });

    const sent = await f.sessions.send(id, {
      text: "recover the first prompt",
      harness: selection,
      model,
    });

    assert.equal(sent.queued, true);
    assert.equal((await f.store.projection(id))?.harnessTransition, undefined);
    assert.ok((await f.store.events(id)).some((event) =>
      event.type === "harness/switch-cancelled"
      && event.data.reason === "route-already-selected-before-runtime-binding"));

    released = true;
    releaseRuntime();
    await creating;
    await until(async () => f.engines[0]?.requests.some((request) => request.text.endsWith("recover the first prompt")) ?? false);
    f.engines[0]!.complete();
    await f.idle(id);
  } finally {
    if (!released) releaseRuntime();
    await creating.catch(() => {});
    await f.close();
  }
});

test("a first-prompt route change waits for the starting runtime's binding", async () => {
  let releaseRuntime!: () => void;
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const f = fixture(":memory:", { runtimeGate });
  const id = randomUUID();
  const initial = { mode: "pinned" as const, harnessId: "fake-a" };
  const target = { mode: "pinned" as const, harnessId: "fake-b" };
  const model: ModelRef = { providerID: "fake-b", modelID: "b-flagship", variant: "high" };
  const creating = f.sessions.create({ id, projectId: "p", harness: initial });
  let released = false;
  try {
    await until(async () => Boolean(await f.store.projection(id)));

    const sent = await f.sessions.send(id, {
      text: "switch after startup",
      harness: target,
      model,
    });

    assert.equal(sent.queued, true);
    assert.equal((await f.store.projection(id))?.harnessTransition?.targetHarnessId, "fake-b");
    assert.equal((await f.sessions.queueList(id))[0]?.text, "switch after startup");

    released = true;
    releaseRuntime();
    await creating;
    await until(async () => f.engines.some((engine) =>
      engine.harnessId === "fake-b"
      && engine.requests.some((request) => request.text.endsWith("switch after startup"))));
    const targetEngine = f.engines.find((engine) => engine.harnessId === "fake-b")!;
    assert.deepEqual(targetEngine.requests.at(-1)?.model, model);
    assert.equal(f.engines.find((engine) => engine.harnessId === "fake-a")?.requests.length, 0);
    assert.equal((await f.store.projection(id))?.harnessTransition, undefined);
    targetEngine.complete();
    await f.idle(id);
  } finally {
    if (!released) releaseRuntime();
    await creating.catch(() => {});
    await f.close();
  }
});

test("submit-time route change creates the target leg with the stated model", async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "A1" }); f.engines.at(-1)!.complete();
    await f.idle(id);
    const model: ModelRef = { providerID: "fake-b", modelID: "b-flagship", variant: "high" };
    await f.sessions.send(id, {
      text: "run this on the other harness",
      harness: { mode: "pinned", harnessId: "fake-b" },
      model,
    });
    // The leg was CREATED with the selection its first turn uses. A
    // launch-locked runtime would otherwise start on its provider default and
    // reject this very turn.
    assert.deepEqual(f.createRequests.at(-1), { model });
    assert.deepEqual(f.engines.at(-1)!.requests.at(-1)!.model, model);
    // The canonical record publishes the launch selection, never the previous
    // harness's stale model.
    const projection = (await f.store.projection(id))!;
    assert.equal(projection.resolvedHarnessId, "fake-b");
    assert.deepEqual(projection.model, model);
    f.engines.at(-1)!.complete();
  } finally {
    await f.close();
  }
});

test("a route change without a stated model publishes the selection the target resolved", async () => {
  const observed: ModelRef = { providerID: "fake-b", modelID: "b-default" };
  const f = fixture(":memory:", { observedLaunch: observed });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    const switched = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
    // Polyth stated no model, so the target's own choice is the locked one and
    // the projection must name it instead of leaving the session ambiguous.
    assert.equal(switched.resolvedHarnessId, "fake-b");
    assert.deepEqual(switched.model, observed);
  } finally {
    await f.close();
  }
});

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

test("harness switching starts a fresh target session when exact native reset is unsupported", async () => {
  const f = fixture(":memory:", { resetUnsupportedHarness: "fake-b" });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    const original = (await f.store.projection(id))!;
    const switched = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });

    assert.equal(switched.resolvedHarnessId, "fake-b");
    assert.notEqual(switched.backendSessionId, original.backendSessionId);
    assert.equal(f.engines.at(-1)?.harnessId, "fake-b");
    assert.equal(switched.harnessTransition, undefined);
    assert.equal(f.nativeResets.length, 0, "a fresh harness target must not receive an exact-history reset");
  } finally {
    await f.close();
  }
});

test("rewind replacement creates a fresh leg across non-fork harnesses", async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    for (const text of ["keep", "replace me"]) {
      await f.sessions.send(id, { text });
      f.engines.at(-1)!.complete();
      await f.idle(id);
    }
    for (const harnessId of ["fake-b", "fake-c", "fake-a", "fake-a"]) {
      const target = (await f.store.events(id)).findLast((event) => event.type === "user/message")!;
      await f.sessions.rewind!(id, target.seq);

      const submitted = await f.sessions.send(id, {
        text: `edited replacement on ${harnessId}`,
        harness: { mode: "pinned", harnessId },
      });
      assert.equal(typeof submitted.turnId, "string");
      await until(async () => (f.engines.at(-1)?.requests.length ?? 0) > 0);
      const engine = f.engines.at(-1)!;
      assert.equal(engine.harnessId, harnessId);
      assert.match(engine.requests.at(-1)!.text, new RegExp(`edited replacement on ${harnessId}$`));
      assert.match(engine.requests.at(-1)!.text, /keep/);
      assert.doesNotMatch(engine.requests.at(-1)!.text, /replace me/);
      const events = await f.store.events(id);
      assert.equal(
        (events.findLast((event) => event.type === "session/rewind-cleared")?.data as { replaced?: boolean }).replaced,
        true,
      );
      assert.equal((await f.store.projection(id))?.harnessTransition, undefined);
      engine.complete();
      await f.idle(id);
    }
  } finally {
    await f.close();
  }
});

test("rewind replacement recovers from rejected native history without including the discarded tail", async () => {
  const f = fixture(":memory:", { branchOutcome: "mismatch" });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    for (const text of ["keep this context", "discard this tail"]) {
      await f.sessions.send(id, { text });
      f.engines.at(-1)!.complete();
      await f.idle(id);
    }
    for (const replacement of ["first replacement", "second replacement"]) {
      const before = (await f.store.projection(id))!;
      // Existing sessions can have a binding without runtime-leg metadata.
      // Exercise native branching rather than the send-time stale-leg reset.
      await f.store.upsertProjection({ ...before, runtimeLeg: undefined });
      const target = (await f.store.events(id)).findLast((event) => event.type === "user/message")!;
      await f.sessions.rewind!(id, target.seq);
      const submitted = await f.sessions.send(id, { text: replacement });
      assert.equal(typeof submitted.turnId, "string");
      const request = f.engines.at(-1)!.requests.at(-1)!;
      assert.match(request.text, /keep this context/);
      assert.doesNotMatch(request.text, /discard this tail/);
      if (replacement === "second replacement") assert.doesNotMatch(request.text, /first replacement/);
      assert.ok(request.text.endsWith(replacement));
      const after = (await f.store.projection(id))!;
      assert.notEqual(after.backendSessionId, before.backendSessionId);
      assert.equal(after.resolvedHarnessId, before.resolvedHarnessId);
      const events = await f.store.events(id);
      assert.equal(events.findLast((event) => event.type === "session/rewind-cleared")?.data.strategy, "fresh-runtime-epoch");
      assert.ok(events.some((event) => event.type === "mutation/rejected" && event.data.code === "history-mismatch"));
      assert.equal(events.findLast((event) => event.type === "user/message")?.data.text, replacement);
      f.engines.at(-1)!.complete();
      await f.idle(id);
    }
  } finally {
    await f.close();
  }
});

test("idle rewind replacement branches the synchronized leg without a same-harness switch", async () => {
  const f = fixture(":memory:", { branchOutcome: "confirmed" });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    for (const text of ["keep this context", "discard this tail"]) {
      await f.sessions.send(id, { text });
      f.engines.at(-1)!.complete();
      await f.idle(id);
    }
    const before = (await f.store.projection(id))!;
    assert.ok(before.runtimeLeg, "a harness-pool session owns a synchronized native leg");
    const engines = f.engines.length;
    const creates = f.nativeCreates.length;
    const target = (await f.store.events(id)).findLast((event) => event.type === "user/message")!;
    const marker = await f.sessions.rewind!(id, target.seq);

    const submitted = await f.sessions.send(id, { text: "edited replacement" });
    assert.equal(typeof submitted.turnId, "string");

    const tail = (await f.store.events(id)).filter((event) => event.seq > marker.seq);
    // The shortened effective dialogue is the rewind's own business: no stale
    // leg reset, no harness transaction, no fresh native session.
    assert.deepEqual(tail.filter((event) => event.type.startsWith("harness/")).map((event) => event.type), []);
    assert.equal(f.nativeCreates.length, creates);
    assert.equal(f.engines.length, engines);
    assert.equal(f.nativeBranches.length, 1);
    const cleared = tail.filter((event) => event.type === "session/rewind-cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]!.data.replaced, true);
    assert.equal(cleared[0]!.data.strategy, undefined, "the exact native branch was used");
    assert.equal(tail.findLast((event) => event.type === "user/message")?.data.text, "edited replacement");

    const request = f.engines.at(-1)!.requests.at(-1)!;
    assert.ok(request.text.endsWith("edited replacement"));
    assert.doesNotMatch(request.text, /discard this tail/);

    // The leg continues on the branch at the rewind-effective checkpoint.
    const after = (await f.store.projection(id))!;
    assert.equal(after.backendSessionId, f.nativeBranches[0]);
    assert.equal(after.runtimeLeg?.id, before.runtimeLeg.id);
    assert.equal(after.runtimeLeg?.nativeSessionId, f.nativeBranches[0]);
    assert.equal(after.runtimeLeg?.bootstrap, "native-resume");
    const keptAnswer = (await f.store.events(id))
      .filter((event) => event.type === "assistant/message" && event.seq < target.seq)
      .at(-1)!;
    assert.equal(after.runtimeLeg?.canonicalThroughSeq, keptAnswer.seq);
    f.engines.at(-1)!.complete();
    await f.idle(id);

    // The next ordinary send continues the branched leg. Its shortened history
    // is synchronized now, so it must not trigger a same-harness reset.
    const followUp = await f.sessions.send(id, { text: "ordinary follow-up" });
    assert.equal(typeof followUp.turnId, "string");
    assert.equal(f.nativeBranches.length, 1);
    assert.equal(f.nativeCreates.length, creates);
    assert.equal(f.engines.length, engines);
    assert.equal((await f.store.projection(id))?.runtimeLeg?.id, before.runtimeLeg.id);
    f.engines.at(-1)!.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
});

test("running first-message rewind uses a fresh same-harness leg without a visible failure", async () => {
  const f = fixture(":memory:", { reuseExistingBackendOnCreate: true });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    const before = (await f.store.projection(id))!;
    await f.sessions.send(id, { text: "first message" });
    const first = (await f.store.events(id)).find((event) => event.type === "user/message")!;
    await f.sessions.rewind!(id, first.seq);

    const queued = await f.sessions.send(id, { text: "replacement message" });
    assert.equal(queued.queued, true);
    f.engines[0]!.complete();
    await until(async () => f.engines.some((engine) =>
      engine.requests.some((request) => request.text.endsWith("replacement message"))));

    const after = (await f.store.projection(id))!;
    const events = await f.store.events(id);
    assert.notEqual(after.backendSessionId, before.backendSessionId);
    assert.equal(after.harnessTransition, undefined);
    assert.equal(f.nativeResets.length, 1, "same-harness replacement must use the reset seam");
    assert.equal(events.some((event) => event.type === "harness/switch-failed"), false);
    assert.equal(events.some((event) => event.type === "turn/failed"), false);
    assert.equal(
      events.findLast((event) => event.type === "user/message")?.data.text,
      "replacement message",
    );
    f.engines.at(-1)!.complete();
  } finally {
    f.beginShutdown();
    await f.close();
  }
});

test("same-harness rewind replaces a legacy confirmed create receipt", async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "first message" });
    f.engines[0]!.complete();
    await f.idle(id);
    const before = (await f.store.projection(id))!;
    const first = (await f.store.events(id)).find((event) => event.type === "user/message")!;
    await f.sessions.rewind!(id, first.seq);

    const transitionId = randomUUID();
    const stale = await f.store.prepareOperation({
      sessionId: id,
      mutationKind: "session-reset",
      intentEvent: {
        type: "harness/native-create-requested",
        data: { transitionId, harnessId: "fake-a" },
        ignorable: true,
      },
    });
    await f.store.claimOperation(stale.operation.operationId);
    await f.store.settleOperation(stale.operation.operationId, {
      kind: "confirmed",
      receipt: before.backendSessionId,
    });
    await f.store.upsertProjection({
      ...before,
      harnessTransition: {
        id: transitionId,
        selection: { mode: "pinned", harnessId: "fake-a" },
        targetHarnessId: "fake-a",
        timing: "after-turn",
        phase: "failed",
        attempt: 1,
        lastAttemptAt: Date.now(),
        error: { stage: "publishing-route", message: "legacy create reused the old backend" },
        released: {
          authorityId: before.runtimeBinding!.authorityId,
          generation: before.runtimeBinding!.generation,
          backendSessionId: before.backendSessionId!,
        },
      },
    });

    const retried = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-a" });
    assert.equal(retried.harnessTransition, undefined);
    assert.equal(f.nativeResets.length, 1);
    assert.notEqual(retried.backendSessionId, before.backendSessionId);
    f.engines.at(-1)!.complete();
  } finally {
    f.beginShutdown();
    await f.close();
  }
});

for (const failure of ["unknown branch", "unknown release"] as const) {
  test(`rewind replacement preserves the marker and creates no new leg after ${failure}`, async () => {
    const f = fixture(":memory:", { branchOutcome: failure === "unknown branch" ? "unknown" : "mismatch" });
    try {
      const { id } = await f.sessions.create({ projectId: "p" });
      for (const text of ["keep", "replace me"]) {
        await f.sessions.send(id, { text });
        f.engines.at(-1)!.complete();
        await f.idle(id);
      }
      const before = (await f.store.projection(id))!;
      await f.store.upsertProjection({ ...before, runtimeLeg: undefined });
      const creates = f.nativeCreates.length;
      const target = (await f.store.events(id)).findLast((event) => event.type === "user/message")!;
      await f.sessions.rewind!(id, target.seq);
      if (failure === "unknown release") f.setReleaseUnknown(true);
      await assert.rejects(f.sessions.send(id, { text: "replacement" }), { code: "outcome-unknown" });
      f.beginShutdown();
      assert.equal(f.nativeCreates.length, creates);
      assert.equal((await f.store.projection(id))?.backendSessionId, before.backendSessionId);
      const events = await f.store.events(id);
      assert.equal(events.some((event) => event.type === "session/rewind-cleared"), false);
      assert.equal(events.some((event) => event.type === "user/message" && event.data.text === "replacement"), false);
    } finally {
      await f.close();
    }
  });
}

test("queued rewind replacement recovers from missing native history", async () => {
  const f = fixture(":memory:", { branchOutcome: "mismatch" });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "keep queued context" });
    f.engines[0]!.complete();
    await f.idle(id);
    await f.sessions.send(id, { text: "discard running tail" });
    const target = (await f.store.events(id)).findLast((event) => event.type === "user/message")!;
    await f.sessions.rewind!(id, target.seq);
    const queued = await f.sessions.send(id, { text: "queued replacement" });
    assert.equal(queued.queued, true);
    f.engines[0]!.complete();
    await until(async () => f.engines.some((engine) => engine.requests.some((request) => request.text.endsWith("queued replacement"))));
    const engine = f.engines.at(-1)!;
    assert.match(engine.requests.at(-1)!.text, /keep queued context/);
    assert.doesNotMatch(engine.requests.at(-1)!.text, /discard running tail/);
    assert.equal(f.engines.flatMap((engine) => engine.requests).filter((request) => request.text.endsWith("queued replacement")).length, 1);
    engine.complete();
    await f.idle(id);
  } finally {
    f.beginShutdown();
    await f.close();
  }
});

test("queued rewind replacement refreshes the dispatcher after a non-fork leg reset", async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "keep" });
    f.engines[0]!.complete();
    await f.idle(id);

    await f.sessions.send(id, { text: "replace me" });
    const target = (await f.store.events(id)).findLast((event) => event.type === "user/message")!;
    await f.sessions.rewind!(id, target.seq);
    const pending = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
    assert.equal(pending.harnessTransition?.phase, "requested");

    const queued = await f.sessions.send(id, { text: "edited queued" });
    assert.equal(queued.queued, true);
    f.engines[0]!.complete();
    await until(async () => f.engines.some((engine) =>
      engine.harnessId === "fake-b" && engine.requests.some((request) => request.text.endsWith("edited queued"))));

    const engine = f.engines.findLast((candidate) =>
      candidate.harnessId === "fake-b" && candidate.requests.some((request) => request.text.endsWith("edited queued")))!;
    assert.equal(engine.requests.at(-1)!.text.endsWith("edited queued"), true);
    engine.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
});

test("rate-limit recovery switches harness before resending the selected model", async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "continue this work" });
    f.engines.at(-1)!.rateLimit();
    await until(async () => Boolean((await f.store.projection(id))?.resume));

    await f.sessions.resumeNow!(id, {
      harness: { mode: "pinned", harnessId: "fake-b" },
      model: { providerID: "other", modelID: "selected", variant: "high" },
    });

    await until(async () => f.engines.at(-1)?.harnessId === "fake-b"
      && f.engines.at(-1)?.requests.length === 1);
    const projection = await f.store.projection(id);
    assert.equal(projection?.resolvedHarnessId, "fake-b");
    assert.deepEqual(projection?.model, { providerID: "other", modelID: "selected", variant: "high" });
    assert.equal(projection?.resume, undefined);
    // A fresh harness leg receives canonical continuity before the retried
    // user text; the visible/durable message itself remains unchanged below.
    assert.match(f.engines.at(-1)!.requests[0]!.text, /continue this work$/);
    const messages = (await f.store.events(id)).filter((event) => event.type === "user/message");
    assert.equal((messages.at(-1)!.data as { autoResume?: boolean }).autoResume, true);
  } finally {
    await f.close();
  }
});

test("compact before proceeding waits for a background native compaction, then resends on it", async () => {
  const f = fixture(":memory:", { nativeCompaction: "compacted" });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "continue this work" });
    f.engines.at(-1)!.rateLimit();
    await until(async () => Boolean((await f.store.projection(id))?.resume));
    await f.sessions.setResumeCompact!(id, true);

    await f.sessions.resumeNow!(id);
    await until(async () => f.engines.at(-1)!.requests.length === 2);

    assert.deepEqual(f.nativeCompactions, ["fake-a"]);
    assert.equal(f.engines.length, 1, "the native context was compacted in place");
    const events = await f.store.events(id);
    // Queued behind the compaction, the failed session never dispatched it.
    assert.ok(!events.some((event) => event.type === "queue/enqueued"));
    const compacted = events.findLast((event) => event.type === "session/compacted")!;
    const started = events.findLast((event) => event.type === "turn/started")!;
    assert.ok(compacted.seq < started.seq, "the resend ran on the compacted context");
    assert.ok(!events.some((event) => event.type === "session/compaction-failed"));
    f.engines.at(-1)!.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
});

test("compact before proceeding falls back to a small-model summary when the native compaction fails", async () => {
  const requests: Array<{ smallModelFirst?: boolean }> = [];
  const f = fixture(":memory:", {
    nativeCompaction: "failed",
    compactionSummary: async ({ smallModelFirst }) => {
      requests.push({ ...(smallModelFirst ? { smallModelFirst } : {}) });
      return "## Goal\nSMALL-MODEL-SUMMARY";
    },
  });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "first request" });
    f.engines.at(-1)!.complete();
    await f.idle(id);
    await f.sessions.send(id, { text: "continue this work" });
    f.engines.at(-1)!.rateLimit();
    await until(async () => Boolean((await f.store.projection(id))?.resume));
    await f.sessions.setResumeCompact!(id, true);
    const before = (await f.store.projection(id))!;

    await f.sessions.resumeNow!(id);
    await until(async () => (f.engines.at(-1)?.requests.length ?? 0) > 0 && f.engines.length > 1);

    // The session's own model is out of quota: the small model goes first.
    assert.deepEqual(requests, [{ smallModelFirst: true }]);
    const events = await f.store.events(id);
    assert.ok(events.some((event) => event.type === "session/compaction-failed"));
    const compacted = events.findLast((event) => event.type === "session/compacted")!;
    assert.equal(compacted.data.source, "polyth");
    assert.notEqual((await f.store.projection(id))!.backendSessionId, before.backendSessionId);
    const request = f.engines.at(-1)!.requests.at(-1)!;
    assert.match(request.text, /SMALL-MODEL-SUMMARY/);
    assert.ok(request.text.endsWith("continue this work"));
    assert.equal((await f.store.projection(id))?.resume, undefined);
    f.engines.at(-1)!.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
});

test("a rate-limit resend retries the stopped turn ahead of messages queued behind it", async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "continue this work" });
    await f.sessions.send(id, { text: "follow-up", delivery: "queue" });
    f.engines.at(-1)!.rateLimit();
    await until(async () => Boolean((await f.store.projection(id))?.resume));
    assert.equal((await f.store.projection(id))?.status, "failed");
    assert.equal((await f.store.queueList(id)).length, 1);

    await f.sessions.resumeNow!(id);
    const engine = f.engines.at(-1)!;
    await until(async () => engine.requests.length === 2);
    assert.match(engine.requests[1]!.text, /continue this work$/);
    engine.complete();
    await until(async () => engine.requests.length === 3);
    assert.match(engine.requests[2]!.text, /follow-up$/);
    engine.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
});

test("each fresh harness leg receives current AGENTS.md once without changing visible chat", async () => {
  let policy = "Always preserve canonical history.";
  const reads: string[] = [];
  const f = fixture(":memory:", {
    workspaceInstructions: {
      async read(root, projectId) {
        reads.push(`${projectId}:${root}`);
        return policy;
      },
    },
    workspaceInstructionsEnabled: true,
  });
  const { id } = await f.sessions.create({ projectId: "p" });

  await f.sessions.send(id, { text: "A1" });
  assert.match(f.engines[0]!.requests[0]!.text, /Always preserve canonical history\./);
  assert.equal((await f.store.events(id)).find((event) => event.type === "user/message")!.data.text, "A1");
  f.engines[0]!.complete();
  await f.idle(id);

  await f.sessions.send(id, { text: "A2" });
  assert.equal(f.engines[0]!.requests[1]!.text, "A2");
  f.engines[0]!.complete();
  await f.idle(id);

  policy = "Use the policy revision read by the new harness.";
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  await f.sessions.send(id, { text: "B1" });
  const switchedPrompt = f.engines.at(-1)!.requests[0]!.text;
  assert.match(switchedPrompt, /Use the policy revision read by the new harness\./);
  assert.equal(
    (switchedPrompt.match(/<polyth-workspace-instructions path="AGENTS\.md">/g) ?? []).length,
    1,
  );
  const lastUser = (await f.store.events(id)).filter((event) => event.type === "user/message").at(-1)!;
  assert.equal(lastUser.data.text, "B1");
  assert.match((lastUser.data as { recoveryContext?: string }).recoveryContext ?? "", /Use the policy revision/);
  assert.deepEqual(reads, ["p:/same/worktree", "p:/same/worktree"]);
  f.engines.at(-1)!.complete();
  await f.idle(id);
  await f.close();
});

test("a submit-time harness intent switches once before admitting that message", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "first" });
  f.engines.at(-1)!.complete();
  await f.idle(id);

  await f.sessions.send(id, {
    text: "run on B",
    harness: { mode: "pinned", harnessId: "fake-b" },
  });

  assert.equal(f.engines.at(-1)!.harnessId, "fake-b");
  assert.equal(f.engines.at(-1)!.requests.at(-1)?.text.endsWith("run on B"), true);
  const events = await f.store.events(id);
  const switched = events.filter((event) => event.type === "harness/switched");
  assert.equal(switched.length, 1);
  assert.ok(switched[0]!.seq < events.findLast((event) => event.type === "user/message")!.seq);
  assert.equal((await f.store.projection(id))?.resolvedHarnessId, "fake-b");
  f.engines.at(-1)!.complete();
  await f.idle(id);
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

test("Auto-Approve remains authoritative across every registered harness and switching off restores prompts", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.autoAcceptSet!(id, "on");

  for (const harnessId of ["fake-a", "fake-b", "fake-c"]) {
    if ((await f.store.projection(id))?.resolvedHarnessId !== harnessId) {
      await f.sessions.switchHarness!(id, { mode: "pinned", harnessId });
    }
    const engine = f.engines.at(-1)!;
    const requestId = `permission-${harnessId}`;
    engine.requestPermission(requestId);
    await until(async () => engine.permissionReplies.some((reply) => reply.requestId === requestId));
    assert.deepEqual(engine.permissionReplies.at(-1), { requestId, reply: "once" });
    assert.equal((await f.store.projection(id))?.autoAccept, true);
  }

  await f.sessions.autoAcceptSet!(id, "off");
  const current = f.engines.at(-1)!;
  current.requestPermission("permission-manual");
  await until(async () => (await f.store.projection(id))?.status === "waiting");
  assert.equal(current.permissionReplies.some((reply) => reply.requestId === "permission-manual"), false);
  assert.deepEqual(await f.sessions.autoAcceptGet!(id), { setting: "off", effective: false, level: "off", inherited: "off" });
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

test("an idle requested switch releases its uncertain operation without replay", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { id } = await f.sessions.create({ projectId: "p" });
  const prepared = await f.store.prepareOperation({
    sessionId: id,
    mutationKind: "permission-reply",
    intentEvent: { type: "permission/reply-intended", data: { requestId: "lost-reply", reply: "reject" }, ignorable: true },
  });
  await f.store.claimOperation(prepared.operation.operationId);
  await f.store.settleOperation(prepared.operation.operationId, { kind: "unknown", message: "reply acknowledgement lost" });
  const result = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(result.resolvedHarnessId, "fake-b");
  assert.equal(result.harnessTransition, undefined);
  assert.equal((await f.store.operation(prepared.operation.operationId))?.state, "fenced");
  assert.deepEqual(f.engines[0]!.permissionReplies, []);
  assert.equal((await f.store.events(id)).filter(event => event.type === "mutation/claimed"
    && event.data.operationId === prepared.operation.operationId).length, 1);
  const events = await f.store.events(id);
  assert.ok(events.find(event => event.type === "harness/execution-released")!.seq
    < events.find(event => event.type === "runtime/epoch-replaced")!.seq);
});

for (const outcome of ["confirmed", "unknown", "mismatch", "missing"] as const) {
  test(`an epoch-pending requested switch requires ${outcome} durable release evidence`, async (t) => {
    const f = fixture();
    t.after(() => f.close());
    const { id } = await f.sessions.create({ projectId: "p" });
    const projection = (await f.store.projection(id))!;
    await f.store.upsertProjection({ ...projection, status: "epoch-pending" });
    const acquire = f.pool.forSession.bind(f.pool);
    f.pool.forSession = async (row, cwd, targetHarnessId) => {
      if ((targetHarnessId ?? row.resolvedHarnessId) === "fake-a") {
        throw Object.assign(new Error("old epoch cannot reattach"), { code: "epoch-pending" });
      }
      return acquire(row, cwd, targetHarnessId);
    };
    const releaseRequests: string[] = [];
    f.pool.releaseSessionExecution = async (_row, binding, operationId) => {
      releaseRequests.push(operationId);
      if (outcome === "missing") return undefined;
      return outcome === "unknown"
        ? { kind: "unknown", operationId, message: "containment not verified empty" }
        : { kind: "confirmed", value: {
          authorityId: binding.authorityId,
          generation: binding.generation + (outcome === "mismatch" ? 1 : 0),
          backendSessionId: binding.backendSessionId!,
        } };
    };
    if (outcome === "confirmed") {
      const result = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
      assert.equal(result.resolvedHarnessId, "fake-b");
      assert.equal(result.harnessTransition, undefined);
      assert.equal((await f.store.events(id)).filter(event => event.type === "harness/execution-released").length, 1);
    } else {
      await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }),
        { code: outcome === "unknown" ? "outcome-unknown" : outcome === "missing" ? "epoch-pending" : "stale-evidence" });
      assert.equal((await f.store.projection(id))?.harnessTransition?.phase, "requested");
      assert.equal((await f.store.events(id)).some(event => event.type === "harness/execution-released"), false);
      assert.equal(f.engines.some(engine => engine.harnessId === "fake-b"), false);
    }
    assert.equal(releaseRequests.length, 1);
  });
}

for (const shared of ["authority", "workspace route"] as const) {
  test(`epoch-pending switch does not release another session's ${shared}`, async (t) => {
    const f = fixture();
    t.after(() => f.close());
    const { id } = await f.sessions.create({ projectId: "p" });
    const neighbor = await f.sessions.create({ projectId: "p" });
    const projection = (await f.store.projection(id))!;
    if (shared === "authority") {
      const other = (await f.store.projection(neighbor.id))!;
      await f.store.upsertProjection({ ...other, resolvedHarnessId: "different-provider", runtimeBinding: {
        ...other.runtimeBinding!, authorityId: projection.runtimeBinding!.authorityId,
        generation: projection.runtimeBinding!.generation + 1,
      } });
    }
    await f.store.upsertProjection({ ...projection, status: "epoch-pending" });
    f.pool.forSession = async () => { throw Object.assign(new Error("old epoch cannot reattach"), { code: "epoch-pending" }); };
    let releases = 0;
    f.pool.releaseSessionExecution = async () => { releases++; throw new Error("another session still owns this scope"); };
    await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), { code: "epoch-pending" });
    assert.equal(releases, 0);
    assert.equal((await f.store.projection(id))?.harnessTransition?.phase, "requested");
    assert.equal(f.engines.some(engine => engine.harnessId === "fake-b"), false);
  });
}

for (const state of ["prepared", "executing"] as const) {
  test(`an idle requested switch retains its ${state} mutation barrier`, async (t) => {
    const f = fixture();
    t.after(() => f.close());
    const { id } = await f.sessions.create({ projectId: "p" });
    const prepared = await f.store.prepareOperation({
      sessionId: id, mutationKind: "permission-reply",
      intentEvent: { type: "permission/reply-intended", data: { requestId: "reply", reply: "reject" }, ignorable: true },
    });
    if (state === "executing") await f.store.claimOperation(prepared.operation.operationId);
    await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), { code: "outcome-unknown" });
    assert.equal((await f.store.operation(prepared.operation.operationId))?.state, state);
    assert.equal(f.engines.some(engine => engine.harnessId === "fake-b"), false);
    assert.deepEqual(f.engines[0]!.permissionReplies, []);
  });
}

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

test("a rejected target create keeps reporting its reason and recovers once the target accepts", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  f.setCreateRejected(true);
  const count = f.nativeCreates.length;
  const reason = { code: "native-failure", message: "target bridge failed to connect" };
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), reason);
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), reason);
  assert.equal(f.nativeCreates.length, count);
  f.setCreateRejected(false);
  assert.equal((await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" })).resolvedHarnessId, "fake-b");
  await f.close();
});

test("a failed switch retargets cleanly when launch options change", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  f.setCreateRejected(true);
  const reason = { code: "native-failure", message: "target bridge failed to connect" };
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now", {
    model: { providerID: "fake-b", modelID: "m1" },
  }), reason);
  const failed = (await f.store.projection(id))!;
  assert.equal(failed.harnessTransition?.phase, "failed");

  f.setCreateRejected(false);
  // User changes launch options (e.g. effort/model) on retry
  const recovered = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now", {
    model: { providerID: "fake-b", modelID: "m1", variant: "high" },
  });
  assert.equal(recovered.harnessTransition, undefined);
  assert.equal(recovered.resolvedHarnessId, "fake-b");
  assert.equal(recovered.model?.variant, "high");
  assert.equal((await f.store.events(id)).filter((e) => e.type === "harness/switch-retargeted").length, 1);
  await f.close();
});

test("sending a turn with new model options retries a failed harness switch", async () => {
  const f = fixture(); const { id } = await f.sessions.create({ projectId: "p" });
  f.setCreateRejected(true);
  const reason = { code: "native-failure", message: "target bridge failed to connect" };
  await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }, "stop-now", {
    model: { providerID: "fake-b", modelID: "m1" },
  }), reason);
  const failed = (await f.store.projection(id))!;
  assert.equal(failed.harnessTransition?.phase, "failed");

  f.setCreateRejected(false);
  // User sends prompt with updated model in composer
  await f.sessions.send(id, {
    text: "Retry with high effort",
    harness: { mode: "pinned", harnessId: "fake-b" },
    model: { providerID: "fake-b", modelID: "m1", variant: "high" },
  });
  const proj = (await f.store.projection(id))!;
  assert.equal(proj.harnessTransition, undefined);
  assert.equal(proj.resolvedHarnessId, "fake-b");
  assert.equal(proj.model?.variant, "high");
  await f.close();
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

test("resumed job restores Auto-Approve and drains a permission missed while disconnected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-permission-restart-"));
  const f = fixture(join(dir, "events.db"));
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.autoAcceptSet!(id, "on");
  await f.restart();

  const resumedEngine = f.engines[0]!;
  resumedEngine.requestPermission("permission-during-disconnect");
  f.broadcasts.length = 0;
  await f.sessions.send(id, { text: "resume" });
  await until(async () => resumedEngine.permissionReplies.some(
    (reply) => reply.requestId === "permission-during-disconnect",
  ));

  assert.deepEqual(await f.sessions.autoAcceptGet!(id), { setting: "on", effective: true, level: "routine", inherited: "off" });
  assert.equal(f.broadcasts.includes("permission/requested"), false);
  assert.ok((await f.store.events(id)).some((event) =>
    event.type === "permission/resolved"
    && (event.data as { requestId?: string; auto?: boolean }).requestId === "permission-during-disconnect"
    && (event.data as { auto?: boolean }).auto === true));
  resumedEngine.complete();
  await f.idle(id);
  await f.close();
  await rm(dir, { recursive: true, force: true });
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

test("a same-harness refresh on a replaced shared runtime recovers a fresh epoch instead of failing every send", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-epoch-shared-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "A1" }); f.engines.at(-1)!.complete();
  await f.idle(id);
  // A neighbour on the same harness and workspace route: the old runtime
  // cannot be released for this session alone.
  await f.sessions.create({ projectId: "p" });
  const original = (await f.store.projection(id))!;
  // The owned runtime this session was bound to has been replaced.
  await f.store.upsertProjection({ ...original, runtimeBinding: { ...original.runtimeBinding!, authorityId: randomUUID() } });
  // Canonical dialogue the native leg never saw asks for a same-harness refresh.
  await f.store.append(id, "assistant/message", { partId: "canonical-only", text: "Additional confirmed canonical outcome" });
  await f.restart();
  let releases = 0;
  f.pool.releaseSessionExecution = async () => { releases++; throw new Error("another session still owns this scope"); };

  await f.sessions.send(id, { text: "Continue" });

  const recovered = (await f.store.projection(id))!;
  assert.equal(recovered.harnessTransition, undefined);
  assert.equal(recovered.resolvedHarnessId, "fake-a");
  assert.notEqual(recovered.backendSessionId, original.backendSessionId);
  assert.equal(releases, 0);
  const events = await f.store.events(id);
  assert.equal(events.findLast((event) => event.type === "harness/switch-cancelled")?.data.reason, "replaced-by-runtime-epoch-recovery");
  assert.ok(events.some((event) => event.type === "runtime/epoch-replaced"));
  const engine = f.engines.find((candidate) => candidate.requests.some((request) => request.text.includes("Continue")))!;
  assert.match(engine.requests.at(-1)!.text, /Additional confirmed canonical outcome/);
  engine.complete();
  await f.idle(id);
});

test("compacting a session whose owned runtime was replaced recovers a fresh epoch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-epoch-compact-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "A1" }); f.engines.at(-1)!.complete();
  await f.idle(id);
  const original = (await f.store.projection(id))!;
  await f.store.upsertProjection({ ...original, runtimeBinding: { ...original.runtimeBinding!, authorityId: randomUUID() } });
  await f.restart();

  await f.sessions.compact!(id);

  const recovered = (await f.store.projection(id))!;
  assert.equal(recovered.status, "idle");
  assert.notEqual(recovered.backendSessionId, original.backendSessionId);
  assert.ok((await f.store.events(id)).some((event) => event.type === "runtime/epoch-replaced"));
  // A second compaction meets an ordinary idle session, not a pending epoch.
  await assert.rejects(f.sessions.compact!(id), { code: "unsupported" });
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

test("legacy authority-only release resumes after an idle session open advanced its generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-legacy-release-"));
  const f = fixture(join(dir, "events.db"));
  const { id } = await f.sessions.create({ projectId: "p" });
  const originalTransition = f.store.transitionRuntimeEpoch;
  f.store.transitionRuntimeEpoch = async () => {
    throw Object.assign(new Error("simulated old publication failure"), { code: "epoch-proof-required" });
  };
  await assert.rejects(
    f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }),
    { code: "epoch-proof-required" },
  );

  const failed = (await f.store.projection(id))!;
  assert.equal(failed.harnessTransition?.phase, "failed");
  const released = failed.harnessTransition!.released;
  const { backendSessionId: _legacyMissingField, ...legacyAuthorityProof } = released;
  await f.store.upsertProjection({
    ...failed,
    status: "epoch-pending",
    runtimeBinding: {
      ...failed.runtimeBinding!,
      generation: released.generation + 1,
    },
    harnessTransition: {
      ...failed.harnessTransition!,
      released: legacyAuthorityProof,
    } as unknown as NonNullable<typeof failed.harnessTransition>,
  });
  await f.store.append(id, "harness/execution-released", {
    transitionId: failed.harnessTransition!.id,
    ...legacyAuthorityProof,
  }, { ignorable: true });
  f.store.transitionRuntimeEpoch = originalTransition;
  await f.restart();

  const enginesBeforeOpen = f.engines.length;
  await f.sessions.events(id, 0);
  assert.equal(
    f.engines.length,
    enginesBeforeOpen,
    "opening a released transition must not reattach its source runtime",
  );

  const interruptedTransition = f.store.transitionRuntimeEpoch;
  f.store.transitionRuntimeEpoch = async () => {
    throw new Error("simulated crash after legacy proof upgrade");
  };
  await assert.rejects(
    f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }),
    /simulated crash after legacy proof upgrade/,
  );
  const upgraded = (await f.store.projection(id))!;
  assert.equal(upgraded.harnessTransition?.released.backendSessionId, released.backendSessionId);
  assert.equal(upgraded.runtimeBinding?.generation, released.generation);
  f.store.transitionRuntimeEpoch = interruptedTransition;
  await f.restart();

  const result = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  assert.equal(result.resolvedHarnessId, "fake-b");
  assert.equal(result.harnessTransition, undefined);
  assert.equal(f.nativeCreates.length, 2, "the confirmed target create must not be replayed");
  assert.ok((await f.store.events(id)).some((event) =>
    event.type === "harness/execution-released"
    && event.data.recoveredLegacyProof === true
    && event.data.backendSessionId === released.backendSessionId));
  await f.close();
  await rm(dir, { recursive: true, force: true });
});

test("a missing session id without canonical legacy release evidence stays blocked", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  const originalTransition = f.store.transitionRuntimeEpoch;
  f.store.transitionRuntimeEpoch = async () => {
    throw new Error("simulated publication failure");
  };
  await assert.rejects(
    f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }),
    /simulated publication failure/,
  );

  const failed = (await f.store.projection(id))!;
  const released = failed.harnessTransition!.released;
  const { backendSessionId: _missingWithoutEvidence, ...malformedRelease } = released;
  await f.store.upsertProjection({
    ...failed,
    harnessTransition: {
      ...failed.harnessTransition!,
      released: malformedRelease,
    } as unknown as NonNullable<typeof failed.harnessTransition>,
  });
  f.store.transitionRuntimeEpoch = originalTransition;

  const creates = f.nativeCreates.length;
  await assert.rejects(
    f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }),
    { code: "stale-evidence" },
  );
  assert.equal(f.nativeCreates.length, creates);
  await f.close();
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

for (const status of ["unknown", "idle"] as const) test(`a new prompt recovers a stopped turn with an unknown permission reply from ${status} without replaying it`, async () => {
  const f = fixture();
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "Keep the confirmed task history" });
    f.engines[0]!.complete();
    await f.idle(id);
    const previous = (await f.store.projection(id))!;
    const uncertain = await f.store.prepareOperation({
      sessionId: id,
      mutationKind: "permission-reply",
      intentEvent: {
        type: "permission/response-intended",
        data: { requestId: "lost-permission", reply: "once" },
        ignorable: true,
      },
    });
    await f.store.claimOperation(uncertain.operation.operationId);
    await f.store.settleOperation(uncertain.operation.operationId, {
      kind: "unknown", message: "permission acknowledgement was lost",
    });
    await f.store.upsertProjection({ ...previous, status });

    const result = await f.sessions.send(id, { text: "Continue with a project picker" });
    assert.equal(result.queued, undefined);
    assert.equal(f.nativeResets.length, 1);
    assert.notEqual((await f.store.projection(id))!.backendSessionId, previous.backendSessionId);
    assert.equal((await f.store.operation(uncertain.operation.operationId))!.state, "unknown");
    assert.equal((await f.store.projection(id))!.runtimeBinding!.epoch, 1);
    assert.deepEqual(f.engines[0]!.permissionReplies, []);
    const request = f.engines[0]!.requests.at(-1)!;
    assert.match(request.text, /Keep the confirmed task history/);
    assert.match(request.text, /confirmed answer from fake-a/);
    assert.match(request.text, /Continue with a project picker/);
    assert.equal((await f.store.events(id)).filter((event) => event.type === "user/message").length, 2);
    f.engines[0]!.complete();
    await f.idle(id);
    const binding = (await f.store.projection(id))!.runtimeBinding!;
    await f.sessions.reconcileForRuntimeRestart!(id, f.engines[0]!, {
      authorityId: binding.authorityId,
      generation: binding.generation,
    });
    assert.notEqual((await f.store.reconciliation(id))!.state, "blocked", "a retired reply must not block the recovered epoch");
    assert.equal((await f.store.projection(id))!.status, "idle");
    assert.equal((await f.store.operation(uncertain.operation.operationId))!.state, "unknown");
    const next = await f.sessions.send(id, { text: "Use the recovered context" });
    assert.equal(next.queued, undefined);
    assert.equal(f.nativeResets.length, 1);
    assert.deepEqual(f.engines[0]!.permissionReplies, []);
    f.engines[0]!.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
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

test("runtime status after an archive never un-archives the session; restore does", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "archive me mid-turn" });
  await f.sessions.archive(id);
  assert.equal((await f.store.projection(id))!.status, "archived");
  // The turn keeps landing in the log and stops afterwards; its idle status
  // must not overwrite the user's archive.
  f.engines[0]!.complete();
  const deadline = Date.now() + 5_000;
  while (!(await f.store.events(id)).some((event) => event.type === "turn/stopped")) {
    assert.ok(Date.now() < deadline, "turn never stopped");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await f.store.projection(id))!.status, "archived");
  await f.sessions.restore(id);
  assert.equal((await f.store.projection(id))!.status, "idle");
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

const countEvents = async (f: ReturnType<typeof fixture>, id: string, type: string) =>
  (await f.store.events(id)).filter((event) => event.type === type).length;

test("restarting the current harness replaces its native leg through proven release", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "A1" });
  f.engines[0]!.complete();
  await f.idle(id);
  const before = (await f.store.projection(id))!;
  const creates = f.nativeCreates.length;
  const restarted = await f.sessions.restartRuntime!(id);
  assert.equal(restarted.resolvedHarnessId, "fake-a");
  assert.equal(restarted.harnessTransition, undefined);
  assert.notEqual(restarted.backendSessionId, before.backendSessionId);
  assert.equal(f.nativeCreates.length, creates + 1);
  const events = await f.store.events(id);
  const released = events.find((event) => event.type === "harness/execution-released")!;
  assert.equal(released.data.backendSessionId, before.backendSessionId);
  assert.ok(released.seq < events.findLast((event) => event.type === "runtime/epoch-replaced")!.seq);
  assert.equal(events.find((event) => event.type === "harness/switch-requested")?.data.reason, "runtime-restart");
  await f.sessions.send(id, { text: "A2" });
  assert.equal(f.engines.at(-1)!.requests.at(-1)?.text.includes("A2"), true);
  f.engines.at(-1)!.complete();
  await f.idle(id);
});

test("restart without release proof replaces nothing and withdraws its intent", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "still running" });
  const before = (await f.store.projection(id))!;
  const creates = f.nativeCreates.length;
  // Abort acknowledgement alone does not stop this engine: no release proof.
  await assert.rejects(f.sessions.restartRuntime!(id), { code: "outcome-unknown" });
  f.setReleaseUnknown(true);
  await assert.rejects(f.sessions.restartRuntime!(id), { code: "outcome-unknown" });
  const after = (await f.store.projection(id))!;
  assert.equal(after.harnessTransition, undefined);
  assert.equal(after.backendSessionId, before.backendSessionId);
  assert.equal(after.runtimeBinding?.generation, before.runtimeBinding?.generation);
  assert.equal(f.nativeCreates.length, creates);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 0);
  assert.equal(await countEvents(f, id, "harness/native-create-requested"), 0);
  assert.equal(await countEvents(f, id, "runtime/epoch-replaced"), 0);
  assert.equal((await f.store.events(id)).filter((event) => event.type === "harness/switch-cancelled"
    && event.data.reason === "runtime-restart-unproven").length, 2);
});

test("a repeated restart resumes its exact create receipt and never replays it", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { id } = await f.sessions.create({ projectId: "p" });
  const before = (await f.store.projection(id))!;
  f.setCreateUnknown(true, false);
  await assert.rejects(f.sessions.restartRuntime!(id), { code: "outcome-unknown" });
  const creates = f.nativeCreates.length;
  assert.equal((await f.store.projection(id))?.harnessTransition?.phase, "failed");
  await assert.rejects(f.sessions.restartRuntime!(id), { code: "outcome-unknown" });
  assert.equal(f.nativeCreates.length, creates, "an uncertain create is never replayed");
  assert.equal(await countEvents(f, id, "harness/switch-requested"), 1, "a pending restart is continued, not doubled");
  f.setCreateUnknown(false, true);
  const recovered = await f.sessions.restartRuntime!(id);
  assert.equal(recovered.harnessTransition, undefined);
  assert.notEqual(recovered.backendSessionId, before.backendSessionId);
  assert.equal(f.nativeCreates.length, creates);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 1);
});

/** A turn cut by a Polyth restart whose runtime transport no longer answers:
 * in-place reconciliation and the in-place reset cannot recover it. */
async function stuckUnknownSession(f: ReturnType<typeof fixture>) {
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "cut by restart" });
  await f.restart();
  const engine = f.engines[0]!;
  engine.reconcile = async () => { throw Object.assign(new Error("transport unresponsive"), { code: "transport" }); };
  let resets = 0;
  const reset = engine.resetSessionOperation!.bind(engine);
  engine.resetSessionOperation = async (request, operationId) => {
    // The in-place reset goes through the same dead transport.
    if (resets++ === 0) return { kind: "rejected" as const, code: "transport", message: "runtime transport is unresponsive" };
    return reset(request, operationId);
  };
  const projection = (await f.store.projection(id))!;
  await f.store.upsertProjection({ ...projection, status: "unknown" });
  return { id, before: projection };
}

test("a send to a stuck unknown session restarts its harness once release is proven", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-restart-send-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id, before } = await stuckUnknownSession(f);
  f.setAbortStops(true);
  const result = await f.sessions.send(id, { text: "continue please" });
  assert.equal(result.queued ?? false, false);
  const after = (await f.store.projection(id))!;
  assert.equal(after.resolvedHarnessId, "fake-a");
  assert.equal(after.harnessTransition, undefined);
  assert.notEqual(after.backendSessionId, before.backendSessionId);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 1);
  assert.equal((await f.store.events(id)).find((event) => event.type === "harness/switch-requested")?.data.source, "send-recovery");
  assert.equal(f.engines.at(-1)!.requests.at(-1)?.text.includes("continue please"), true);
  f.engines.at(-1)!.complete();
  await f.idle(id);
});

test("a send to a stuck unknown session without release proof queues and replaces nothing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-restart-send-unproven-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id, before } = await stuckUnknownSession(f);
  const creates = f.nativeCreates.length;
  const first = await f.sessions.send(id, { text: "first nudge" });
  assert.equal(first.queued, true);
  // Each send may try again; without proof it keeps the message waiting or
  // reports the undispatchable state, never a replacement.
  const second = await f.sessions.send(id, { text: "second nudge" })
    .catch((error: { code?: string }) => ({ code: error.code }));
  assert.ok(("queued" in second && second.queued) || ("code" in second && second.code === "session-not-idle"), JSON.stringify(second));
  assert.ok(await countEvents(f, id, "harness/switch-requested") >= 1, "the restart was attempted");
  const after = (await f.store.projection(id))!;
  assert.equal(after.harnessTransition, undefined);
  assert.equal(after.backendSessionId, before.backendSessionId);
  assert.equal(f.nativeCreates.length, creates);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 0);
  assert.equal(await countEvents(f, id, "harness/native-create-requested"), 0);
  assert.equal(f.engines.every((engine) => !engine.requests.some((request) => request.text.includes("nudge"))), true);
  assert.ok((await f.store.queueList(id)).some((item) => item.text === "first nudge"));
});

test("automatic resumes never trigger a runtime restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-restart-autoresume-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id } = await stuckUnknownSession(f);
  f.setAbortStops(true);
  await f.sessions.send(id, { text: "resume", autoResume: true }).catch(() => undefined);
  assert.equal(await countEvents(f, id, "harness/switch-requested"), 0);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 0);
});

test("after a proven restart the stuck queue drains in order before the new message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-restart-drain-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id, before } = await stuckUnknownSession(f);
  assert.equal((await f.sessions.send(id, { text: "waiting one" })).queued, true);
  f.setAbortStops(true);
  await f.sessions.send(id, { text: "waiting two" });
  await until(async () => f.engines.at(-1)!.requests.some((request) => request.text.includes("waiting one")));
  const after = (await f.store.projection(id))!;
  assert.notEqual(after.backendSessionId, before.backendSessionId);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 1);
  const engine = f.engines.at(-1)!;
  engine.complete();
  await until(async () => engine.requests.some((request) => request.text.includes("waiting two")));
  const order = engine.requests.map((request) => request.text.includes("waiting one") ? 1 : request.text.includes("waiting two") ? 2 : 0).filter(Boolean);
  assert.deepEqual(order, [1, 2]);
  engine.complete();
  await f.idle(id);
});

/** The live report: a provider failure left the session `failed` with queued
 * messages; the dispatcher only drains `idle`, so nothing moved. */
async function failedWithQueue(f: ReturnType<typeof fixture>) {
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "A1" });
  f.engines[0]!.complete();
  await f.idle(id);
  const projection = (await f.store.projection(id))!;
  await f.store.upsertProjection({ ...projection, status: "failed" });
  await f.store.enqueue(id, "stuck in queue", "queue");
  return { id, before: projection };
}

test("a send to a failed session with a stuck queue restarts its harness and drains in order", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { id, before } = await failedWithQueue(f);
  const result = await f.sessions.send(id, { text: "after restart" });
  assert.equal(result.queued, true, "the new message waits behind the stuck one");
  const engine = f.engines.at(-1)!;
  await until(async () => engine.requests.some((request) => request.text.includes("stuck in queue")));
  assert.notEqual((await f.store.projection(id))!.backendSessionId, before.backendSessionId);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 1);
  engine.complete();
  await until(async () => engine.requests.some((request) => request.text.includes("after restart")));
  engine.complete();
  await f.idle(id);
});

test("a failed session with a stuck queue is not replaced without release proof", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { id, before } = await failedWithQueue(f);
  f.setReleaseUnknown(true);
  await assert.rejects(f.sessions.send(id, { text: "after restart" }), { code: "session-not-idle" });
  const after = (await f.store.projection(id))!;
  assert.equal(after.backendSessionId, before.backendSessionId);
  assert.equal(after.harnessTransition, undefined);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 0);
  assert.equal(await countEvents(f, id, "harness/native-create-requested"), 0);
  assert.equal(f.engines.every((engine) => !engine.requests.some((request) => request.text.includes("stuck in queue"))), true);
});

test("a stale owned runtimeControl does not restart a runtime whose live endpoint is borrowed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "harness-restart-borrowed-"));
  const f = fixture(join(dir, "events.db"));
  t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }); });
  const { id } = await stuckUnknownSession(f);
  const engine = f.engines[0]!;
  const live = await engine.endpoint!();
  engine.endpoint = async () => ({ ...live, control: { kind: "borrowed" as const } }) as never;
  await f.store.upsertProjection({ ...(await f.store.projection(id))!, runtimeControl: "owned" });
  f.setAbortStops(true);
  await f.sessions.send(id, { text: "borrowed nudge" }).catch(() => undefined);
  assert.equal(await countEvents(f, id, "harness/switch-requested"), 0);
  assert.equal(await countEvents(f, id, "harness/execution-released"), 0);
});

test("a runtime without native compaction compacts through a summary and a fresh leg", async () => {
  const prompts: string[] = [];
  const summaryRuntimes: unknown[] = [];
  const f = fixture(":memory:", {
    compactionSummary: async ({ prompt, systemPrompt, maxOutputTokens, runtime }) => {
      summaryRuntimes.push(runtime);
      assert.match(systemPrompt, /compact a conversation/);
      assert.ok(maxOutputTokens > 0);
      prompts.push(prompt(40_000));
      return "```markdown\n## Goal\nSUMMARY-OF-EARLIER-WORK\n```";
    },
  });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    for (const text of ["first request", "second request"]) {
      await f.sessions.send(id, { text });
      f.engines.at(-1)!.complete();
      await f.idle(id);
    }
    const before = (await f.store.projection(id))!;
    await f.sessions.compact!(id);
    await until(async () => (await f.store.events(id)).some((event) => event.type === "session/compacted"));

    // The session's own runtime: a session-bound harness has no other.
    assert.ok(summaryRuntimes[0]);
    assert.equal(summaryRuntimes[0], f.engines.at(-2));
    assert.match(prompts[0]!, /User: first request/);
    assert.match(prompts[0]!, /Assistant: confirmed answer from fake-a/);
    const after = (await f.store.projection(id))!;
    assert.notEqual(after.backendSessionId, before.backendSessionId);
    assert.equal(after.resolvedHarnessId, before.resolvedHarnessId);
    assert.equal(after.harnessTransition, undefined);
    const events = await f.store.events(id);
    const marker = events.findLast((event) => event.type === "runtime/epoch-replaced")!;
    const compacted = events.findLast((event) => event.type === "session/compacted")!;
    assert.ok(events.some((event) => event.type === "session/compaction-requested"));
    assert.equal(compacted.data.source, "polyth");
    assert.equal(compacted.data.summary, "## Goal\nSUMMARY-OF-EARLIER-WORK");
    assert.equal(compacted.data.epochMarkerSeq, marker.seq);
    assert.ok(!events.some((event) => event.type === "session/compaction-failed"));

    await f.sessions.send(id, { text: "carry on" });
    await until(async () => (f.engines.at(-1)?.requests.length ?? 0) > 0);
    const request = f.engines.at(-1)!.requests.at(-1)!;
    assert.match(request.text, /SUMMARY-OF-EARLIER-WORK/);
    assert.match(request.text, /The conversation was compacted to free context\./);
    assert.ok(request.text.endsWith("carry on"));
    f.engines.at(-1)!.complete();
    await f.idle(id);
  } finally {
    await f.close();
  }
});

test("a failed compaction summary leaves the native context in place", async () => {
  const f = fixture(":memory:", {
    compactionSummary: async () => { throw Object.assign(new Error("provider rate limit reached"), { code: "rate-limited" }); },
  });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "some work" });
    f.engines.at(-1)!.complete();
    await f.idle(id);
    const before = (await f.store.projection(id))!;
    // Answered once under way: the outcome is on the timeline.
    await f.sessions.compact!(id);
    await until(async () => (await f.store.events(id)).some((event) => event.type === "session/compaction-failed"));
    const events = await f.store.events(id);
    assert.equal(events.findLast((event) => event.type === "session/compaction-failed")?.data.error, "provider rate limit reached");
    assert.ok(!events.some((event) => event.type === "session/compacted"));
    assert.ok(!events.some((event) => event.type === "runtime/epoch-replaced"));
    assert.equal((await f.store.projection(id))?.backendSessionId, before.backendSessionId);
    assert.equal(f.nativeResets.length, 0);
  } finally {
    await f.close();
  }
});

test("Polyth compaction refuses an empty conversation and a host without a summarizer", async () => {
  const withSummary = fixture(":memory:", { compactionSummary: async () => "unused" });
  try {
    const { id } = await withSummary.sessions.create({ projectId: "p" });
    await assert.rejects(withSummary.sessions.compact!(id), /no native context to compact/);
    assert.ok(!(await withSummary.store.events(id)).some((event) => event.type === "session/compaction-requested"));
  } finally {
    await withSummary.close();
  }
  const without = fixture();
  try {
    const { id } = await without.sessions.create({ projectId: "p" });
    await without.sessions.send(id, { text: "work" });
    without.engines.at(-1)!.complete();
    await without.idle(id);
    await assert.rejects(without.sessions.compact!(id), /runtime does not support compaction/);
  } finally {
    await without.close();
  }
});

test("a message sent while Polyth compacts queues for the fresh leg", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(":memory:", {
    compactionSummary: async () => { await gate; return "## Goal\nGATED-SUMMARY"; },
  });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    await f.sessions.send(id, { text: "before" });
    f.engines.at(-1)!.complete();
    await f.idle(id);
    const before = (await f.store.projection(id))!;
    await f.sessions.compact!(id);
    await until(async () => (await f.sessions.runtimeFeatures!(id)).contextWindow?.compaction?.active === true);
    await assert.rejects(f.sessions.compact!(id), /already being compacted/);

    const sent = await f.sessions.send(id, { text: "during compaction" });
    assert.equal(sent.queued, true);
    release();
    await until(async () => (f.engines.at(-1)?.requests.some((request) => request.text.endsWith("during compaction")) ?? false));
    const request = f.engines.at(-1)!.requests.at(-1)!;
    assert.match(request.text, /GATED-SUMMARY/);
    assert.notEqual((await f.store.projection(id))?.backendSessionId, before.backendSessionId);
    const events = await f.store.events(id);
    const compacted = events.findLast((event) => event.type === "session/compacted")!;
    const admitted = events.findLast((event) => event.type === "user/message")!;
    assert.ok(admitted.seq > compacted.seq, "the queued message runs after the compaction");
    assert.equal(events.find((event) => event.type === "delivery/fallback-queued")?.data.reason, "compaction");
    f.engines.at(-1)!.complete();
    await f.idle(id);
  } finally {
    release();
    await f.close();
  }
});

test("a conversation started on a harness with private sessions on stays private on every leg and cannot move to a harness that would save it", async () => {
  const f = fixture(":memory:", { privateSessions: { supported: ["fake-a", "fake-c"], preferences: { "fake-a": { privateSessions: true } } } });
  try {
    const { id } = await f.sessions.create({ projectId: "p" });
    assert.equal((await f.store.projection(id))?.privateSession, true);
    assert.deepEqual(f.launches.at(-1), { harnessId: "fake-a", privateSession: true });
    await f.sessions.send(id, { text: "A1" }); f.engines.at(-1)!.complete();
    await f.idle(id);

    // The preference goes off; the conversation that started private stays so.
    f.setPrivatePreferences({});
    const moved = await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-c" });
    assert.equal(moved.resolvedHarnessId, "fake-c");
    assert.equal(moved.privateSession, true);
    assert.deepEqual(f.launches.at(-1), { harnessId: "fake-c", privateSession: true });

    const launchesBefore = f.launches.length;
    await assert.rejects(f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" }), (error: Error & { code?: string }) =>
      error.code === "unsupported" && /can't run a private session/.test(error.message));
    const after = (await f.store.projection(id))!;
    assert.equal(after.resolvedHarnessId, "fake-c", "the refused switch never released the private leg");
    assert.equal(after.harnessTransition, undefined);
    assert.equal(f.launches.length, launchesBefore, "no runtime was started on the harness that would save it");
  } finally {
    await f.close();
  }
});

test("private sessions apply to new conversations only and never to a harness without support", async () => {
  const f = fixture(":memory:", { privateSessions: { supported: ["fake-a"], preferences: {} } });
  try {
    const { id: before } = await f.sessions.create({ projectId: "p" });
    f.setPrivatePreferences({ "fake-a": { privateSessions: true }, "fake-b": { privateSessions: true } });
    // An existing conversation keeps how it started, on every later leg.
    const moved = await f.sessions.switchHarness!(before, { mode: "pinned", harnessId: "fake-b" });
    assert.equal(moved.privateSession, undefined);
    assert.deepEqual(f.launches.at(-1), { harnessId: "fake-b", privateSession: false });

    const { id: pinned } = await f.sessions.create({ projectId: "p", harness: { mode: "pinned", harnessId: "fake-b" } });
    assert.equal((await f.store.projection(pinned))?.privateSession, undefined, "fake-b cannot honour it");

    const { id: fresh } = await f.sessions.create({ projectId: "p" });
    assert.equal((await f.store.projection(fresh))?.privateSession, true);
  } finally {
    await f.close();
  }
});
