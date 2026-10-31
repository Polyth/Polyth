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
import { createSessionService } from "../../server/src/sessions.ts";
import { importSnapshot } from "../src/index.ts";
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
  const nativeBranches: string[] = [];
  const createRequests: Array<{ model?: ModelRef; agent?: string }> = [];
  const broadcasts: string[] = [];
  const provider = (id: string): HarnessProvider => ({
    descriptor: { id, name: id, integration: "fake", priority: id === "fake-a" ? 0 : 1 },
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    async createRuntime(context: HarnessContext) {
      await options.runtimeGate;
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
  });
  let sessions = makeSessions();
  const drain = () => new Promise((resolve) => setTimeout(resolve, 40));
  return { get store() { return store; }, get sessions() { return sessions; }, pool, engines, nativeCreates, nativeResets, nativeBranches, createRequests, broadcasts, beginShutdown,
    async idle(id: string) { await until(async () => { const events = await store.events(id); return (await store.projection(id))?.status === "idle" && (events.findLast(e => e.type === "turn/stopped")?.seq ?? 0) > (events.findLast(e => e.type === "user/message")?.seq ?? 0); }); },
    async close() { await drain(); detach.forEach((off) => off()); await store.close(); },
    async restart() { await drain(); detach.forEach((off) => off()); await store.close(); store = createStore(path); sessions = makeSessions(); }, setReleaseUnknown(value: boolean) { releaseUnknown = value; }, setCreateUnknown(value: boolean, receipt = true) { createUnknown = value; exposeReceipt = receipt; }, setCreateRejected(value: boolean) { createRejected = value; }, setAbortStops(value: boolean) { abortStops = value; } };
}


test("Snapshot continues through a fresh harness after its external source disappears", async () => {
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
