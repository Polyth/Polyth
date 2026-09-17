import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentRuntime,
  OpenCodeTransport,
  PersistedRuntimeBinding,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEvent,
  RuntimeLifecycleNotification,
  RuntimeObservation,
  RuntimeSessionBinding,
  RuntimeSnapshot,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import {
  createTranslateState,
  normalizeOcObservation,
} from "../../backend-opencode/src/events.ts";
import { createLegacyProtocolAdapter } from "../../backend-opencode/src/protocolLegacy.ts";
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
  toolExecutionTimeoutMs?: number,
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
      ...(toolExecutionTimeoutMs === undefined ? {} : { toolExecutionTimeoutMs }),
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
  assert.equal((await store.projection("session-prefetch"))?.updatedAt, 1,
    "opening an idle session does not count as activity");
  await store.close();
});

test("simultaneous session materialization joins one native attach flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-single-flight-"));
  const endpoint = endpointFor(dir);
  let materializations = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "idle", watermark: "single-flight" },
    completeness: { events: "complete", permissions: "complete", questions: "complete" },
    events: [],
  }));
  runtime.ensureSession = async (input) => {
    materializations += 1;
    await gate;
    return input.backendSessionId!;
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-single-flight";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-single-flight",
    runtimeBinding: persistedBindingFor(endpoint, "backend-single-flight"),
    title: "Single flight",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  const readers = Array.from({ length: 6 }, () => sessions.events(sessionId, 0));
  await waitFor(() => materializations === 1);
  release();
  await Promise.all(readers);
  assert.equal(materializations, 1);
  await store.close();
});

test("materialization rejection backoff is bypassed by runtime generation change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-generation-recovery-"));
  let generation = 7;
  const endpoint = endpointFor(dir);
  let materializations = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "idle", watermark: `generation-${binding.generation}` },
    completeness: { events: "complete", permissions: "complete", questions: "complete" },
    events: [],
  }));
  runtime.endpoint = async () => ({ ...endpoint, generation });
  runtime.ensureSession = async (input) => {
    materializations += 1;
    if (generation === 7) {
      throw Object.assign(new Error('runtime rejected "thread/resume": active writer'), {
        code: "runtime-rejected",
        rpcMethod: "thread/resume",
        rpcCode: -32600,
        remoteMessage: "active writer",
      });
    }
    return input.backendSessionId!;
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-generation-recovery";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-generation-recovery",
    runtimeBinding: persistedBindingFor(endpoint, "backend-generation-recovery"),
    title: "Generation recovery",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  await Promise.all(Array.from({ length: 4 }, () => sessions.events(sessionId, 0)));
  assert.equal(materializations, 1, "concurrent callers join the rejected flight");
  await sessions.events(sessionId, 0);
  assert.equal(materializations, 1, "same-generation reads observe bounded failure backoff");

  generation = 8;
  await sessions.events(sessionId, 0);
  assert.equal(materializations, 2, "a new runtime generation retries immediately");
  assert.equal((await store.projection(sessionId))?.runtimeBinding?.generation, 8);
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
  // Admission stays closed, but the message is preserved instead of rejected.
  assert.equal((await sessions.send("session-unversioned-idle", { text: "must not run" })).queued, true);
  assert.equal(submissions, 0);
  await store.close();
});

test("a blocked reconciliation queues a new message instead of rejecting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-queue-blocked-"));
  const endpoint = endpointFor(dir);
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
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
  }));
  runtime.startTurn = async () => { submissions += 1; };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-queue-blocked";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-queue-blocked",
    runtimeBinding: persistedBindingFor(endpoint, "backend-queue-blocked"),
    title: "Blocked reconciliation",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  const reconciliation = await store.startReconciliation(sessionId);
  await store.settleReconciliation(sessionId, reconciliation.ordinal, "blocked", "unknown outcome");

  const result = await sessions.send(sessionId, { text: "do not lose this" });

  assert.equal(result.queued, true);
  assert.equal(submissions, 0);
  assert.deepEqual((await store.queueList(sessionId)).map((item) => item.text), ["do not lose this"]);
  await store.close();
});

test("an in-flight reconciliation queues a new message instead of rejecting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-queue-active-"));
  const endpoint = endpointFor(dir);
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
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
  }));
  runtime.startTurn = async () => { submissions += 1; };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-queue-active";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-queue-active",
    runtimeBinding: persistedBindingFor(endpoint, "backend-queue-active"),
    title: "Active reconciliation",
    status: "reconciling",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.startReconciliation(sessionId);

  const result = await sessions.send(sessionId, { text: "nudge while reconciling" });

  assert.equal(result.queued, true);
  assert.equal(submissions, 0);
  assert.deepEqual((await store.queueList(sessionId)).map((item) => item.text), ["nudge while reconciling"]);
  await store.close();
});

test("a follow-up steer is durably queued while restart reconciliation is blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-queue-blocked-steer-"));
  const endpoint = endpointFor(dir);
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
  runtime.startTurn = async () => { submissions += 1; };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-queue-blocked-steer";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-queue-blocked-steer",
    runtimeBinding: persistedBindingFor(endpoint, "backend-queue-blocked-steer"),
    title: "Blocked reconciliation steer",
    // The web composer chooses follow-up delivery from this working state.
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  const reconciliation = await store.startReconciliation(sessionId);
  await store.settleReconciliation(sessionId, reconciliation.ordinal, "blocked", "runtime was replaced");

  const result = await sessions.send(sessionId, {
    text: "keep investigating after recovery",
    delivery: "steer",
  });

  assert.equal(result.queued, true);
  assert.equal(submissions, 0);
  assert.deepEqual(
    (await store.queueList(sessionId)).map((item) => ({ text: item.text, delivery: item.delivery })),
    [{ text: "keep investigating after recovery", delivery: "steer" }],
  );
  assert.equal(
    ((await store.events(sessionId)).findLast((event) => event.type === "delivery/fallback-queued")?.data as {
      reason?: string;
    } | undefined)?.reason,
    "reconciliation-blocked",
  );
  await store.close();
});

test("a locally stopped turn is not wedged back to unknown when the backend is unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-stopped-unknown-"));
  const endpoint = endpointFor(dir);
  let submissions = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "unknown" },
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
  const sessionId = "session-stopped-unknown";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-stopped-unknown",
    runtimeBinding: persistedBindingFor(endpoint, "backend-stopped-unknown"),
    title: "Stopped before re-attach",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "turn/started", { turnId: "stopped-unknown-1" });
  await store.append(sessionId, "turn/stopped", { turnId: "stopped-unknown-1", reason: "aborted" });

  await sessions.events(sessionId, 0);

  // The durable stop is authoritative: reconciliation must not resurrect
  // `unknown` (which would leave a dead Stop button in the UI).
  assert.equal((await store.projection(sessionId))?.status, "idle");
  await sessions.send(sessionId, { text: "continue after stop" });
  assert.equal(submissions, 1);
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

test("interrupt send-now dispatches even when the abort outcome is unknown and the stop arrives late", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-interrupt-unknown-"));
  const endpoint = endpointFor(dir);
  let active = false;
  let submissions = 0;
  let statusOrder = 0;
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const emit = (sessionId: string, ev: RuntimeEvent) => { for (const l of listeners) l(sessionId, ev); };
  const runtime: AgentRuntime = {
    ...runtimeWithSnapshot(endpoint, (binding) => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      // ACP-style: the prompt is still running while cancellation is in flight.
      state: { value: active ? "running" : "idle", comparison: { domain: "acp-status", order: ++statusOrder } },
      completeness: { events: "partial", permissions: "partial", questions: "partial" },
      permissions: [],
      questions: [],
      events: [],
    })),
    startTurn: async (req) => {
      submissions += 1;
      active = true;
      emit(req.sessionId, { type: "turn/started", turnId: `t${submissions}` });
    },
    abortOperation: async (_sid, operationId) => ({
      kind: "unknown" as const,
      operationId,
      message: "ACP cancellation has no acknowledgement; waiting for the prompt result",
    }),
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
  };
  const { sessions, store } = makeHarness(runtime, dir);
  const { id } = await sessions.create({ projectId: "project-1", title: "Interrupt unknown" });
  await sessions.send(id, { text: "turn" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const queued = await sessions.send(id, { text: "later", delivery: "queue" });
  assert.equal(queued.queued, true);
  await sessions.queueSendNow!(id, queued.queueId!, "urgent");

  // Cancellation in flight: reconciliation observes the runtime still running,
  // then the cancelled prompt finally emits its terminal stop.
  await new Promise((resolve) => setTimeout(resolve, 20));
  active = false;
  emit(id, { type: "turn/stopped", turnId: "t1", reason: "aborted" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(submissions, 2, "the urgent message must dispatch after the late aborted stop");
  assert.deepEqual(await sessions.queueList!(id), []);
  await store.close();
});

test("send queues behind an unknown turn when replacement is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-orphaned-turn-"));
  const endpoint = endpointFor(dir);
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

  // The orphaned turn must not be resent, but the new message must survive:
  // it waits in the durable queue until the session is admissible again.
  const result = await sessions.send(sessionId, { text: "continue after restart" });
  assert.equal(result.queued, true);
  assert.equal((await sessions.queueList(sessionId))[0]?.text, "continue after restart");

  assert.deepEqual(
    (await store.events(sessionId)).filter((event) => event.type.startsWith("turn/")).map((event) => event.type),
    ["turn/started"],
  );
  assert.equal(submissions, 0);
  await store.close();
});

test("normal send replaces an unrecovered unknown backend and reuses confirmed history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-unknown-replacement-"));
  const endpoint: RuntimeEndpoint = {
    ...endpointFor(dir),
    control: { kind: "owned", instanceToken: "same-authority" },
  };
  let resetOperationId: string | undefined;
  const submitted: string[] = [];
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: resetOperationId
      ? { value: "idle", causalOperationId: resetOperationId }
      : { value: "unknown" },
    completeness: { events: "partial", permissions: "partial", questions: "partial" },
    permissions: [],
    questions: [],
    events: [],
  }));
  runtime.resetSessionOperation = async (_input, operationId) => {
    resetOperationId = operationId;
    return {
      kind: "confirmed",
      value: { backendSessionId: "backend-replacement" },
      receipt: "backend-replacement",
    };
  };
  runtime.startTurnOperation = async (request) => {
    submitted.push(request.text);
    return { kind: "confirmed", value: {} };
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-unknown-replacement";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-old",
    runtimeBinding: persistedBindingFor(endpoint, "backend-old"),
    title: "Unknown replacement",
    status: "unknown",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "user/message", { text: "confirmed prior request" });
  await store.append(sessionId, "assistant/message", { partId: "prior", text: "confirmed prior answer" });
  const stranded = await store.prepareOperation({
    sessionId,
    mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text: "uncertain old request" } },
  });
  await store.claimOperation(stranded.operation.operationId);
  await store.append(sessionId, "turn/started", { turnId: "stranded-1" });

  await sessions.send(sessionId, { text: "new request" });

  assert.equal(submitted.length, 1);
  assert.match(submitted[0]!, /confirmed prior request/);
  assert.doesNotMatch(submitted[0]!, /uncertain old request/);
  assert.match(submitted[0]!, /new request$/);
  assert.deepEqual(
    (await store.events(sessionId)).filter((event) => event.type.startsWith("turn/")).map((event) => event.type),
    ["turn/started", "turn/stopped"],
  );
  assert.equal((await store.projection(sessionId))?.backendSessionId, "backend-replacement");
  assert.equal((await store.projection(sessionId))?.runtimeBinding?.epoch, 1);
  assert.equal(
    (await store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
    true,
  );
  assert.equal((await store.operation(stranded.operation.operationId))?.state, "unknown");
  await store.close();
});

test("Stop always closes the turn even when the backend abort outcome is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-stop-unknown-"));
  const endpoint = endpointFor(dir);
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
  // The stranded backend cannot be reached to acknowledge the abort.
  runtime.abort = async () => { throw new Error("backend unreachable after restart"); };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-stop-unknown";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-stop-unknown",
    runtimeBinding: persistedBindingFor(endpoint, "backend-stop-unknown"),
    title: "Stop unknown",
    status: "unknown",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "turn/started", { turnId: "stranded-1" });

  await sessions.abort(sessionId); // must not throw

  const turnEvents = (await store.events(sessionId))
    .filter((event) => event.type.startsWith("turn/"))
    .map((event) => event.type);
  assert.deepEqual(turnEvents, ["turn/started", "turn/abort-requested", "turn/stopped"]);
  const stop = (await store.events(sessionId)).find((event) => event.type === "turn/stopped");
  assert.equal((stop?.data as { reason?: string }).reason, "aborted");
  await store.close();
});

test("steer preserves an unknown turn and drains queued messages only after verified idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-steer-unknown-"));
  const endpoint = endpointFor(dir);
  const submitted: string[] = [];
  let state: RuntimeSnapshot["state"] = { value: "unknown" };
  let notifyLifecycle: ((notification: RuntimeLifecycleNotification) => void) | undefined;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state,
    completeness: { events: "partial", permissions: "partial", questions: "partial" },
    permissions: [],
    questions: [],
    events: [],
  }));
  let emit: ((sessionId: string, event: RuntimeEvent) => void) | undefined;
  runtime.onEvent = (callback) => {
    emit = callback;
    return { dispose: () => { emit = undefined; } };
  };
  runtime.onLifecycle = (callback) => {
    notifyLifecycle = callback;
    return { dispose: () => { notifyLifecycle = undefined; } };
  };
  runtime.startTurn = async (request) => {
    submitted.push(request.text);
    emit!(request.sessionId, { type: "turn/started", turnId: `next-${submitted.length}` });
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-steer-unknown";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-steer-unknown",
    runtimeBinding: persistedBindingFor(endpoint, "backend-steer-unknown"),
    title: "Steer unknown",
    status: "unknown",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append(sessionId, "turn/started", { turnId: "stranded-1" });

  await sessions.events(sessionId, 0);
  const first = await sessions.send(sessionId, { text: "continue", delivery: "queue" });
  const second = await sessions.send(sessionId, { text: "go left instead", delivery: "steer" });
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.deepEqual(submitted, []);
  assert.deepEqual((await store.events(sessionId))
    .filter((event) => event.type.startsWith("turn/")).map((event) => event.type), ["turn/started"]);
  assert.equal((await store.projection(sessionId))?.status, "unknown");
  assert.equal((await store.reconciliation(sessionId))?.state, "unknown");
  assert.deepEqual((await store.queueList(sessionId)).map((item) => item.text), ["continue", "go left instead"]);

  state = { value: "idle", comparison: { domain: "test-status", order: 1 } };
  notifyLifecycle!({ type: "stream-connected" });
  await waitFor(async () => (await store.events(sessionId)).some((event) =>
    event.type === "turn/started" && event.data.turnId === "next-1"));
  assert.deepEqual(submitted, ["continue"]);
  emit!(sessionId, { type: "turn/stopped", turnId: "next-1", reason: "completed" });
  await waitFor(async () => (await store.events(sessionId)).some((event) =>
    event.type === "turn/started" && event.data.turnId === "next-2"));
  assert.deepEqual(submitted, ["continue", "go left instead"]);
  assert.deepEqual(await store.queueList(sessionId), []);
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
  // Blocked admission queues the message; it must not reach the runtime.
  assert.equal((await sessions.send(sessionId, { text: "must stay blocked" })).queued, true);
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
            events: [{
              type: "assistant/message",
              partId: `part:${binding.backendSessionId}`,
              text: binding.backendSessionId === "backend-child"
                ? "copied answer"
                : "imported answer",
            }],
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
        events: [{ type: "assistant/message", partId: "assistant-part-1", text: "first" }],
      },
      {
        entityKey: "assistant-part-2",
        revision: "revision-1",
        events: [{ type: "assistant/message", partId: "assistant-part-2", text: "second" }],
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
  assert.equal(uncertainty?.producerPlugin, "runtime");
  await store.close();
});

test("tool watchdog aborts a stuck execution and records the failure for the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tool-watchdog-"));
  const endpoint = endpointFor(dir);
  let listener: ((sessionId: string, event: RuntimeEvent) => void) | undefined;
  let aborts = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "running" },
    completeness: { events: "partial", permissions: "partial", questions: "partial" },
    events: [],
  }));
  runtime.onEvent = (callback) => {
    listener = callback;
    return { dispose: () => { listener = undefined; } };
  };
  runtime.abort = async () => { aborts += 1; };
  const { sessions, store, project } = makeHarness(runtime, dir, 25);
  await store.upsertProjection({
    id: "session-stuck-tool",
    projectId: project.id,
    backendSessionId: "backend-stuck-tool",
    runtimeBinding: persistedBindingFor(endpoint, "backend-stuck-tool"),
    title: "Stuck tool",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  await sessions.events("session-stuck-tool", 0);
  assert.ok(listener);
  listener("session-stuck-tool", { type: "turn/started", turnId: "turn-stuck" });
  listener("session-stuck-tool", {
    type: "tool/started",
    callId: "call-stuck",
    tool: "bash",
    input: { command: "sleep forever" },
  });

  await waitFor(async () => (await store.events("session-stuck-tool"))
    .some((event) => event.type === "tool/error"));
  const events = await store.events("session-stuck-tool");
  assert.equal(aborts, 1);
  assert.match(
    String((events.find((event) => event.type === "tool/error")?.data as { error?: unknown })?.error),
    /stopped after exceeding the 25ms execution safety limit/,
  );
  assert.equal(events.at(-1)?.type, "turn/stopped");
  assert.equal((await store.projection("session-stuck-tool"))?.status, "idle");
  await store.close();
});

test("a pending question survives watchdog rehydration and remains answerable after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-question-restart-"));
  const endpoint = endpointFor(dir);
  const sessionId = "session-question-restart";
  const seed = createStore(join(dir, "sessions.db"));
  await seed.upsertProjection({
    id: sessionId,
    projectId: "project-1",
    backendSessionId: "backend-question-restart",
    runtimeBinding: persistedBindingFor(endpoint, "backend-question-restart"),
    title: "Pending question",
    status: "waiting",
    createdAt: 1,
    updatedAt: 1,
  });
  await seed.append(sessionId, "turn/started", { turnId: "turn-question" });
  await seed.append(sessionId, "tool/started", {
    callId: "call-question",
    tool: "question",
    input: { questions: [{ question: "Continue?" }] },
  });
  await seed.append(sessionId, "question/asked", {
    requestId: "question-restart",
    questions: [{ id: "continue", question: "Continue?" }],
  });
  await seed.close();

  let aborts = 0;
  let replies = 0;
  const runtime = runtimeWithSnapshot(endpoint, (binding) => ({
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId!,
    reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
    state: { value: "running" },
    completeness: { events: "complete", permissions: "complete", questions: "complete" },
    permissions: [],
    questions: [{
      requestId: "question-restart",
      questions: [{ id: "continue", question: "Continue?" }],
    }],
    events: [],
  }));
  runtime.abort = async () => { aborts += 1; };
  runtime.replyQuestion = async (_id, requestId) => {
    assert.equal(requestId, "question-restart");
    replies += 1;
  };

  const { sessions, store } = makeHarness(runtime, dir, 25);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(aborts, 0);
  await sessions.replyQuestion(sessionId, "question-restart", { continue: "yes" });
  assert.equal(replies, 1);
  assert.equal((await store.events(sessionId)).some((event) => event.type === "question/answered"), true);
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

// ---------------------------------------------------------------- incident
// A Polyth restart reattached a live OpenCode session and the pull rebuilt the
// whole native transcript as new canonical history (~217 duplicated events).
// These run the real OpenCode normalization on both paths: live SSE through the
// AgentRuntime observation seam, recovery through the real legacy pull.

const TOOL_OUTPUT = "Wrote file successfully.";

const incidentPart = (kind: "tool" | "text", state: Record<string, unknown>) =>
  kind === "tool"
    ? {
        id: "part-tool-a",
        callID: "call-tool-a",
        messageID: "msg-assistant-a",
        sessionID: "backend-tool",
        type: "tool",
        tool: "write",
        state,
      }
    : {
        id: "part-text-a",
        messageID: "msg-assistant-a",
        sessionID: "backend-tool",
        type: "text",
        text: state.text,
        time: state.time,
      };

/** Final native state, which is all a restarted pull can see. */
const COMPLETED_HISTORY = [{
  info: { id: "msg-assistant-a", role: "assistant", sessionID: "backend-tool" },
  parts: [
    incidentPart("tool", { status: "completed", input: { filePath: "marker.txt" }, output: TOOL_OUTPUT }),
    incidentPart("text", { text: "done", time: { start: 1, end: 2 } }),
  ],
}];

const incidentHarness = async (livePartStates: Array<["tool" | "text", Record<string, unknown>]>) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-reconciliation-incident-"));
  const endpoint = endpointFor(dir);
  // Native history only becomes visible once the live turn is over, exactly as
  // a restart sees it: the earlier lifecycle states are gone.
  let history: unknown[] = [];
  const transport: OpenCodeTransport = {
    async query<T>(request: { method: "GET" | "HEAD"; path: string; deadlineMs: number }): Promise<T> {
      if (request.path.startsWith("/session/status")) {
        return { "backend-tool": { type: "busy" } } as T;
      }
      if (request.path.startsWith("/session/backend-tool/message")) return history as T;
      return [] as T;
    },
    async mutate() {
      throw new Error("reconciliation must not mutate");
    },
    async stream() {},
  };
  const adapter = createLegacyProtocolAdapter({ transport, endpoint, promptPaths: ["prompt_async"] });
  let observe: ((sessionId: string, observation: RuntimeObservation) => void) | undefined;
  const runtime: AgentRuntime = {
    ...runtimeWithSnapshot(endpoint, () => {
      throw new Error("this runtime reconciles through the real OpenCode pull");
    }),
    reconcile: (binding) => adapter.reconcile(binding),
    onObservation: (callback) => {
      observe = callback;
      return { dispose: () => { observe = undefined; } };
    },
  };
  const { sessions, store, project } = makeHarness(runtime, dir);
  const sessionId = "session-tool";
  await store.upsertProjection({
    id: sessionId,
    projectId: project.id,
    backendSessionId: "backend-tool",
    runtimeBinding: persistedBindingFor(endpoint, "backend-tool"),
    title: "Tool",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  // A fresh session service is exactly what a Polyth restart produces: the
  // durable store survives, every in-memory translation state does not.
  const restart = async (service = sessions) => {
    history = COMPLETED_HISTORY;
    const before = (await store.reconciliation(sessionId))?.ordinal ?? 0;
    await service.events(sessionId, 0);
    await waitFor(async () => ((await store.reconciliation(sessionId))?.ordinal ?? 0) > before
      || (await store.reconciliation(sessionId))?.state === "ready");
    return store.events(sessionId);
  };
  const restarted = () => createSessionService({
    store,
    projects: {
      list: async () => [project],
      get: async (id) => id === project.id ? project : undefined,
      add: async () => project,
      create: async () => project,
      remove: async () => undefined,
    } as ProjectService,
    permissions: {
      evaluate: () => "ask",
      addRule: () => undefined,
      rules: () => [],
    } as unknown as PermissionService,
    broadcast: { event: () => undefined, projection: () => undefined } as Broadcaster,
    queue: store,
    runtimes: { forProject: async () => runtime },
  });

  await sessions.events(sessionId, 0);
  assert.ok(observe, "the runtime observation seam was not wired");
  const liveState = createTranslateState();
  const derived = (events: readonly SessionEvent[]) => events
    .filter((event) =>
      !event.type.startsWith("reconciliation/") && !event.type.startsWith("runtime/"))
    .map((event) => event.type);
  const settle = async () => {
    let last = -1;
    let stable = 0;
    await waitFor(async () => {
      const count = (await store.events(sessionId)).length;
      if (count === last) stable += 1;
      else {
        last = count;
        stable = 0;
      }
      return stable >= 3;
    });
  };
  const emitLive = async (
    parts: Array<["tool" | "text", Record<string, unknown>]>,
    state = createTranslateState(),
  ) => {
    const current = await store.reconciliation(sessionId);
    assert.ok(current);
    assert.ok(observe, "the runtime observation seam was not wired");
    const binding = {
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      location: endpoint.location,
      backendSessionId: "backend-tool",
      reconciliationOrdinal: current.ordinal,
    };
    for (const [kind, partState] of parts) {
      const normalized = normalizeOcObservation({
        data: {
          type: "message.part.updated",
          properties: { sessionID: "backend-tool", part: incidentPart(kind, partState) },
        },
        channel: "sse",
        observed: binding,
        current: binding,
        state,
      });
      assert.equal(normalized.kind, "accepted");
      if (normalized.kind !== "accepted") throw new Error("live observation was not accepted");
      observe(sessionId, normalized.observation);
    }
    await settle();
  };

  if (livePartStates.length) await emitLive(livePartStates, liveState);

  return {
    store,
    restart,
    restarted,
    derived,
    emitLive,
    live: await store.events(sessionId),
    entities: async () => (await store.observationCheckpoints({
      authorityId: endpoint.authorityId,
      location: endpoint.location,
      backendSessionId: "backend-tool",
    }))
      .filter((checkpoint) => checkpoint.key.artifactKind !== "status")
      .map((checkpoint) => `${checkpoint.key.artifactKind}:${checkpoint.key.entityId}:${checkpoint.revision}`)
      .sort(),
  };
};

test("a restarted pull re-derives no canonical fact the live stream already recorded", async () => {
  const harness = await incidentHarness([
    ["tool", { status: "pending" }],
    ["tool", { status: "completed", input: { filePath: "marker.txt" }, output: TOOL_OUTPUT }],
    ["text", { text: "done", time: { start: 1, end: 2 } }],
  ]);
  assert.deepEqual(
    harness.derived(harness.live),
    ["tool/call", "tool/result", "assistant/chunk", "assistant/message"],
  );

  const afterRestart = await harness.restart(harness.restarted());

  assert.deepEqual(
    harness.derived(afterRestart),
    harness.derived(harness.live),
    "the recovery pull re-appended native history Polyth already held",
  );
  assert.deepEqual(await harness.entities(), [
    "part:part-text-a:complete:2",
    "tool:call-tool-a:state:completed",
  ]);
  await harness.store.close();
});

test("a restarted pull recovers the terminal fact a partial live lifecycle missed", async () => {
  const harness = await incidentHarness([["tool", { status: "pending" }]]);
  assert.deepEqual(harness.derived(harness.live), ["tool/call"]);

  const afterRestart = await harness.restart(harness.restarted());

  assert.deepEqual(
    afterRestart.filter((event) => event.type === "tool/call").length,
    1,
    "the already known tool call was duplicated by recovery",
  );
  const results = afterRestart.filter((event) => event.type === "tool/result");
  assert.equal(results.length, 1, "the missing tool result was not recovered exactly once");
  assert.equal(results[0]?.data.output, TOOL_OUTPUT);
  assert.equal(
    afterRestart.filter((event) => event.type === "assistant/message").length,
    1,
  );
  await harness.store.close();
});

test("pull-only recovery appends every derived fact once and stays idempotent", async () => {
  const harness = await incidentHarness([]);
  assert.deepEqual(harness.derived(harness.live), []);

  const recovered = await harness.restart(harness.restarted());
  assert.deepEqual(
    harness.derived(recovered),
    ["tool/call", "tool/result", "assistant/chunk", "assistant/message"],
  );

  const again = await harness.restart(harness.restarted());
  assert.deepEqual(harness.derived(again), harness.derived(recovered));
  await harness.store.close();
});

test("pull-first then late live SSE still keeps each native fact once", async () => {
  const harness = await incidentHarness([]);
  const recovered = await harness.restart(harness.restarted());
  const expected = harness.derived(recovered);

  await harness.emitLive([
    ["tool", { status: "pending" }],
    ["tool", { status: "completed", input: { filePath: "marker.txt" }, output: TOOL_OUTPUT }],
    ["text", { text: "done", time: { start: 1, end: 2 } }],
  ]);

  assert.deepEqual(harness.derived(await harness.store.events("session-tool")), expected);
  await harness.store.close();
});

test("older pending after a completed source does not duplicate the call", async () => {
  const harness = await incidentHarness([
    ["tool", { status: "pending" }],
    ["tool", { status: "completed", input: { filePath: "marker.txt" }, output: TOOL_OUTPUT }],
  ]);
  assert.equal(harness.live.filter((event) => event.type === "tool/call").length, 1);

  await harness.emitLive([["tool", { status: "pending" }]]);

  const events = await harness.store.events("session-tool");
  assert.equal(events.filter((event) => event.type === "tool/call").length, 1);
  assert.equal(events.filter((event) => event.type === "tool/result").length, 1);
  await harness.store.close();
});
