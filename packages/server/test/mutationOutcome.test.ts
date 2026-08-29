import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  JsonObject,
  MutationOutcome,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeSessionBinding,
  RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Listener = (sessionId: string, event: RuntimeEvent) => void;

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
};

const harness = (runtime: AgentRuntime) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-mutation-outcome-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = {
    id: "project-1",
    name: "Project",
    path: dir,
    createdAt: 1,
  };
  const endpoint: RuntimeEndpoint = {
    authorityId: `test:${dir}`,
    continuity: "verified",
    generation: 1,
    url: "http://runtime.invalid",
    location: { directory: dir },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  runtime.endpoint ??= async () => endpoint;
  runtime.reconcile ??= async (
    binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
  ): Promise<RuntimeSnapshot> => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: {
      value: "idle",
      watermark: "1",
      comparison: { domain: "test-status", order: 1 },
    },
    completeness: {
      events: "partial",
      permissions: "partial",
      questions: "partial",
    },
    permissions: [],
    questions: [],
    events: [],
  });
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  };
  const permissions = {
    evaluate: () => "ask",
    addRule: () => undefined,
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = {
    event: () => undefined,
    projection: () => undefined,
  };
  return {
    dir,
    project,
    projects,
    permissions,
    broadcast,
    store,
    sessions: createSessionService({
      store,
      projects,
      permissions,
      broadcast,
      queue: store,
      runtimes: { forProject: async () => runtime },
    }),
  };
};

test("lost prompt response records one durable unknown and never redispatches", async () => {
  const listeners = new Set<Listener>();
  let submissions = 0;
  const runtime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input: { sessionId: string; backendSessionId?: string }) =>
      input.backendSessionId ?? `backend-${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => undefined,
    startTurnOperation: async (_request: unknown, operationId: string) => {
      submissions += 1;
      return {
        kind: "unknown",
        operationId,
        message: "request accepted but response was lost",
      } satisfies MutationOutcome<Record<string, never>>;
    },
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    onEvent(callback: Listener) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => undefined,
  } as unknown as AgentRuntime;
  const { sessions, store } = harness(runtime);
  const created = await sessions.create({ projectId: "project-1", title: "Unknown prompt" });

  await assert.rejects(
    () => sessions.send(created.id, { text: "run once" }),
    (error: Error & { code?: string }) => error.code === "outcome-unknown",
  );
  await waitFor(async () => (await store.projection(created.id))?.status === "unknown");

  assert.equal(submissions, 1);
  const operations = (await store.operations(created.id))
    .filter((operation) => operation.mutationKind === "turn-submit");
  assert.equal(operations.length, 1);
  assert.equal(operations[0]!.state, "unknown");
  const events = await store.events(created.id);
  assert.equal(events.filter((event) => event.type === "user/message").length, 1);
  assert.equal(events.filter((event) => event.type === "mutation/prepared"
    && (event.data as { operationId?: string }).operationId === operations[0]!.operationId).length, 1);
  assert.equal(events.filter((event) => event.type === "mutation/claimed"
    && (event.data as { operationId?: string }).operationId === operations[0]!.operationId).length, 1);
  assert.equal(events.filter((event) => event.type === "mutation/uncertainty-recorded"
    && (event.data as { operationId?: string }).operationId === operations[0]!.operationId).length, 1);

  await assert.rejects(
    () => sessions.send(created.id, { text: "run once" }),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  assert.equal(submissions, 1);
  await waitFor(async () => (await store.reconciliation(created.id))?.state === "blocked");
  await store.close();
});

test("unknown queue admission retains and blocks the FIFO reservation", async () => {
  const listeners = new Set<Listener>();
  let submissions = 0;
  const emit = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input: { sessionId: string; backendSessionId?: string }) =>
      input.backendSessionId ?? `backend-${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => undefined,
    startTurnOperation: async (request: { sessionId: string }, operationId: string) => {
      submissions += 1;
      if (submissions === 1) {
        emit(request.sessionId, { type: "turn/started", turnId: "turn-1" });
        return undefined;
      }
      return {
        kind: "unknown",
        operationId,
        message: "admission response was lost",
      } satisfies MutationOutcome<Record<string, never>>;
    },
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    onEvent(callback: Listener) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => undefined,
  } as unknown as AgentRuntime;
  const { sessions, store, dir, projects, permissions, broadcast } = harness(runtime);
  const created = await sessions.create({ projectId: "project-1", title: "Queue" });
  await sessions.send(created.id, { text: "active" });
  const queued = await sessions.send(created.id, { text: "queued once", delivery: "queue" });

  emit(created.id, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () => {
    const operation = (await store.operations(created.id))
      .find((candidate) => candidate.mutationKind === "turn-submit"
        && candidate.state === "unknown");
    return operation !== undefined;
  });

  assert.equal(submissions, 2);
  assert.deepEqual((await store.queueList(created.id)).map((item) => item.id), [queued.queueId]);
  const reservation = (await store.operations(created.id))
    .find((operation) => operation.mutationKind === "turn-submit"
      && operation.state === "unknown")!;
  assert.equal((await store.queueReservation(reservation.operationId))?.queueItem.id, queued.queueId);
  assert.equal((await store.events(created.id))
    .filter((event) => event.type === "queue/dispatched").length, 0);

  await store.close();
  const reopened = createStore(join(dir, "sessions.db"));
  const afterRestart = createSessionService({
    store: reopened,
    projects,
    permissions,
    broadcast,
    queue: reopened,
    runtimes: { forProject: async () => runtime },
  });
  await afterRestart.events(created.id, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(submissions, 2);
  assert.equal((await reopened.queueList(created.id)).length, 1);
  assert.equal((await reopened.operation(reservation.operationId))?.state, "unknown");
  await waitFor(async () => (await reopened.reconciliation(created.id))?.state === "blocked");
  await reopened.close();
});

test("explicit protocol evidence proves an unknown permission reply was not applied", async () => {
  const listeners = new Set<Listener>();
  let permissionReplies = 0;
  const endpoint: RuntimeEndpoint = {
    authorityId: "authority-1",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/runtime/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const emit = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input: { sessionId: string; backendSessionId?: string }) =>
      input.backendSessionId ?? `backend-${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => undefined,
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyPermissionOperation: async (
      _sessionId: string,
      _requestId: string,
      _reply: string,
      operationId: string,
    ) => {
      permissionReplies += 1;
      if (permissionReplies === 1) {
        return {
          kind: "unknown",
          operationId,
          message: "permission response was lost",
        } satisfies MutationOutcome<Record<string, never>>;
      }
      return undefined;
    },
    replyQuestion: async () => undefined,
    endpoint: async () => endpoint,
    reconcile: async (
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    ): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "running", watermark: "pending-1" },
      completeness: {
        events: "partial",
        permissions: "complete",
        questions: "complete",
      },
      permissions: [{
        requestId: "permission-1",
        permission: "edit",
        patterns: ["src/*"],
      }],
      questions: [],
      events: [],
      nonAppliedOperations: [{
        operationId: (await store.operations(created.id)).find((operation) =>
          operation.mutationKind === "permission-reply")?.operationId ?? "",
        mutationKind: "permission-reply",
        requestId: "permission-1",
        backendSessionId: binding.backendSessionId,
      }],
    }),
    onEvent(callback: Listener) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => undefined,
  } as unknown as AgentRuntime;
  const { sessions, store } = harness(runtime);
  const created = await sessions.create({ projectId: "project-1", title: "Permission" });
  emit(created.id, {
    type: "permission/requested",
    requestId: "permission-1",
    permission: "edit",
    patterns: ["src/*"],
  });
  await waitFor(async () => (await store.events(created.id))
    .some((event) => event.type === "permission/requested"));

  await assert.rejects(
    () => sessions.replyPermission(created.id, "permission-1", "once"),
    (error: Error & { code?: string }) => error.code === "outcome-unknown",
  );
  await waitFor(async () => {
    const operations = await store.operations(created.id);
    return operations.some((operation) =>
      operation.mutationKind === "permission-reply" && operation.state === "not-applied");
  });

  let events = await store.events(created.id);
  assert.equal(events.some((event) => event.type === "permission/resolved"), false);
  assert.equal(events.some((event) => event.type === "permission/response-failed"), true);
  assert.equal(await store.responseIntent(created.id, "permission", "permission-1"), undefined);
  assert.equal((await store.projection(created.id))?.status, "waiting");

  await sessions.replyPermission(created.id, "permission-1", "once");
  events = await store.events(created.id);
  assert.equal(permissionReplies, 2);
  assert.equal(events.filter((event) => event.type === "permission/resolved").length, 1);
  await store.close();
});

test("complete pending data alone cannot prove an unknown response was not applied", async () => {
  const listeners = new Set<Listener>();
  const endpoint: RuntimeEndpoint = {
    authorityId: "authority-complete-without-causality",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/runtime/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const emit = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input: { sessionId: string; backendSessionId?: string }) =>
      input.backendSessionId ?? `backend-${input.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => undefined,
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyPermissionOperation: async (
      _sessionId: string,
      _requestId: string,
      _reply: string,
      operationId: string,
    ) => ({
      kind: "unknown",
      operationId,
      message: "permission response was lost",
    } satisfies MutationOutcome<Record<string, never>>),
    replyQuestion: async () => undefined,
    endpoint: async () => endpoint,
    reconcile: async (
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    ): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "running", watermark: "pending-without-causal-proof" },
      completeness: {
        events: "partial",
        permissions: "complete",
        questions: "complete",
      },
      permissions: [{
        requestId: "permission-without-proof",
        permission: "edit",
        patterns: ["src/*"],
      }],
      questions: [],
      events: [],
    }),
    onEvent(callback: Listener) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => undefined,
  } as unknown as AgentRuntime;
  const { sessions, store } = harness(runtime);
  const created = await sessions.create({
    projectId: "project-1",
    title: "Permission without causal proof",
  });
  emit(created.id, {
    type: "permission/requested",
    requestId: "permission-without-proof",
    permission: "edit",
    patterns: ["src/*"],
  });
  await waitFor(async () => (await store.events(created.id))
    .some((event) => event.type === "permission/requested"));

  await assert.rejects(
    () => sessions.replyPermission(created.id, "permission-without-proof", "once"),
    (error: Error & { code?: string }) => error.code === "outcome-unknown",
  );
  await waitFor(async () => (await store.reconciliation(created.id))?.state === "blocked");

  const operation = (await store.operations(created.id)).find((candidate) =>
    candidate.mutationKind === "permission-reply");
  assert.equal(operation?.state, "unknown");
  assert.ok(await store.responseIntent(
    created.id,
    "permission",
    "permission-without-proof",
  ));
  const events = await store.events(created.id);
  assert.equal(events.some((event) => event.type === "permission/response-failed"), false);
  assert.equal(events.some((event) => event.type === "permission/resolved"), false);
  assert.equal((await store.projection(created.id))?.status, "unknown");
  await store.close();
});

test("epoch-fenced operations stay uncertain and cannot be claimed, replayed, or rejected", async () => {
  const runtime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async () => "unused",
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => undefined,
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    onEvent: () => ({ dispose: () => undefined }),
    dispose: async () => undefined,
  } as AgentRuntime;
  const { store, project } = harness(runtime);
  const sessionId = "fenced-operation";
  const oldBinding = {
    backendSessionId: "backend-old",
    authorityId: "owned:destroyed",
    generation: 4,
    epoch: 0,
    continuity: "verified" as const,
    protocol: "legacy" as const,
    location: { directory: project.path },
  };
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    title: "Fenced",
    status: "epoch-pending",
    backendSessionId: oldBinding.backendSessionId,
    runtimeBinding: oldBinding,
    createdAt: 1,
    updatedAt: 1,
  });
  const uncertain = await store.prepareOperation({
    sessionId,
    mutationKind: "turn-submit",
    replay: { kind: "same-operation-id", contract: "turn-submit-v1" },
    intentEvent: { type: "user/message", data: { text: "do not replay" } },
  });
  await store.claimOperation(uncertain.operation.operationId);
  await store.settleOperation(uncertain.operation.operationId, {
    kind: "unknown",
    message: "admission outcome was lost",
  });
  const reset = await store.prepareOperation({
    sessionId,
    mutationKind: "session-reset",
    intentEvent: {
      type: "session/reset-intended",
      data: { reason: "runtime-epoch-rehydration" },
      ignorable: true,
    },
  });
  await store.claimOperation(reset.operation.operationId);
  await store.settleOperation(reset.operation.operationId, {
    kind: "confirmed",
    receipt: "backend-new",
  });
  await store.transitionRuntimeEpoch({
    sessionId,
    expectedBinding: oldBinding,
    replacementBinding: {
      ...oldBinding,
      backendSessionId: "backend-new",
      authorityId: "owned:replacement",
      generation: 1,
      epoch: 1,
      historyBaseline: "empty",
    },
    resetOperationId: reset.operation.operationId,
    reason: "destroyed runtime authority was quarantined",
    fence: { authorityId: oldBinding.authorityId, generation: oldBinding.generation },
  });

  assert.equal((await store.operation(uncertain.operation.operationId))?.state, "fenced");
  assert.equal((await store.claimOperation(uncertain.operation.operationId)).kind, "not-claimed");
  assert.equal(
    (await store.replayUnknownOperation(
      uncertain.operation.operationId,
      "turn-submit-v1",
    )).kind,
    "not-claimed",
  );
  await assert.rejects(
    () => store.settleOperation(uncertain.operation.operationId, {
      kind: "rejected",
      code: "runtime-replaced",
      message: "must remain uncertain",
    }),
    (error: Error & { code?: string }) => error.code === "invalid-transition",
  );
  assert.equal(
    (await store.events(sessionId)).some((event) =>
      event.type === "mutation/rejected"
      && (event.data as { operationId?: string }).operationId === uncertain.operation.operationId),
    false,
  );
  await store.close();
});
