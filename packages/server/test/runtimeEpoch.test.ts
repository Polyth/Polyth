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

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
};

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
      resetOperationId,
    });
    assert.equal(result.projection.runtimeBinding?.epoch, 1);
    assert.equal(result.projection.backendSessionId, "backend-new");
    assert.equal(result.projection.runtimeBinding?.backendSessionId, "backend-new");
    assert.equal(result.projection.status, "epoch-pending");
    assert.equal(result.fencedOperations.length, 2);

    const recoveredReconciliation = await store.startReconciliation(sessionId);
    await assert.rejects(
      () => store.ingestObservation({
        sessionId,
        identity: {
          authorityId: "owned:destroyed-authority",
          generation: 4,
          location: endpoint.location,
          backendSessionId: "backend-old",
          artifactKind: "message",
          entityId: "late-old-runtime-message",
          revision: "1",
        },
        reconciliationOrdinal: recoveredReconciliation.ordinal,
        events: [{
          type: "assistant/message",
          data: { partId: "old", text: "must be fenced" },
        }],
      }),
      (error: Error & { code?: string }) => error.code === "stale-evidence",
    );
    const recoveredObservation = await store.ingestObservation({
      sessionId,
      identity: {
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        location: endpoint.location,
        backendSessionId: "backend-new",
        artifactKind: "message",
        entityId: "new-runtime-message",
        revision: "1",
      },
      reconciliationOrdinal: recoveredReconciliation.ordinal,
      events: [{
        type: "assistant/message",
        data: { partId: "new", text: "accepted once" },
      }],
    });
    assert.equal(recoveredObservation.kind, "applied");
    assert.equal((await store.events(sessionId)).filter((event) =>
      event.type === "assistant/message"
      && (event.data as { text?: string }).text === "accepted once").length, 1);
    assert.equal((await store.events(sessionId)).some((event) =>
      (event.data as { text?: string }).text === "must be fenced"), false);

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

test("owned epoch fences an executing turn and refuses a late confirm", async () => {
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
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-executing-");
  const sessionId = "session-executing";
  try {
    await store.upsertProjection(projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "owned:destroyed-authority",
    ));
    const inFlight = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "still executing" } },
    });
    assert.equal((await store.claimOperation(inFlight.operation.operationId)).kind, "claimed");
    const resetOperationId = await confirmReset(store, sessionId, "backend-new");

    const result = await sessions.transitionRuntimeEpoch(sessionId, runtime, {
      resetOperationId,
      reason: "owned runtime authority changed during an in-flight turn",
      authorityDisposition: {
        kind: "owned-authority-destroyed",
        authorityId: "owned:destroyed-authority",
        generation: 4,
      },
    });

    assert.equal(result.fencedOperations.length, 1);
    assert.equal(result.fencedOperations[0]?.operationId, inFlight.operation.operationId);
    assert.equal((await store.operation(inFlight.operation.operationId))?.state, "fenced");
    assert.equal(result.heldQueueItems[0]?.text, "still executing");
    await assert.rejects(
      () => store.settleOperation(inFlight.operation.operationId, {
        kind: "confirmed",
        receipt: "late-backend-ack",
      }),
      (error: Error & { code?: string }) => error.code === "invalid-transition",
    );
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

test("borrowed binding mismatch becomes epoch-pending without auto-replacement", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:replacement",
    continuity: "generation-only",
    generation: 8,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  let ensureCalls = 0;
  const runtime = runtimeFor(endpoint, () => { ensureCalls += 1; });
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-borrowed-pending-");
  const sessionId = "session-borrowed-mismatch";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "external:destroyed",
    );
    projection.status = "idle";
    projection.runtimeBinding = {
      ...projection.runtimeBinding!,
      continuity: "generation-only",
    };
    await store.upsertProjection(projection);

    await sessions.events(sessionId, 0);

    assert.equal(ensureCalls, 0);
    const pending = await store.projection(sessionId);
    assert.equal(pending?.status, "epoch-pending");
    assert.equal(pending?.runtimeControl, "borrowed");
    assert.equal((await store.reconciliation(sessionId))?.state, "blocked");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
      "borrowed mismatch marks pending but never auto-completes the durable epoch",
    );
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
    const pending = await store.projection(sessionId);
    assert.equal(pending?.status, "epoch-pending");
    assert.equal(pending?.runtimeControl, "owned");
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
    const recoveredA = (await store.events("session-a"))
      .filter((event) => event.type === "user/message")
      .at(-1)!;
    assert.equal((recoveredA.data as { text?: string }).text, "recover only A");
    assert.match(
      (recoveredA.data as { recoveryContext?: string }).recoveryContext ?? "",
      /The execution runtime was replaced/,
    );
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

const borrowedConfirmRuntime = (
  endpoint: RuntimeEndpoint,
  submitted: string[],
): AgentRuntime => {
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
    ensureSession: async (input) => input.backendSessionId ?? "backend-borrowed-new",
    resetSessionOperation: async (_input, operationId) => {
      resetOperationId = operationId;
      return {
        kind: "confirmed",
        value: { backendSessionId: "backend-borrowed-new" },
        receipt: "backend-borrowed-new",
      };
    },
    sessions: async () => [],
    history: async () => [],
    startTurnOperation: async (request) => {
      submitted.push(request.text);
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
            comparison: { domain: "borrowed-stable", order: 1 },
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

test("owned epoch mismatch recovers in the background without a user send", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "owned:replacement",
    continuity: "verified",
    generation: 3,
    url: "http://runtime.invalid",
    location: { directory: "/project" },
    control: { kind: "owned", instanceToken: "replacement-instance" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const submitted: string[] = [];
  const runtime = borrowedConfirmRuntime(endpoint, submitted);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-owned-auto-");
  const sessionId = "session-owned-auto";
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

    await sessions.events(sessionId, 0);
    await waitFor(async () => (await store.projection(sessionId))?.status === "idle"
      && (await store.projection(sessionId))?.runtimeBinding?.epoch === 1);

    assert.equal((await store.projection(sessionId))?.backendSessionId, "backend-borrowed-new");
    assert.equal(
      (await store.events(sessionId)).filter((event) => event.type === "runtime/epoch-replaced").length,
      1,
    );
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "user/message"),
      false,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("borrowed confirm starts a fresh epoch without fencing unknowns", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:replacement",
    continuity: "generation-only",
    generation: 3,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const submitted: string[] = [];
  const runtime = borrowedConfirmRuntime(endpoint, submitted);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-borrowed-confirm-");
  const sessionId = "session-borrowed-confirm";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "external:destroyed",
    );
    projection.status = "epoch-pending";
    projection.runtimeControl = "borrowed";
    projection.runtimeBinding = {
      ...projection.runtimeBinding!,
      continuity: "generation-only",
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

    const ready = await sessions.confirmBorrowedRuntimeEpoch(sessionId);
    assert.equal(ready.status, "idle");
    assert.equal(ready.runtimeBinding?.epoch, 1);
    assert.equal(ready.backendSessionId, "backend-borrowed-new");
    assert.equal((await store.reconciliation(sessionId))?.state, "ready");
    assert.equal((await store.operation(uncertain.operation.operationId))?.state, "unknown");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "mutation/fenced"),
      false,
    );
    assert.equal(isRuntimeOperationBlocking((await store.operation(uncertain.operation.operationId))!), true);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new send after borrowed confirm proceeds with a lingering prior-epoch unknown", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:replacement",
    continuity: "generation-only",
    generation: 3,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const submitted: string[] = [];
  const runtime = borrowedConfirmRuntime(endpoint, submitted);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-borrowed-send-");
  const sessionId = "session-borrowed-send";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "external:destroyed",
    );
    projection.status = "epoch-pending";
    projection.runtimeControl = "borrowed";
    projection.runtimeBinding = {
      ...projection.runtimeBinding!,
      continuity: "generation-only",
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

    await sessions.confirmBorrowedRuntimeEpoch(sessionId);
    await sessions.send(sessionId, { text: "fresh prompt after confirm" });
    assert.equal(submitted.length, 1);
    assert.match(submitted[0] ?? "", /fresh prompt after confirm/);
    assert.equal((await store.operation(uncertain.operation.operationId))?.state, "unknown");
    const sent = (await store.events(sessionId))
      .filter((event) => event.type === "user/message")
      .at(-1)!;
    assert.equal((sent.data as { text?: string }).text, "fresh prompt after confirm");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("borrowed epoch-pending send refuses to auto-recover", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:replacement",
    continuity: "generation-only",
    generation: 3,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime = borrowedConfirmRuntime(endpoint, []);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-borrowed-refuse-send-");
  const sessionId = "session-borrowed-refuse-send";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "external:destroyed",
    );
    projection.status = "epoch-pending";
    projection.runtimeControl = "borrowed";
    projection.runtimeBinding = {
      ...projection.runtimeBinding!,
      continuity: "generation-only",
    };
    await store.upsertProjection(projection);

    await assert.rejects(
      () => sessions.send(sessionId, { text: "should stay blocked" }),
      (error: Error & { code?: string }) =>
        error.code === "confirmation-required" || error.code === "epoch-pending",
    );
    assert.equal((await store.projection(sessionId))?.status, "epoch-pending");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owned sessions refuse borrowed epoch confirmation", async () => {
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
  const runtime = runtimeFor(endpoint);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-owned-refuse-");
  const sessionId = "session-owned-refuse";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "owned:destroyed",
    );
    projection.status = "epoch-pending";
    projection.runtimeControl = "owned";
    await store.upsertProjection(projection);

    await assert.rejects(
      () => sessions.confirmBorrowedRuntimeEpoch(sessionId),
      (error: Error & { code?: string }) => error.code === "epoch-proof-required",
    );
    assert.equal((await store.projection(sessionId))?.status, "epoch-pending");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("healthy borrowed confirm refuses to manufacture an identity break", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:healthy",
    continuity: "verified",
    generation: 4,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime = borrowedConfirmRuntime(endpoint, []);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-borrowed-healthy-");
  const sessionId = "session-borrowed-healthy";
  try {
    const projection = projectionFor(project, endpoint, sessionId, "backend-healthy");
    projection.status = "idle";
    projection.runtimeControl = "borrowed";
    await store.upsertProjection(projection);

    await assert.rejects(
      () => sessions.confirmBorrowedRuntimeEpoch(sessionId),
      (error: Error & { code?: string }) =>
        error.code === "confirmation-not-required" || error.code === "conflict",
    );
    const after = await store.projection(sessionId);
    assert.equal(after?.status, "idle");
    assert.equal(after?.backendSessionId, "backend-healthy");
    assert.equal(after?.runtimeBinding?.epoch ?? 0, 0);
    assert.equal(after?.runtimeBinding?.backendSessionId, "backend-healthy");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
    assert.equal(
      (await store.operations(sessionId)).some((operation) => operation.mutationKind === "session-reset"),
      false,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unrelated session-reset without epoch-replaced does not lift a prior unknown", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:healthy",
    continuity: "verified",
    generation: 4,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const submitted: string[] = [];
  const runtime = borrowedConfirmRuntime(endpoint, submitted);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-unrelated-reset-");
  const sessionId = "session-unrelated-reset";
  try {
    const projection = projectionFor(project, endpoint, sessionId, "backend-healthy");
    projection.status = "idle";
    projection.runtimeControl = "borrowed";
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
    await confirmReset(store, sessionId, "backend-unrelated");

    await assert.rejects(
      () => sessions.send(sessionId, { text: "should stay blocked" }),
      (error: Error & { code?: string }) => error.code === "conflict",
    );
    assert.equal(submitted.length, 0);
    assert.equal((await store.operation(uncertain.operation.operationId))?.state, "unknown");
    assert.equal(
      (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("later unrelated session-reset does not become the epoch send barrier", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "external:replacement",
    continuity: "generation-only",
    generation: 3,
    url: "http://runtime.invalid",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const submitted: string[] = [];
  const runtime = borrowedConfirmRuntime(endpoint, submitted);
  const { dir, store, project, sessions } = harness(runtime, "polyth-epoch-later-reset-");
  const sessionId = "session-later-reset";
  try {
    const projection = projectionFor(
      project,
      endpoint,
      sessionId,
      "backend-old",
      "external:destroyed",
    );
    projection.status = "epoch-pending";
    projection.runtimeControl = "borrowed";
    projection.runtimeBinding = {
      ...projection.runtimeBinding!,
      continuity: "generation-only",
    };
    await store.upsertProjection(projection);
    const prior = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "prior unknown" } },
    });
    await store.claimOperation(prior.operation.operationId);
    await store.settleOperation(prior.operation.operationId, {
      kind: "unknown",
      message: "submission outcome was lost",
    });

    await sessions.confirmBorrowedRuntimeEpoch(sessionId);
    const post = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "post-epoch unknown" } },
    });
    await store.claimOperation(post.operation.operationId);
    await store.settleOperation(post.operation.operationId, {
      kind: "unknown",
      message: "new turn outcome was lost",
    });
    await confirmReset(store, sessionId, "backend-unrelated-later");

    await assert.rejects(
      () => sessions.send(sessionId, { text: "post-epoch unknown must still block" }),
      (error: Error & { code?: string }) => error.code === "conflict",
    );
    assert.equal(submitted.length, 0);
    assert.equal((await store.operation(prior.operation.operationId))?.state, "unknown");
    assert.equal((await store.operation(post.operation.operationId))?.state, "unknown");
    const marker = (await store.events(sessionId))
      .findLast((event) => event.type === "runtime/epoch-replaced");
    assert.ok(marker);
    assert.equal(
      typeof (marker.data as { resetOperationId?: unknown }).resetOperationId,
      "string",
    );
    assert.notEqual(
      (marker.data as { resetOperationId?: string }).resetOperationId,
      post.operation.operationId,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
