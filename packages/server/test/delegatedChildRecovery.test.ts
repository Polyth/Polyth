// Delegated (subagent) child sessions are adopted from OpenCode the instant
// the parent spawns them — before the ephemeral backend session has produced
// any messages, and it is garbage-collected soon after the sub-run ends. The
// child never streams its own terminal turn event, so without explicit
// recovery it stays pinned at working/reconciling/unknown forever and the UI
// can never open it. These tests cover the three seams that keep that from
// happening: the deferred history-import baseline, the parent's task-snapshot
// retirement signal, and the read-time self-heal.
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
  RuntimeSession,
  RuntimeSessionBinding,
  RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
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

const idleSnapshot = (
  binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
  events: RuntimeSnapshot["events"] = [],
  value: "idle" | "running" = "idle",
): RuntimeSnapshot => ({
  authorityId: binding.authorityId,
  generation: binding.generation,
  location: binding.location,
  backendSessionId: binding.backendSessionId!,
  reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
  state: { value, watermark: `${value}-1`, comparison: { domain: "test", order: 1 } },
  completeness: { events: "partial", permissions: "partial", questions: "partial" },
  permissions: [],
  questions: [],
  events,
});

interface Harness {
  runtime: AgentRuntime;
  emit: (sessionId: string, event: RuntimeEvent) => void;
  remote: RuntimeSession[];
  reconcileFor: Map<string, (b: RuntimeSessionBinding & { reconciliationOrdinal?: number }) => RuntimeSnapshot>;
  historyFor: Map<string, Array<{ role: "user" | "assistant"; text: string }>>;
  failCreate: () => void;
}

const makeRuntime = (endpoint: RuntimeEndpoint): Harness => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const remote: RuntimeSession[] = [];
  const reconcileFor = new Map<string, (b: RuntimeSessionBinding & { reconciliationOrdinal?: number }) => RuntimeSnapshot>();
  const historyFor = new Map<string, Array<{ role: "user" | "assistant"; text: string }>>();
  let createFails = false;
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: true,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => {
      if (createFails) throw new Error("child runtime crashed during creation");
      return input.backendSessionId ?? `backend-${input.sessionId}`;
    },
    sessions: async () => remote,
    history: async (backendSessionId: string) => historyFor.get(backendSessionId) ?? [],
    startTurn: async () => undefined,
    abort: async () => undefined,
    replyPermission: async () => undefined,
    replyQuestion: async () => undefined,
    onEvent: (callback: (sessionId: string, event: RuntimeEvent) => void) => {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
    dispose: async () => undefined,
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    reconcile: async (binding: RuntimeSessionBinding & { reconciliationOrdinal?: number }) =>
      (reconcileFor.get(binding.backendSessionId!) ?? ((b) => idleSnapshot(b)))(binding),
  } as AgentRuntime;
  return {
    runtime,
    emit: (sessionId, event) => { for (const listener of listeners) listener(sessionId, event); },
    remote,
    reconcileFor,
    historyFor,
    failCreate: () => { createFails = true; },
  };
};

const makeHarness = (opts: { failedStartupCleanupAllowed?: () => boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delegated-child-"));
  const endpoint = endpointFor(dir);
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "project-1", name: "Project", path: dir, createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === project.id ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => undefined,
  };
  const permissions = {
    evaluate: () => "ask", addRule: () => undefined, rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => undefined, projection: () => undefined };
  const rt = makeRuntime(endpoint);
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => rt.runtime },
    ...(opts.failedStartupCleanupAllowed ? { failedStartupCleanupAllowed: opts.failedStartupCleanupAllowed } : {}),
  });
  return { sessions, store, project, endpoint, ...rt };
};

const childOf = async (
  store: Awaited<ReturnType<typeof makeHarness>>["store"],
  projectId: string,
) => (await store.projections(projectId)).find((row) => row.parentId);

test("a delegated child adopted mid-run defers its history-import baseline", async () => {
  const { sessions, store, project, endpoint, emit, remote, reconcileFor } = makeHarness();

  await store.upsertProjection({
    id: "parent-1",
    projectId: project.id,
    backendSessionId: "be-parent",
    runtimeBinding: persistedBindingFor(endpoint, "be-parent"),
    title: "Redesign the workflow indicator",
    status: "idle",
    model: { providerID: "acme", modelID: "parent" },
    createdAt: 1,
    updatedAt: 1,
  });
  // The subagent backend session exists but has produced nothing yet.
  remote.push({ id: "be-child", title: "Check indicator (@visual subagent)", createdAt: 2, updatedAt: 2, parentId: "be-parent" });
  reconcileFor.set("be-child", (b) => idleSnapshot(b, [], "running"));

  await sessions.activate!("parent-1"); // wire the parent so its runtime events route
  emit("parent-1", {
    type: "subagent/snapshot",
    revision: 1,
    agents: [{ sessionId: "be-child", label: "@visual", status: "running" }],
  });
  emit("parent-1", {
    type: "turn/started",
    turnId: "subagent-turn",
    model: { providerID: "acme", modelID: "temporary" },
  });

  await waitFor(async () => (await childOf(store, project.id)) !== undefined);
  const child = (await childOf(store, project.id))!;
  const events = await store.events(child.id);

  assert.equal(
    events.some((event) => event.type === "session/history-imported"),
    false,
    "an empty adopted child must not record a history import it never made",
  );
  assert.equal(child.runtimeBinding?.historyBaseline, "import", "the import baseline stays pending");
  assert.deepEqual((await store.projection("parent-1"))?.model, { providerID: "acme", modelID: "parent" });
  await store.close();
});

test("a non-child adoption still finalizes its history import on an empty reconcile", async () => {
  const { sessions, store, project, reconcileFor } = makeHarness();
  reconcileFor.set("be-plain", (b) => idleSnapshot(b, []));

  const [imported] = await sessions.importBackendSessions!(project.id, []);
  assert.equal(imported, undefined); // nothing selected

  await store.upsertProjection({
    id: "adopted-plain",
    projectId: project.id,
    backendSessionId: "be-plain",
    runtimeBinding: { ...persistedBindingFor(endpointFor(project.path), "be-plain"), historyBaseline: "import" },
    title: "Adopted top-level session",
    status: "reconciling",
    createdAt: 1,
    updatedAt: 1,
  });

  await sessions.activate!("adopted-plain");

  const events = await store.events("adopted-plain");
  assert.equal(
    events.filter((event) => event.type === "session/history-imported").length,
    1,
    "a top-level adopted session finalizes exactly as before",
  );
  assert.equal((await store.projection("adopted-plain"))?.runtimeBinding?.historyBaseline, undefined);
  await store.close();
});

test("the parent's completed task snapshot retires the delegated child", async () => {
  const { sessions, store, project, endpoint, emit, remote, reconcileFor, historyFor } = makeHarness();

  await store.upsertProjection({
    id: "parent-2",
    projectId: project.id,
    backendSessionId: "be-parent-2",
    runtimeBinding: persistedBindingFor(endpoint, "be-parent-2"),
    title: "Parent",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  remote.push({ id: "be-child-2", title: "Check rail (@visual subagent)", createdAt: 2, updatedAt: 2, parentId: "be-parent-2" });
  reconcileFor.set("be-child-2", (b) => idleSnapshot(b, [], "running"));

  await sessions.activate!("parent-2");
  emit("parent-2", {
    type: "subagent/snapshot",
    revision: 1,
    agents: [{ sessionId: "be-child-2", label: "@visual", status: "running" }],
  });
  await waitFor(async () => (await childOf(store, project.id)) !== undefined);
  const childId = (await childOf(store, project.id))!.id;
  assert.equal((await store.projection(childId))?.status, "working");

  // The sub-run finishes: a fresh reconcile now carries the full transcript,
  // and the parent re-publishes the agent as done.
  historyFor.set("be-child-2", [
    { role: "user", text: "check the rail" },
    { role: "assistant", text: "rail looks aligned" },
  ]);
  reconcileFor.set("be-child-2", (b) => idleSnapshot(b, [
    { entityKey: "part:a1", revision: "1", events: [{ type: "assistant/message", partId: "part:a1", text: "rail looks aligned" }] },
  ]));
  // OpenCode keeps addressing the sub-run by its backend session id; the
  // handler remaps it to the canonical child that already exists.
  emit("parent-2", {
    type: "subagent/snapshot",
    revision: 2,
    agents: [{ sessionId: "be-child-2", label: "@visual", status: "done" }],
  });

  await waitFor(async () => (await store.projection(childId))?.status === "idle");
  const events = await store.events(childId);
  assert.equal(
    events.some((event) => event.type === "session/history-imported"),
    true,
    "the finished transcript is imported while the backend session still exists",
  );
  assert.equal(
    events.filter((event) => event.type === "assistant/message").length,
    1,
  );
  await store.close();
});

test("a failed task snapshot deletes a delegated child that produced no work", async () => {
  const { sessions, store, project, endpoint, emit, remote, reconcileFor } = makeHarness();
  await store.upsertProjection({
    id: "parent-3",
    projectId: project.id,
    backendSessionId: "be-parent-3",
    runtimeBinding: persistedBindingFor(endpoint, "be-parent-3"),
    title: "Parent",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  remote.push({ id: "be-child-3", title: "Broken run (@visual subagent)", createdAt: 2, updatedAt: 2, parentId: "be-parent-3" });
  reconcileFor.set("be-child-3", (b) => idleSnapshot(b, [], "running"));

  await sessions.activate!("parent-3");
  emit("parent-3", {
    type: "subagent/snapshot",
    revision: 1,
    agents: [{ sessionId: "be-child-3", label: "@visual", status: "running" }],
  });
  await waitFor(async () => (await childOf(store, project.id)) !== undefined);
  const childId = (await childOf(store, project.id))!.id;

  emit("parent-3", {
    type: "subagent/snapshot",
    revision: 2,
    agents: [{ sessionId: "be-child-3", label: "@visual", status: "failed" }],
  });
  await waitFor(async () => (await store.projection(childId)) === undefined);
  assert.ok(await store.deletionTombstone(childId), "canonical deletion leaves a tombstone");
  assert.equal((await sessions.list(project.id)).some((row) => row.id === childId), false);
  await store.close();
});

test("a delegated child creation failure deletes its empty canonical session", async () => {
  const { sessions, store, project, failCreate } = makeHarness();
  const parentId = "parent-create-failure";
  const childId = "11111111-1111-4111-8111-111111111111";
  await store.upsertProjection({
    id: parentId,
    projectId: project.id,
    title: "Parent",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  failCreate();

  await assert.rejects(
    sessions.create({ projectId: project.id, id: childId, parentId, title: "Crashed child" }),
    /upstream outcome is unknown; reconciliation is required/,
  );
  assert.equal(await store.projection(childId), undefined);
  assert.ok(await store.deletionTombstone(childId), "failed child creation is fenced by a tombstone");
  await store.close();
});

test("activation and startup recovery settle a child stranded by a restart; bare reads never do", async () => {
  const { sessions, store, project, endpoint } = makeHarness();

  // The exact zombie shape: adopted, reconciled once, zero messages, and left
  // pinned. One is `working` (never re-reconciled), one is `unknown` (a later
  // restart could not verify the now-gone backend session).
  for (const [id, status] of [["zombie-working", "working"], ["zombie-unknown", "unknown"]] as const) {
    await store.upsertProjection({
      id,
      projectId: project.id,
      parentId: "some-parent",
      backendSessionId: `be-${id}`,
      runtimeBinding: persistedBindingFor(endpoint, `be-${id}`),
      title: "Check something (@visual subagent)",
      status,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.append(id, "session/imported", { backendSessionId: `be-${id}` }, { ignorable: true });
    await store.append(id, "session/history-imported", {}, { ignorable: true });
  }
  // A healthy top-level working session must be left untouched.
  await store.upsertProjection({
    id: "top-level-working",
    projectId: project.id,
    backendSessionId: "be-top",
    runtimeBinding: persistedBindingFor(endpoint, "be-top"),
    title: "Active top-level turn",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });

  // Persisted reads never settle a child: the zombie shape is still visible.
  const before = await sessions.list(project.id);
  assert.equal(before.find((row) => row.id === "zombie-working")?.status, "working");
  assert.equal((await sessions.snapshot("zombie-unknown")).status, "unknown");

  // Opening a session activates it, which settles that child and no other.
  await sessions.activate!("zombie-unknown");
  assert.equal((await sessions.snapshot("zombie-unknown")).status, "idle");
  assert.equal((await sessions.snapshot("zombie-working")).status, "working");

  // Startup recovery settles the rest of the children a restart stranded.
  await sessions.recoverPendingWork();
  const listed = await sessions.list(project.id);
  assert.equal(listed.find((row) => row.id === "zombie-working")?.status, "idle");
  assert.equal(listed.find((row) => row.id === "zombie-unknown")?.status, "idle");
  assert.equal(listed.find((row) => row.id === "top-level-working")?.status, "working");
  assert.equal((await sessions.snapshot("zombie-working")).status, "idle");
  await store.close();
});

test("a delegated child mid-exchange is not retired by a bare read", async () => {
  const { sessions, store, project, endpoint } = makeHarness();
  await store.upsertProjection({
    id: "child-awaiting",
    projectId: project.id,
    parentId: "some-parent",
    backendSessionId: "be-awaiting",
    runtimeBinding: persistedBindingFor(endpoint, "be-awaiting"),
    title: "Waiting on input (@visual subagent)",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.append("child-awaiting", "user/message", { text: "please continue" });

  assert.equal((await sessions.snapshot("child-awaiting")).status, "working");
  await store.close();
});

test("list and snapshot do not rescan settled delegated children", async () => {
  const { sessions, store, project, endpoint } = makeHarness();
  await store.upsertProjection({
    id: "child-settled",
    projectId: project.id,
    parentId: "some-parent",
    backendSessionId: "be-settled",
    runtimeBinding: persistedBindingFor(endpoint, "be-settled"),
    title: "Completed delegated task (@visual subagent)",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  const originalEvents = store.events;
  let eventReads = 0;
  store.events = async (...args) => {
    eventReads += 1;
    return originalEvents(...args);
  };

  assert.equal((await sessions.list(project.id)).some((row) => row.id === "child-settled"), true);
  assert.equal((await sessions.snapshot("child-settled")).status, "idle");
  assert.equal(eventReads, 0, "settled children do not need transcript scans on metadata reads");
  await store.close();
});

// "Delete failed startup sessions" (product.autoDeleteFailedStartupSessions)
// is the user's choice; with it off no automatic path removes a child.
test("with failed-startup cleanup off a delegated creation failure stays visible", async () => {
  const { sessions, store, project, failCreate } = makeHarness({ failedStartupCleanupAllowed: () => false });
  const parentId = "parent-create-failure-kept";
  const childId = "22222222-2222-4222-8222-222222222222";
  await store.upsertProjection({ id: parentId, projectId: project.id, title: "Parent", status: "working", createdAt: 1, updatedAt: 1 });
  failCreate();

  await assert.rejects(sessions.create({ projectId: project.id, id: childId, parentId, title: "Crashed child" }));
  // The create outcome is uncertain, so the row stays as `unknown`, not deleted.
  assert.equal((await store.projection(childId))?.status, "unknown");
  assert.equal(await store.deletionTombstone(childId), undefined);
  await store.close();
});

test("with failed-startup cleanup off a failed task snapshot keeps the empty child", async () => {
  const { sessions, store, project, endpoint, emit, remote, reconcileFor } = makeHarness({ failedStartupCleanupAllowed: () => false });
  await store.upsertProjection({
    id: "parent-kept", projectId: project.id, backendSessionId: "be-parent-kept",
    runtimeBinding: persistedBindingFor(endpoint, "be-parent-kept"), title: "Parent", status: "idle", createdAt: 1, updatedAt: 1,
  });
  remote.push({ id: "be-child-kept", title: "Broken run (@visual subagent)", createdAt: 2, updatedAt: 2, parentId: "be-parent-kept" });
  reconcileFor.set("be-child-kept", (b) => idleSnapshot(b, [], "running"));

  await sessions.activate!("parent-kept");
  emit("parent-kept", { type: "subagent/snapshot", revision: 1, agents: [{ sessionId: "be-child-kept", label: "@visual", status: "running" }] });
  await waitFor(async () => (await childOf(store, project.id)) !== undefined);
  const childId = (await childOf(store, project.id))!.id;

  emit("parent-kept", { type: "subagent/snapshot", revision: 2, agents: [{ sessionId: "be-child-kept", label: "@visual", status: "failed" }] });
  await waitFor(async () => (await store.projection(childId))?.status === "failed");
  await settle();
  assert.ok(await store.projection(childId), "the child is not deleted");
  assert.equal(await store.deletionTombstone(childId), undefined);
  assert.equal((await sessions.list(project.id)).some((row) => row.id === childId), true);
  await store.close();
});

// The 2026-10-09 incident shape: agent.spawn delivered a prompt, the first
// turn stopped `rate-limited`, and no assistant/tool event followed.
const seedRateLimitedChild = async (
  store: Awaited<ReturnType<typeof makeHarness>>["store"],
  projectId: string,
  id: string,
  endpoint: RuntimeEndpoint,
) => {
  await store.upsertProjection({
    id, projectId, parentId: "spawning-parent", backendSessionId: `be-${id}`,
    runtimeBinding: persistedBindingFor(endpoint, `be-${id}`), title: "Spawned worker", status: "failed", createdAt: 1, updatedAt: 1,
  });
  await store.append(id, "session/created", {}, { ignorable: true });
  await store.append(id, "user/message", { text: "do the task" });
  await store.append(id, "turn/started", { turnId: "turn-1" });
  await store.append(id, "turn/stopped", { turnId: "turn-1", reason: "error", code: "rate-limited", message: "You've hit your session limit" });
};

for (const allowed of [false, true]) {
  test(`a rate-limited delegated child keeps its failure evidence (cleanup ${allowed ? "on" : "off"})`, async () => {
    const { sessions, store, project, endpoint } = makeHarness({ failedStartupCleanupAllowed: () => allowed });
    await seedRateLimitedChild(store, project.id, "rate-limited-child", endpoint);

    await sessions.activate!("rate-limited-child").catch(() => undefined);
    await sessions.recoverPendingWork();
    await settle();
    assert.ok(await store.projection("rate-limited-child"), "the child is not deleted");
    assert.equal(await store.deletionTombstone("rate-limited-child"), undefined);
    assert.ok((await store.events("rate-limited-child")).some((event) => event.type === "turn/stopped"));
    await store.close();
  });
}

test("with failed-startup cleanup on a never-prompted failed child is still settled", async () => {
  const { sessions, store, project, endpoint } = makeHarness({ failedStartupCleanupAllowed: () => true });
  await store.upsertProjection({
    id: "never-prompted", projectId: project.id, parentId: "spawning-parent", backendSessionId: "be-never-prompted",
    runtimeBinding: persistedBindingFor(endpoint, "be-never-prompted"), title: "Spawned worker", status: "failed", createdAt: 1, updatedAt: 1,
  });
  await store.append("never-prompted", "session/created", {}, { ignorable: true });

  await sessions.activate!("never-prompted").catch(() => undefined);
  await waitFor(async () => (await store.projection("never-prompted")) === undefined);
  assert.ok(await store.deletionTombstone("never-prompted"));
  await store.close();
});
