import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  SessionProjection,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import {
  createSessionService,
  isRuntimeOperationBlocking,
  type Broadcaster,
} from "../src/sessions.ts";

const runtimeFor = (
  endpoint: RuntimeEndpoint,
  onEnsure: () => void = () => undefined,
): AgentRuntime => ({
  capabilities: async () => ({
    streaming: true,
    permissions: true,
    questions: true,
    compaction: false,
    subagents: false,
  }),
  models: async () => [],
  agents: async () => [],
  ensureSession: async (input) => {
    onEnsure();
    return input.backendSessionId ?? `backend-${input.sessionId}`;
  },
  sessions: async () => [],
  history: async () => [],
  startTurn: async () => undefined,
  abort: async () => undefined,
  replyPermission: async () => undefined,
  replyQuestion: async () => undefined,
  endpoint: async () => endpoint,
  protocol: async () => "legacy",
  onEvent: (_callback: (sessionId: string, event: RuntimeEvent) => void) => ({
    dispose: () => undefined,
  }),
  dispose: async () => undefined,
});

const harness = (runtime: AgentRuntime, prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = {
    id: "project-1",
    name: "Project",
    path: dir,
    createdAt: 1,
  };
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
    store,
    project,
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

const projectionFor = (
  project: Project,
  endpoint: RuntimeEndpoint,
  sessionId: string,
  backendSessionId: string,
  authorityId = endpoint.authorityId,
): SessionProjection => ({
  id: sessionId,
  projectId: project.id,
  title: "Epoch test",
  status: "epoch-pending",
  backendSessionId,
  runtimeBinding: {
    backendSessionId,
    authorityId,
    generation: 4,
    epoch: 0,
    continuity: "verified",
    protocol: "legacy",
    location: endpoint.location,
  },
  createdAt: 1,
  updatedAt: 1,
});

const confirmReset = async (
  store: ReturnType<typeof createStore>,
  sessionId: string,
  backendSessionId: string,
): Promise<string> => {
  const reset = await store.prepareOperation({
    sessionId,
    mutationKind: "session-reset",
    intentEvent: {
      type: "session/reset-intended",
      data: { reason: "runtime-epoch" },
      ignorable: true,
    },
  });
  assert.equal((await store.claimOperation(reset.operation.operationId)).kind, "claimed");
  await store.settleOperation(reset.operation.operationId, {
    kind: "confirmed",
    receipt: backendSessionId,
  });
  return reset.operation.operationId;
};

test("owned epoch transition atomically records the break and fences prior unknowns", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "owned:new-authority",
    continuity: "verified",
    generation: 1,
    url: "http://runtime.invalid",
    location: { directory: "/project" },
    control: { kind: "owned", instanceToken: "new-instance" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime = runtimeFor(endpoint);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-owned-");
  const sessionId = "session-owned";
  try {
    await store.upsertProjection(projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "owned:destroyed-authority",
    ));
    const uncertain = await store.prepareOperation({
      sessionId,
      mutationKind: "permission-reply",
      replay: { kind: "same-operation-id", contract: "permission-reply-v1" },
      intentEvent: {
        type: "permission/response-intended",
        data: { requestId: "permission-1", reply: "once" },
        ignorable: true,
      },
    });
    await store.claimOperation(uncertain.operation.operationId);
    await store.settleOperation(uncertain.operation.operationId, {
      kind: "unknown",
      message: "reply outcome was lost",
    });
    await store.enqueue(sessionId, "queued draft", "queue");
    const reserved = await store.reserveQueueHead({ sessionId });
    assert.equal(reserved.kind, "reserved");
    await store.claimOperation(reserved.reservation.operation.operationId);
    await store.settleOperation(reserved.reservation.operation.operationId, {
      kind: "unknown",
      message: "turn admission outcome was lost",
    });
    await store.append(sessionId, "permission/requested", {
      requestId: "permission-open",
      permission: "edit",
      patterns: ["src/*"],
    });
    await store.append(sessionId, "question/asked", {
      requestId: "question-open",
      questions: [{ id: "continue", question: "Continue?" }],
    });
    await store.append(sessionId, "secret/requested", {
      requestId: "secret-open",
      handle: "TOKEN",
      label: "Token",
    });
    await store.append(sessionId, "task/snapshot", {
      listId: "todo",
      revision: 7,
      items: [{ id: "task-1", text: "Keep working", status: "active" }],
    });
    await store.append(sessionId, "subagent/snapshot", {
      revision: 3,
      agents: [
        { sessionId: "child-running", label: "Running", status: "running" },
        { sessionId: "child-done", label: "Done", status: "done" },
      ],
    });
    const resetOperationId = await confirmReset(store, sessionId, "backend-new");

    const result = await sessions.transitionRuntimeEpoch(sessionId, runtime, {
      resetOperationId,
      reason: "isolated runtime DB was quarantined after an engine digest change",
      authorityDisposition: {
        kind: "owned-authority-destroyed",
        authorityId: "owned:destroyed-authority",
        generation: 4,
      },
    });

    assert.equal(result.marker.type, "runtime/epoch-replaced");
    assert.equal(result.marker.ignorable, true);
    assert.deepEqual(result.marker.data, {
      old: {
        authorityId: "owned:destroyed-authority",
        generation: 4,
        epoch: 0,
      },
      new: {
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        epoch: 1,
      },
      reason: "isolated runtime DB was quarantined after an engine digest change",
    });
    assert.equal(result.projection.runtimeBinding?.epoch, 1);
    assert.equal(result.projection.backendSessionId, "backend-new");
    assert.equal(result.projection.runtimeBinding?.backendSessionId, "backend-new");
    assert.equal(result.projection.status, "epoch-pending");
    assert.equal(result.fencedOperations.length, 2);
    for (const operation of result.fencedOperations) {
      assert.equal(operation.state, "fenced");
      assert.equal(isRuntimeOperationBlocking(operation), false);
      assert.equal((await store.claimOperation(operation.operationId)).kind, "not-claimed");
      assert.equal(
        (await store.replayUnknownOperation(operation.operationId, "permission-reply-v1")).kind,
        "not-claimed",
      );
    }
    assert.equal((await store.operation(uncertain.operation.operationId))?.state, "fenced");
    assert.equal(
      (await store.events(sessionId)).some((event) =>
        event.type === "mutation/rejected"
        && (event.data as { operationId?: string }).operationId === uncertain.operation.operationId),
      false,
    );
    assert.deepEqual(
      result.heldQueueItems.map((item) => ({ text: item.text, held: item.heldForReview })),
      [{ text: "queued draft", held: true }],
    );
    const held = await store.reserveQueueHead({ sessionId });
    assert.equal(held.kind, "held");
    assert.equal(held.queueItem.heldForReview, true);
    const events = await store.events(sessionId);
    assert.deepEqual(
      events
        .filter((event) => event.type.endsWith("/expired"))
        .map((event) => ({
          type: event.type,
          requestId: (event.data as { requestId?: string }).requestId,
          epoch: (event.data as { epoch?: number }).epoch,
          ignorable: event.ignorable,
        })),
      [
        { type: "permission/expired", requestId: "permission-open", epoch: 0, ignorable: true },
        { type: "question/expired", requestId: "question-open", epoch: 0, ignorable: true },
        { type: "secret/expired", requestId: "secret-open", epoch: 0, ignorable: true },
      ],
    );
    assert.deepEqual(
      events.findLast((event) => event.type === "task/snapshot")?.data,
      {
        listId: "todo",
        revision: 8,
        items: [{ id: "task-1", text: "Keep working", status: "active" }],
      },
    );
    assert.deepEqual(
      events.findLast((event) => event.type === "subagent/snapshot")?.data,
      {
        revision: 4,
        agents: [
          { sessionId: "child-running", label: "Running", status: "unknown" },
          { sessionId: "child-done", label: "Done", status: "done" },
        ],
      },
    );
    const reviewed = await store.queueEdit(
      sessionId,
      held.queueItem.id,
      "queued draft reviewed by the user",
    );
    assert.equal(reviewed?.heldForReview, undefined);
    assert.equal((await store.reserveQueueHead({ sessionId })).kind, "reserved");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("borrowed epoch requires confirmation and never auto-fences unknowns", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:shared",
    continuity: "generation-only",
    generation: 2,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime = runtimeFor(endpoint);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-borrowed-");
  const sessionId = "session-borrowed";
  try {
    const projection = projectionFor(project, endpoint, sessionId, "backend-old");
    projection.runtimeBinding = {
      ...projection.runtimeBinding!,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
    };
    await store.upsertProjection(projection);
    const uncertain = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "uncertain prompt" } },
    });
    await store.claimOperation(uncertain.operation.operationId);
    await store.settleOperation(uncertain.operation.operationId, {
      kind: "unknown",
      message: "submission outcome was lost",
    });
    const resetOperationId = await confirmReset(store, sessionId, "backend-new");

    await assert.rejects(
      () => sessions.transitionRuntimeEpoch(sessionId, runtime, {
        resetOperationId,
        reason: "user requested replacement",
        authorityDisposition: {
          kind: "owned-authority-destroyed",
          authorityId: endpoint.authorityId,
          generation: endpoint.generation,
        },
      }),
      (error: Error & { code?: string }) => error.code === "confirmation-required",
    );
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
    assert.equal((await store.operation(uncertain.operation.operationId))?.state, "unknown");

    const result = await sessions.transitionRuntimeEpoch(sessionId, runtime, {
      resetOperationId,
      reason: "user confirmed replacement of an external runtime",
      authorityDisposition: { kind: "borrowed-runtime-confirmed" },
    });
    assert.equal(result.projection.runtimeBinding?.epoch, 1);
    assert.deepEqual(result.fencedOperations, []);
    assert.equal((await store.operation(uncertain.operation.operationId))?.state, "unknown");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owned binding mismatch becomes epoch-pending without auto-replacement", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "owned:replacement",
    continuity: "verified",
    generation: 1,
    url: "http://runtime.invalid",
    location: { directory: "/project" },
    control: { kind: "owned", instanceToken: "replacement-instance" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  let ensureCalls = 0;
  const runtime = runtimeFor(endpoint, () => { ensureCalls += 1; });
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-pending-");
  const sessionId = "session-mismatch";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "owned:destroyed",
    );
    projection.status = "idle";
    await store.upsertProjection(projection);

    // Materialization detects the mismatch and records the durable pending
    // barrier. Phase 4 recovery is owned by send, not by ensureWired itself.
    await sessions.events(sessionId, 0);

    assert.equal(ensureCalls, 0);
    assert.equal((await store.projection(sessionId))?.status, "epoch-pending");
    assert.equal((await store.reconciliation(sessionId))?.state, "blocked");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
      "mismatch detection marks pending but never auto-completes the durable epoch",
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh epoch recovery is isolated to the project whose runtime authority changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-epoch-project-isolation-"));
  const store = createStore(join(dir, "sessions.db"));
  const projectA: Project = {
    id: "project-a",
    name: "A",
    path: join(dir, "a"),
    createdAt: 1,
  };
  const projectB: Project = {
    id: "project-b",
    name: "B",
    path: join(dir, "b"),
    createdAt: 1,
  };
  const endpointA: RuntimeEndpoint = {
    authorityId: "owned:a-new",
    continuity: "verified",
    generation: 1,
    url: "http://runtime-a.invalid",
    location: { directory: projectA.path },
    control: { kind: "owned", instanceToken: "a-new" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const endpointB: RuntimeEndpoint = {
    authorityId: "owned:b-stable",
    continuity: "verified",
    generation: 3,
    url: "http://runtime-b.invalid",
    location: { directory: projectB.path },
    control: { kind: "owned", instanceToken: "b-stable" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const resetCounts = new Map<string, number>();
  const submitted = new Map<string, string[]>();
  const runtime = (project: Project, endpoint: RuntimeEndpoint): AgentRuntime => {
    let resetOperationId: string | undefined;
    return {
      capabilities: async () => ({
        streaming: true,
        permissions: true,
        questions: true,
        compaction: false,
        subagents: false,
      }),
      models: async () => [],
      agents: async () => [],
      ensureSession: async (input) => input.backendSessionId ?? `backend-${project.id}`,
      resetSessionOperation: async (_input, operationId) => {
        resetOperationId = operationId;
        resetCounts.set(project.id, (resetCounts.get(project.id) ?? 0) + 1);
        return {
          kind: "confirmed",
          value: { backendSessionId: "backend-a-new" },
          receipt: "backend-a-new",
        };
      },
      sessions: async () => [],
      history: async () => [],
      startTurnOperation: async (request) => {
        const turns = submitted.get(project.id) ?? [];
        turns.push(request.text);
        submitted.set(project.id, turns);
        return { kind: "confirmed", value: {} };
      },
      startTurn: async () => undefined,
      abort: async () => undefined,
      replyPermission: async () => undefined,
      replyQuestion: async () => undefined,
      endpoint: async () => endpoint,
      protocol: async () => "legacy",
      reconcile: async (
        binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
      ): Promise<RuntimeSnapshot> => ({
        authorityId: binding.authorityId,
        generation: binding.generation,
        location: binding.location,
        backendSessionId: binding.backendSessionId!,
        reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
        state: resetOperationId
          ? { value: "idle", causalOperationId: resetOperationId }
          : {
              value: "idle",
              comparison: { domain: `stable-${project.id}`, order: 1 },
            },
        completeness: {
          events: "partial",
          permissions: "partial",
          questions: "partial",
        },
        permissions: [],
        questions: [],
        events: [],
      }),
      onEvent: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    };
  };
  const runtimeA = runtime(projectA, endpointA);
  const runtimeB = runtime(projectB, endpointB);
  const sessions = createSessionService({
    store,
    projects: {
      list: async () => [projectA, projectB],
      get: async (id) => id === projectA.id ? projectA : id === projectB.id ? projectB : undefined,
      add: async () => projectA,
      create: async () => projectA,
      remove: async () => undefined,
    },
    permissions: {
      evaluate: () => "allow",
      addRule: () => undefined,
      rules: () => [],
    } as unknown as PermissionService,
    broadcast: { event: () => undefined, projection: () => undefined },
    queue: store,
    runtimes: {
      forProject: async (projectId) => projectId === projectA.id ? runtimeA : runtimeB,
    },
  });
  await store.upsertProjection({
    id: "session-a",
    projectId: projectA.id,
    title: "A",
    status: "epoch-pending",
    backendSessionId: "backend-a-old",
    runtimeBinding: {
      backendSessionId: "backend-a-old",
      authorityId: "owned:a-destroyed",
      generation: 4,
      epoch: 0,
      continuity: "verified",
      protocol: "legacy",
      location: endpointA.location,
    },
    createdAt: 1,
    updatedAt: 1,
  });
  await store.upsertProjection({
    id: "session-b",
    projectId: projectB.id,
    title: "B",
    status: "idle",
    backendSessionId: "backend-b",
    runtimeBinding: {
      backendSessionId: "backend-b",
      authorityId: endpointB.authorityId,
      generation: endpointB.generation,
      epoch: 0,
      continuity: endpointB.continuity,
      protocol: "legacy",
      location: endpointB.location,
    },
    createdAt: 1,
    updatedAt: 1,
  });

  try {
    await sessions.send("session-a", { text: "recover only A" });
    await sessions.send("session-b", { text: "B stays continuous" });
    assert.equal(resetCounts.get(projectA.id), 1);
    assert.equal(resetCounts.get(projectB.id) ?? 0, 0);
    assert.equal((await store.projection("session-a"))?.runtimeBinding?.epoch, 1);
    assert.equal((await store.projection("session-b"))?.runtimeBinding?.epoch, 0);
    assert.equal((await store.projection("session-b"))?.backendSessionId, "backend-b");
    assert.equal(
      (await store.events("session-a")).filter((event) =>
        event.type === "runtime/epoch-replaced").length,
      1,
    );
    assert.equal(
      (await store.events("session-b")).some((event) =>
        event.type === "runtime/epoch-replaced"),
      false,
    );
    assert.deepEqual(submitted.get(projectB.id), ["B stays continuous"]);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
