// WS22: projection.model is the user/session choice — subagent/child activity
// must never overwrite it. WS23: permission/question pending → waiting; resolve
// → idle/working; turn/stopped with open requests stays waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeSession, RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import { createAutoAcceptStore, type PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
};

function makeRuntime(opts: { subagents?: boolean } = {}) {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const remote: RuntimeSession[] = [];
  const endpoint: RuntimeEndpoint = {
    authorityId: "fake-runtime",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/fake" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, ev);
  };
  const rt: AgentRuntime & {
    endpoint(): Promise<RuntimeEndpoint>;
    reconcile(b: RuntimeSessionBinding & { reconciliationOrdinal?: number }): Promise<RuntimeSnapshot>;
  } = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: opts.subagents ?? true,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => remote,
    history: async () => [],
    startTurn: async (req) => {
      emit(req.sessionId, {
        type: "turn/started",
        turnId: `t-${randomUUID()}`,
        ...(req.model ? { model: req.model } : {}),
      });
    },
    abort: async (sessionId) => emit(sessionId, { type: "turn/stopped", reason: "aborted" }),
    replyPermission: async () => {},
    replyQuestion: async () => {},
    endpoint: async () => endpoint,
    reconcile: async (binding) => ({
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
    }),
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, remote, endpoint };
}

function harness(opts: {
  permission?: "allow" | "deny" | "ask";
  subagents?: boolean;
  profiles?: Parameters<typeof createSessionService>[0]["profiles"];
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-model-waiting-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => opts.permission ?? "ask",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const fake = makeRuntime({ subagents: opts.subagents });
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast: { event: () => {}, projection: () => {} } satisfies Broadcaster,
    queue: store,
    runtimes: { forProject: async () => fake.rt },
    autoAccept: createAutoAcceptStore(join(dir, "auto-accept.json")),
    ...(opts.profiles ? { profiles: opts.profiles } : {}),
  });
  return { sessions, store, fake, project };
}

test("WS22: parent projection.model survives subagent adoption and child turn models", async () => {
  const { sessions, store, fake } = harness();
  const modelA = { providerID: "acme", modelID: "parent-a" };
  const { id: parentId } = await sessions.create({
    projectId: "p1",
    title: "Parent",
    model: modelA,
  });
  assert.deepEqual((await store.projection(parentId))?.model, modelA);

  await sessions.send(parentId, { text: "delegate", model: modelA });
  await waitFor(async () => (await store.projection(parentId))?.status === "working");

  const parentBe = (await store.projection(parentId))!.backendSessionId!;
  fake.remote.push({
    id: "be-child-model",
    title: "Child (@explore)",
    createdAt: 2,
    updatedAt: 2,
    parentId: parentBe,
  });
  fake.emit(parentId, {
    type: "subagent/snapshot",
    revision: 1,
    agents: [{ sessionId: "be-child-model", label: "@explore", status: "running" }],
  });
  await waitFor(async () =>
    (await store.projections("p1")).some((row) => row.parentId === parentId));
  const child = (await store.projections("p1")).find((row) => row.parentId === parentId)!;

  fake.emit(child.id, {
    type: "turn/started",
    turnId: "child-turn",
    model: { providerID: "acme", modelID: "subagent-temp" },
  });
  fake.emit(child.id, {
    type: "permission/requested",
    requestId: "per-child",
    permission: "bash",
    patterns: ["ls"],
  });
  fake.emit(parentId, {
    type: "turn/started",
    turnId: "parent-after-child",
    model: { providerID: "acme", modelID: "subagent-temp" },
  });
  fake.emit(child.id, { type: "turn/stopped", reason: "completed" });
  fake.emit(parentId, {
    type: "subagent/snapshot",
    revision: 2,
    agents: [{ sessionId: "be-child-model", label: "@explore", status: "done" }],
  });
  await waitFor(async () =>
    (await store.events(parentId)).some((e) => e.type === "subagent/snapshot"
      && (e.data as { revision?: number }).revision === 2));

  assert.deepEqual(
    (await store.projection(parentId))?.model,
    modelA,
    "parent session model must stay the user-selected model after subagent activity",
  );
  await store.close();
});

test("WS22: inherited profile turn model does not overwrite an explicit session model", async () => {
  const started: Array<{ model?: { providerID: string; modelID: string } }> = [];
  const { sessions, store, fake } = harness({
    subagents: false,
    profiles: {
      profileGet: async (id) => id === "prof-1"
        ? {
            id: "prof-1",
            name: "Fast",
            providerID: "acme",
            modelID: "profile-b",
            agent: "planner",
            features: {},
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          }
        : undefined,
    },
  });
  const baseStart = fake.rt.startTurn.bind(fake.rt);
  fake.rt.startTurn = async (req) => {
    started.push({ ...(req.model ? { model: req.model } : {}) });
    return baseStart(req);
  };

  const modelA = { providerID: "acme", modelID: "user-a" };
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "pick profile", agentProfileId: "prof-1" });
  await waitFor(async () =>
    (await store.projection(id))?.model?.modelID === "profile-b");
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () => (await store.projection(id))?.status === "idle");

  await sessions.send(id, { text: "user override", model: modelA });
  await waitFor(async () => (await store.projection(id))?.model?.modelID === "user-a");
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () => (await store.projection(id))?.status === "idle");

  await sessions.send(id, { text: "inherit profile" });
  await waitFor(() => started.length >= 3);
  assert.deepEqual(started[2]?.model, { providerID: "acme", modelID: "profile-b" });
  assert.deepEqual(
    (await store.projection(id))?.model,
    modelA,
    "inherited profile must apply to the turn without rewriting projection.model",
  );
  await store.close();
});
