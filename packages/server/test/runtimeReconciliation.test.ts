import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  PersistedRuntimeBinding,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeLifecycleNotification,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  SessionProjection,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
};

const makeHarness = (
  runtime: AgentRuntime,
  projectPath?: string,
) => {
  const dir = projectPath ?? mkdtempSync(join(tmpdir(), "polyth-reconciliation-"));
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
    project,
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

const endpointFor = (directory: string): RuntimeEndpoint => ({
  authorityId: "authority-1",
  continuity: "verified",
  generation: 7,
  url: "http://fake.invalid",
  location: { directory },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

const persistedBindingFor = (
  endpoint: RuntimeEndpoint,
  backendSessionId: string,
): PersistedRuntimeBinding => ({
  backendSessionId,
  authorityId: endpoint.authorityId,
  generation: endpoint.generation,
  continuity: endpoint.continuity,
  protocol: "legacy",
  location: endpoint.location,
});

const runtimeWithSnapshot = (
  endpoint: RuntimeEndpoint,
  snapshot: (
    binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
  ) => RuntimeSnapshot,
  sessions: AgentRuntime["sessions"] = async () => [],
  protocol?: "legacy" | "v2",
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
  ensureSession: async (input) => input.backendSessionId ?? `backend-${input.sessionId}`,
  sessions,
  history: async () => [],
  startTurn: async () => undefined,
  abort: async () => undefined,
  replyPermission: async () => undefined,
  replyQuestion: async () => undefined,
  onEvent: (_callback: (sessionId: string, event: RuntimeEvent) => void) => ({
    dispose: () => undefined,
  }),
  dispose: async () => undefined,
  endpoint: async () => endpoint,
  ...(protocol ? { protocol: async () => protocol } : {}),
  reconcile: async (binding: RuntimeSessionBinding & { reconciliationOrdinal?: number }) =>
    snapshot(binding),
} as AgentRuntime);

test("passive event-tail prefetch does not materialize a runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-prefetch-"));
  const endpoint = endpointFor(dir);
  let materializations = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "idle", watermark: "prefetch" },
    completeness: { events: "complete", permissions: "complete", questions: "complete" },
    events: [],
  }));
  runtime.ensureSession = async (input) => {
    materializations += 1;
    return input.backendSessionId ?? `backend-${input.sessionId}`;
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-prefetch",
    projectId: project.id,
    backendSessionId: "backend-prefetch",
    runtimeBinding: persistedBindingFor(endpoint, "backend-prefetch"),
    title: "Prefetch",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append("session-prefetch", "user/message", { text: "cached" });

  assert.deepEqual(
    (await sessions.events("session-prefetch", 0, { limit: 40, prefetch: true })).map((event) => event.seq),
    [1],
  );
  assert.equal(materializations, 0);
  await sessions.events("session-prefetch", 1, { prefetch: false });
  assert.equal(materializations, 1, "interactive reconcile still wires the runtime");
  await store.close();
});

test("materialization reconciles missed permission and question state before admission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-pending-"));
  const endpoint = endpointFor(dir);
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "running", watermark: "pending-2" },
    completeness: {
      events: "partial",
      permissions: "complete",
      questions: "complete",
    },
    permissions: [{
      requestId: "permission-missed",
      permission: "edit",
      patterns: ["src/*"],
    }],
    questions: [{
      requestId: "question-missed",
      questions: [{ id: "continue", prompt: "Continue?" }],
    }],
    events: [],
  }));
  const { sessions, store, project } = makeHarness(runtime, dir);
  const projection: SessionProjection = {
    id: "session-1",
    projectId: project.id,
    backendSessionId: "backend-1",
    runtimeBinding: persistedBindingFor(endpoint, "backend-1"),
    title: "Recovered",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  };
  await store.upsertProjection(projection);

  assert.equal((await sessions.list(project.id))[0]!.status, "working");
  await sessions.events(projection.id, 0);
  await waitFor(async () => (await store.projection(projection.id))?.status === "waiting");

  const events = await store.events(projection.id);
  assert.equal(events.filter((event) => event.type === "permission/requested"
    && (event.data as { requestId?: string }).requestId === "permission-missed").length, 1);
  assert.equal(events.filter((event) => event.type === "question/asked"
    && (event.data as { requestId?: string }).requestId === "question-missed").length, 1);
  assert.equal(events.some((event) => event.type === "reconciliation/started"), true);
  assert.equal(events.some((event) => event.type === "reconciliation/completed"), true);
  assert.equal((await store.reconciliation(projection.id))?.state, "ready");
  await store.close();
});

test("interrupted backend evidence clears a stale running projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-death-"));
  const endpoint = endpointFor(dir);
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: {
      value: "interrupted",
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
  }));
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-dead",
    projectId: project.id,
    backendSessionId: "backend-dead",
    runtimeBinding: persistedBindingFor(endpoint, "backend-dead"),
    title: "Interrupted",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events("session-dead", 0);
  assert.equal((await store.projection("session-dead"))?.status, "failed");
  assert.notEqual((await sessions.snapshot("session-dead")).status, "working");
  await store.close();
});

test("idle reconciliation closes a turn whose terminal event was missed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-missed-stop-"));
  const endpoint = endpointFor(dir);
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: {
      value: "idle",
      watermark: "2",
      comparison: { domain: "test-status", order: 2 },
    },
    completeness: { events: "partial", permissions: "partial", questions: "partial" },
    permissions: [],
    questions: [],
    events: [],
  }));
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-missed-stop";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-missed-stop",
    runtimeBinding: persistedBindingFor(endpoint, "backend-missed-stop"),
    title: "Missed stop",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "turn/started", { turnId: "turn-missed" }, { ignorable: true });

  await sessions.events(sessionId, 0);

  assert.equal((await store.projection(sessionId))?.status, "idle");
  const stops = (await store.events(sessionId)).filter((event) => event.type === "turn/stopped");
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0]?.data, { turnId: "turn-missed", reason: "completed" });
  await store.close();
});

test("first materialization reconciles an idle persisted session before admission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-idle-first-wire-"));
  const endpoint = endpointFor(dir);
  let reconciliations = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => {
    reconciliations += 1;
    return {
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "running", watermark: "running-after-restart" },
      completeness: {
        events: "partial",
        permissions: "partial",
        questions: "partial",
      },
      permissions: [],
      questions: [],
      events: [],
    };
  });
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-idle-before-wire",
    projectId: project.id,
    backendSessionId: "backend-idle-before-wire",
    runtimeBinding: persistedBindingFor(endpoint, "backend-idle-before-wire"),
    title: "Persisted idle",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events("session-idle-before-wire", 0);

  assert.equal(reconciliations, 1);
  assert.equal((await store.projection("session-idle-before-wire"))?.status, "working");
  assert.equal((await store.reconciliation("session-idle-before-wire"))?.state, "ready");
  await store.close();
});

test("a backend session without durable runtime identity cannot attach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-unbound-"));
  const endpoint = endpointFor(dir);
  let attachments = 0;
  const runtime = runtimeWithSnapshot(endpoint, () => {
    assert.fail("an unbound backend session reached reconciliation");
  });
  runtime.ensureSession = async () => {
    attachments += 1;
    return "backend-unbound";
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-unbound",
    projectId: project.id,
    backendSessionId: "backend-unbound",
    title: "Unbound",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  await assert.rejects(
    sessions.send("session-unbound", { text: "must not attach" }),
    (error: Error & { code?: string }) => error.code === "binding-mismatch",
  );
  assert.equal(attachments, 0);
  assert.equal((await store.projection("session-unbound"))?.runtimeBinding, undefined);
  await store.close();
});

test("first wire rebinds a verified durable session to the current generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-owned-restart-"));
  const endpoint: RuntimeEndpoint = {
    ...endpointFor(dir),
    continuity: "verified",
    generation: 2,
    control: { kind: "owned", instanceToken: "owned-generation-2" },
  };
  let reconciliations = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => {
    reconciliations += 1;
    assert.equal(binding.authorityId, endpoint.authorityId);
    assert.equal(binding.generation, endpoint.generation);
    assert.equal(binding.backendSessionId, "backend-owned-restart");
    return {
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: {
        value: "interrupted",
        watermark: "2",
        comparison: { domain: "test-status", order: 2 },
      },
      completeness: {
        events: "partial",
        permissions: "partial",
        questions: "partial",
      },
      permissions: [],
      questions: [],
      events: [],
    };
  });
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-owned-restart";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-owned-restart",
    runtimeBinding: {
      backendSessionId: "backend-owned-restart",
      authorityId: endpoint.authorityId,
      generation: 1,
      continuity: "verified",
      protocol: "legacy",
      location: endpoint.location,
    },
    title: "Owned restart",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "user/message", { text: "run once" });

  await sessions.events(sessionId, 0);

  const recovered = await store.projection(sessionId);
  assert.equal(reconciliations, 1);
  assert.equal(recovered?.runtimeBinding?.authorityId, endpoint.authorityId);
  assert.equal(recovered?.runtimeBinding?.generation, endpoint.generation);
  assert.equal(recovered?.status, "failed");
  assert.equal(
    (await store.events(sessionId)).filter((event) => event.type === "user/message").length,
    1,
  );
  await store.close();
});

test("first wire migrates a stale V2 binding to the selected legacy protocol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-protocol-migration-"));
  const endpoint = endpointFor(dir);
  let reconciliations = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => {
    reconciliations += 1;
    return {
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
    };
  });
  runtime.protocol = async () => "legacy";
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-stale-v2-binding";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-shared-store",
    runtimeBinding: {
      backendSessionId: "backend-shared-store",
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      protocol: "v2",
      location: endpoint.location,
    },
    title: "Mixed protocol session",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events(sessionId, 0);

  const recovered = await store.projection(sessionId);
  assert.equal(reconciliations, 1);
  assert.equal(recovered?.runtimeBinding?.backendSessionId, "backend-shared-store");
  assert.equal(recovered?.runtimeBinding?.protocol, "legacy");
  assert.equal(recovered?.status, "idle");
  await store.close();
});

test("first wire upgrades a legacy protocol binding for the same owned endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-protocol-upgrade-"));
  const endpoint: RuntimeEndpoint = {
    ...endpointFor(dir),
    continuity: "generation-only",
    control: { kind: "owned", instanceToken: "owned-protocol-upgrade" },
  };
  let reconciliations = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => {
    reconciliations += 1;
    assert.equal(binding.backendSessionId, "backend-protocol-upgrade");
    return {
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "interrupted", watermark: "7", comparison: { domain: "test-status", order: 7 } },
      completeness: { events: "partial", permissions: "partial", questions: "partial" },
      permissions: [],
      questions: [],
      events: [],
    };
  }, undefined, "v2");
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-protocol-upgrade";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-protocol-upgrade",
    runtimeBinding: {
      backendSessionId: "backend-protocol-upgrade",
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      protocol: "legacy",
      location: endpoint.location,
    },
    title: "Protocol upgrade",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events(sessionId, 0);

  assert.equal(reconciliations, 1);
  assert.equal((await store.projection(sessionId))?.runtimeBinding?.protocol, "v2");
  await store.close();
});

test("idle snapshot without a comparable watermark remains unknown and blocks admission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-unversioned-idle-"));
  const endpoint = endpointFor(dir);
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "idle" },
    completeness: {
      events: "partial",
      permissions: "partial",
      questions: "partial",
    },
    permissions: [],
    questions: [],
    events: [],
  }));
  runtime.startTurn = async () => {
    submissions += 1;
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-unversioned-idle",
    projectId: project.id,
    backendSessionId: "backend-unversioned-idle",
    runtimeBinding: persistedBindingFor(endpoint, "backend-unversioned-idle"),
    title: "Unversioned idle",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events("session-unversioned-idle", 0);

  assert.equal((await store.projection("session-unversioned-idle"))?.status, "unknown");
  assert.equal((await store.reconciliation("session-unversioned-idle"))?.state, "unknown");
  await assert.rejects(
    () => sessions.send("session-unversioned-idle", { text: "must not run" }),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  assert.equal(submissions, 0);
  await store.close();
});

test("a stopped turn can send again when reconciliation status is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-stopped-send-"));
  const endpoint = endpointFor(dir);
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "idle" },
    completeness: { events: "partial", permissions: "partial", questions: "partial" },
    permissions: [],
    questions: [],
    events: [],
  }));
  runtime.startTurn = async () => { submissions += 1; };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-stopped-send";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-stopped-send",
    runtimeBinding: persistedBindingFor(endpoint, "backend-stopped-send"),
    title: "Stopped turn",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "turn/stopped", { turnId: "stopped-1", reason: "completed" });

  await sessions.events(sessionId, 0);
  assert.equal((await store.reconciliation(sessionId))?.state, "unknown");
  await sessions.send(sessionId, { text: "continue after stop" });
  assert.equal(submissions, 1);
  await store.close();
});

test("send recovers an orphaned turn when runtime status is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-orphaned-turn-"));
  const endpoint = endpointFor(dir);
  let aborts = 0;
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "unknown" },
    completeness: { events: "partial", permissions: "partial", questions: "partial" },
    permissions: [],
    questions: [],
    events: [],
  }));
  runtime.abort = async () => { aborts += 1; };
  runtime.startTurn = async () => { submissions += 1; };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-orphaned-turn";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-orphaned-turn",
    runtimeBinding: persistedBindingFor(endpoint, "backend-orphaned-turn"),
    title: "Orphaned turn",
    status: "unknown",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "turn/started", { turnId: "orphaned-1" });

  await sessions.send(sessionId, { text: "continue after restart" });

  assert.deepEqual(
    (await store.events(sessionId)).filter((event) => event.type.startsWith("turn/")).map((event) => event.type),
    ["turn/started", "turn/abort-requested", "turn/stopped"],
  );
  assert.equal(aborts, 1);
  assert.equal(submissions, 1);
  assert.equal((await store.events(sessionId)).some((event) => event.type === "turn/stopped"), true);
  await store.close();
});

test("equal status evidence is idempotent but a stale terminal revision cannot reopen admission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-stale-terminal-"));
  const endpoint = endpointFor(dir);
  let state: RuntimeSnapshot["state"] = {
    value: "idle",
    watermark: "1",
    comparison: { domain: "test-status", order: 1 },
  };
  let notifyLifecycle: ((notification: RuntimeLifecycleNotification) => void) | undefined;
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state,
    completeness: {
      events: "partial",
      permissions: "partial",
      questions: "partial",
    },
    permissions: [],
    questions: [],
    events: [],
  }));
  runtime.onLifecycle = (callback) => {
    notifyLifecycle = callback;
    return { dispose: () => { notifyLifecycle = undefined; } };
  };
  runtime.startTurn = async () => {
    submissions += 1;
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-stale-terminal";
  const backendSessionId = "backend-stale-terminal";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId,
    runtimeBinding: persistedBindingFor(endpoint, backendSessionId),
    title: "Stale terminal",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events(sessionId, 0);
  assert.equal((await store.projection(sessionId))?.status, "idle");

  notifyLifecycle!({ type: "stream-connected" });
  await waitFor(async () => (await store.reconciliation(sessionId))?.ordinal === 2);
  assert.equal(
    (await store.projection(sessionId))?.status,
    "idle",
    "repeating the same state at the same revision is idempotent",
  );

  state = {
    value: "running",
    watermark: "2",
    comparison: { domain: "test-status", order: 2 },
  };
  notifyLifecycle!({ type: "stream-connected" });
  await waitFor(async () => (await store.reconciliation(sessionId))?.ordinal === 3);
  assert.equal((await store.projection(sessionId))?.status, "working");

  state = {
    value: "idle",
    watermark: "1",
    comparison: { domain: "test-status", order: 1 },
  };
  notifyLifecycle!({ type: "stream-connected" });
  await waitFor(async () => (await store.reconciliation(sessionId))?.ordinal === 4);
  assert.equal((await store.projection(sessionId))?.status, "unknown");
  assert.deepEqual(
    (await store.observationCheckpoint({
      authorityId: endpoint.authorityId,
      location: endpoint.location,
      backendSessionId,
      artifactKind: "status",
      entityId: backendSessionId,
    }))?.value,
    {
      state: "running",
      watermark: "2",
      comparison: { domain: "test-status", order: 2 },
    },
    "rejected stale evidence must not erase the newer checkpoint",
  );
  await assert.rejects(
    () => sessions.send(sessionId, { text: "must stay blocked" }),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  assert.equal(submissions, 0);
  await store.close();
});

test("a fork receipt cannot prove child idle after any child mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-fork-cause-"));
  const endpoint = endpointFor(dir);
  let notifyLifecycle: ((notification: RuntimeLifecycleNotification) => void) | undefined;
  let causalOperationId = "";
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "idle", causalOperationId },
    completeness: {
      events: "partial",
      permissions: "partial",
      questions: "partial",
    },
    permissions: [],
    questions: [],
    events: [],
  }));
  runtime.onLifecycle = (callback) => {
    notifyLifecycle = callback;
    return { dispose: () => { notifyLifecycle = undefined; } };
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const childSessionId = "fork-child";
  const backendSessionId = "backend-fork-child";
  const preparedFork = await store.prepareOperation({
    sessionId: "fork-source",
    mutationKind: "session-fork",
    intentEvent: {
      type: "session/fork-intended",
      data: { childSessionId },
      ignorable: true,
    },
  });
  causalOperationId = preparedFork.operation.operationId;
  await store.claimOperation(causalOperationId);
  await store.settleOperation(causalOperationId, {
    kind: "confirmed",
    receipt: backendSessionId,
  });
  await store.upsertProjection({
    id: childSessionId,
    projectId: project.id,
    backendSessionId,
    runtimeBinding: persistedBindingFor(endpoint, backendSessionId),
    title: "Fork child",
    status: "reconciling",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events(childSessionId, 0);
  assert.equal((await store.projection(childSessionId))?.status, "idle");

  const childTurn = await store.prepareOperation({
    sessionId: childSessionId,
    mutationKind: "turn-submit",
    intentEvent: {
      type: "user/message",
      data: { text: "child work" },
    },
  });
  await store.claimOperation(childTurn.operation.operationId);
  await store.settleOperation(childTurn.operation.operationId, { kind: "confirmed" });

  notifyLifecycle!({ type: "stream-connected" });
  await waitFor(async () => (await store.reconciliation(childSessionId))?.ordinal === 2);
  assert.equal((await store.projection(childSessionId))?.status, "unknown");
  assert.equal((await store.reconciliation(childSessionId))?.state, "unknown");
  await store.close();
});

test("fork and import first-wire reconciliation does not duplicate copied history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-first-wire-history-"));
  const endpoint = endpointFor(dir);
  const runtime = runtimeWithSnapshot(
    endpoint,
    (binding) => ({
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
      events: binding.backendSessionId === "backend-source"
        ? []
        : [{
            entityKey: `part:${binding.backendSessionId}`,
            revision: "1",
            event: {
              type: "assistant/message",
              partId: `part:${binding.backendSessionId}`,
              text: binding.backendSessionId === "backend-child"
                ? "copied answer"
                : "imported answer",
            },
          }],
    }),
    async () => [{
      id: "backend-import",
      title: "Imported",
      createdAt: 1,
      updatedAt: 2,
    }],
  );
  runtime.branchSession = async () => "backend-child";
  runtime.branchSessionOperation = async () => ({
    kind: "confirmed",
    value: { backendSessionId: "backend-child" },
  });
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-source",
    projectId: project.id,
    backendSessionId: "backend-source",
    runtimeBinding: persistedBindingFor(endpoint, "backend-source"),
    title: "Source",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append("session-source", "user/message", { text: "copied prompt" });
  await store.append("session-source", "assistant/message", {
    partId: "part:backend-child",
    text: "copied answer",
  });

  const forked = await sessions.fork("session-source");
  assert.equal((await store.events(forked.id))
    .filter((event) => event.type === "assistant/message").length, 1);
  assert.equal((await store.projection(forked.id))?.runtimeBinding?.historyBaseline, undefined);
  assert.equal((await store.reconciliation(forked.id))?.state, "ready");

  const [imported] = await sessions.importBackendSessions!(project.id, ["backend-import"]);
  assert.ok(imported);
  await sessions.events(imported.id, 0);
  assert.equal((await store.events(imported.id))
    .filter((event) => event.type === "assistant/message").length, 1);
  assert.equal((await store.events(imported.id))
    .filter((event) => event.type === "session/history-imported").length, 1);
  assert.equal((await store.projection(imported.id))?.runtimeBinding?.historyBaseline, undefined);
  assert.equal((await store.reconciliation(imported.id))?.state, "ready");
  await store.close();
});

test("whole snapshot ingestion rolls back every artifact and cursor on an injected failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-cursor-atomicity-"));
  const endpoint = endpointFor(dir);
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "running", watermark: "running-with-two-events" },
    completeness: {
      events: "partial",
      permissions: "partial",
      questions: "partial",
    },
    cursorAfter: "cursor-after-both-events",
    permissions: [],
    questions: [],
    events: [
      {
        entityKey: "assistant-part-1",
        revision: "revision-1",
        event: { type: "assistant/message", partId: "assistant-part-1", text: "first" },
      },
      {
        entityKey: "assistant-part-2",
        revision: "revision-1",
        event: { type: "assistant/message", partId: "assistant-part-2", text: "second" },
      },
    ],
  }));
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-cursor-atomicity",
    projectId: project.id,
    backendSessionId: "backend-cursor-atomicity",
    runtimeBinding: persistedBindingFor(endpoint, "backend-cursor-atomicity"),
    title: "Cursor atomicity",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  const ingestSnapshot = store.ingestSnapshot.bind(store);
  store.ingestSnapshot = (input) => {
    const observations = input.observations.map((observation, index) =>
      index === 1
        ? {
            ...observation,
            checkpoint: {
              value: { injectedFailure: BigInt(1) } as never,
            },
          }
        : observation);
    return ingestSnapshot({ ...input, observations });
  };

  await sessions.events("session-cursor-atomicity", 0);

  assert.equal((await store.events("session-cursor-atomicity"))
    .filter((event) => event.type === "assistant/message").length, 0);
  assert.equal(
    await store.observationCursor({
      authorityId: endpoint.authorityId,
      location: endpoint.location,
      backendSessionId: "backend-cursor-atomicity",
      channel: "runtime",
    }),
    undefined,
  );
  assert.equal((await store.reconciliation("session-cursor-atomicity"))?.state, "unknown");
  await store.close();
});

test("runtime observation uncertainty survives the AgentRuntime ingestion seam", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-uncertainty-"));
  const endpoint = endpointFor(dir);
  let observe:
    | Parameters<NonNullable<AgentRuntime["onObservation"]>>[0]
    | undefined;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
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
  }));
  runtime.onObservation = (callback) => {
    observe = callback;
    return { dispose: () => { observe = undefined; } };
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "session-uncertain",
    projectId: project.id,
    backendSessionId: "backend-uncertain",
    runtimeBinding: persistedBindingFor(endpoint, "backend-uncertain"),
    title: "Uncertain",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.events("session-uncertain", 0);
  assert.ok(observe);
  const reconciliation = await store.reconciliation("session-uncertain");
  assert.ok(reconciliation);
  observe("session-uncertain", {
    channel: "pull",
    entityKey: "part-uncertain",
    identity: {
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      location: endpoint.location,
      backendSessionId: "backend-uncertain",
      artifactKind: "part",
      entityId: "part-uncertain",
      revision: "revision-2:uncertainty",
    },
    reconciliationOrdinal: reconciliation.ordinal,
    events: [],
    uncertainty: {
      code: "divergent-content",
      message: "recovered content diverges from the durable checkpoint",
    },
  });
  await waitFor(async () => (await store.events("session-uncertain"))
    .some((event) => event.type === "reconciliation/uncertainty-recorded"));
  const uncertainty = (await store.events("session-uncertain"))
    .find((event) => event.type === "reconciliation/uncertainty-recorded");
  assert.deepEqual(uncertainty?.data, {
    entityKey: "part-uncertain",
    code: "divergent-content",
    message: "recovered content diverges from the durable checkpoint",
  });
  assert.equal(uncertainty?.producerPlugin, "backend-opencode");
  await store.close();
});

test("backend listing never offers an active deletion tombstone for re-adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-tombstone-"));
  const endpoint = endpointFor(dir);
  const runtime = runtimeWithSnapshot(
    endpoint,
    (binding) => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "idle" },
      completeness: {
        events: "partial",
        permissions: "partial",
        questions: "partial",
      },
      permissions: [],
      questions: [],
      events: [],
    }),
    async () => [{
      id: "backend-deleted",
      title: "Stale backend session",
      createdAt: 1,
      updatedAt: 2,
    }],
  );
  const { sessions, store, project } = makeHarness(runtime, dir);
  await store.upsertProjection({
    id: "deleted-session",
    projectId: project.id,
    backendSessionId: "backend-deleted",
    runtimeBinding: persistedBindingFor(endpoint, "backend-deleted"),
    title: "Deleted",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.prepareSessionDeletion({
    binding: {
      canonicalSessionId: "deleted-session",
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      location: endpoint.location,
      backendSessionId: "backend-deleted",
    },
  });

  const listing = await sessions.backendSessions!(project.id);
  assert.equal(listing.total, 1);
  assert.deepEqual(listing.items, []);
  assert.equal(await store.projection("deleted-session"), undefined);
  await store.close();
});
