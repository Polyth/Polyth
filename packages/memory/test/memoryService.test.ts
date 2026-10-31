import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeStore, type KnowledgeStore } from "@polyth/knowledge";
import { createMemoryRuntimeService, createMemoryService, memoryRoutes, registerMemoryTool, type ScopedMemorySource } from "../src/service.ts";
import registerMemoryPackage from "../src/serverEntry.ts";
import type { AgentCapabilityContribution, SpaceContext } from "@polyth/contracts";
import { createMemoryStore } from "../../knowledge/src/memory.ts";

const space = (spaceId: string, role: SpaceContext["role"] = "owner"): SpaceContext => ({
  spaceId, spaceSlug: spaceId, userId: `${spaceId}-user`, role, deployment: "local-trusted", storageDir: join(tmpdir(), spaceId),
});

test("consented harvest output is immediately recalled by default and manual review remains optional", async () => {
  const db = new DatabaseSync(":memory:");
  const ctx = space("space-a");
  const store = createMemoryStore(db, ctx.spaceId);
  const scope = { spaceId: ctx.spaceId, projectId: "project-a", principalId: ctx.userId };
  const events = [{ id: "event-a", seq: 1, type: "user/message", data: { text: "Use SQLite WAL for storage." } }];
  let calls = 0;
  const host = {
    forSpace: () => ({ projects: { get: async () => ({ id: scope.projectId }) }, sessions: { events: async () => events } }),
    resolveSessionRuntime: async () => ({ rt: {}, cwd: "/tmp" }),
    smallModelInputBudget: async () => 24000,
    smallModelComplete: async () => {
      calls++;
      return { text: JSON.stringify({ memories: [{ title: `SQLite decision ${calls}`, body: "Use SQLite WAL for durable storage.", category: "decision" }] }) };
    },
  } as never;
  const service = createMemoryService(host, { prepareProject: async () => ({ memory: store }) });
  try {
    const initial = store.getPolicy(scope);
    let policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: initial.settingsRevision, patch: {
      mode: "auto", utilityModel: { providerID: "fake", modelID: "small" }, utilityAllowlist: [{ providerID: "fake", modelID: "small" }],
      utilityModelAllowed: true, consentRequired: false, utilityBudget: { maxCalls: 2 },
    } });
    const enqueue = (jobKey: string) => store.enqueueHarvest(scope, {
      jobKey, spaceId: scope.spaceId, projectId: scope.projectId, sessionId: "session-a", sourceStartSeq: 1, sourceEndSeq: 1,
      sourceDigest: createHash("sha256").update("event-a:1:user/message").digest("hex").slice(0, 16),
      policyGeneration: policy.generation, extractorVersion: "memory-harvest-v1",
    });
    enqueue("auto-job");
    assert.equal(await service.harvest.process(ctx, scope.projectId), true);
    assert.equal(store.list(scope, { lifecycle: "active" }).total, 1);
    assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "How should SQLite storage work?" }).status, "selected");
    policy = store.getPolicy(scope);
    policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { reviewPolicy: "manual" } });
    enqueue("manual-job");
    assert.equal(await service.harvest.process(ctx, scope.projectId), true);
    assert.equal(store.list(scope, { lifecycle: "candidate" }).total, 1);
    assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "SQLite" }).selected.length, 1);
    assert.equal(calls, 2);
  } finally { db.close(); }
});

const routeRequest = (input: { path: string; method: string; space: SpaceContext; query?: Record<string, string>; body?: Record<string, unknown> }) => {
  let response: { code: number; body: unknown } | undefined;
  return {
    req: {}, res: {}, path: input.path, method: input.method,
    url: new URL(`http://memory${input.path}${input.query ? `?${new URLSearchParams(input.query)}` : ""}`),
    ingress: { kind: "internal", serviceId: "test" }, principal: { kind: "internal-service", serviceId: "test" },
    space: input.space, requireCapability() {}, body: async () => input.body ?? {}, json(code: number, body: unknown) { response = { code, body }; },
    get response() { return response; },
  } as any;
};

test("memory routes resolve project and Space before touching the shared store", async () => {
  const stores = new Map<string, KnowledgeStore>();
  const projects = new Map<string, Set<string>>([["space-a", new Set(["project-a"])], ["space-b", new Set(["project-a"])]]);
  const contexts = new Map([["space-a", space("space-a")], ["space-b", space("space-b")]]);
  const source: ScopedMemorySource = {
    async prepareProject(ctx, projectId) {
      if (!projects.get(ctx.spaceId)?.has(projectId)) throw Object.assign(new Error("project not found"), { code: "not-found" });
      let store = stores.get(ctx.spaceId);
      if (!store) { const file = join(mkdtempSync(join(tmpdir(), "memory-service-")), "knowledge.db"); store = createKnowledgeStore(file, { spaceId: ctx.spaceId }); stores.set(ctx.spaceId, store); }
      return { memory: store.memory };
    },
  };
  const host = {
    forSpace(ctx: SpaceContext) { return { projects: { get: async (id: string) => projects.get(ctx.spaceId)?.has(id) ? { id } : undefined } }; },
    systemSpaceContext(id: string) { return contexts.get(id)!; },
  } as never;
  const service = createMemoryService(host, source);
  const route = memoryRoutes(host, service);
  const create = routeRequest({ path: "/api/memory", method: "POST", space: contexts.get("space-a")!, body: { projectId: "project-a", title: "Decision", body: "Use bounded recall", lifecycle: "active" } });
  await route(create);
  assert.equal(create.response?.code, 200);
  const memoryId = (create.response?.body as { memoryId: string }).memoryId;
  const saved = stores.get("space-a")!.memory.get({ spaceId: "space-a", projectId: "project-a", principalId: "space-a-user" }, memoryId)!;
  assert.deepEqual(saved.authoredBy, { kind: "person", userId: "space-a-user" });
  assert.equal(saved.layer, "project");
  const listed = routeRequest({ path: "/api/memory", method: "GET", space: contexts.get("space-a")!, query: { projectId: "project-a" } });
  await route(listed);
  assert.equal((listed.response?.body as { total: number }).total, 1);
  // A request body cannot pick a layer or an author.
  const smuggled = routeRequest({ path: "/api/memory", method: "POST", space: contexts.get("space-a")!, body: { projectId: "project-a", title: "Smuggled", body: "Pick my layer", layer: "person", ownerId: "someone", authoredBy: { kind: "person", userId: "someone" } } });
  await route(smuggled);
  const smuggledItem = stores.get("space-a")!.memory.get({ spaceId: "space-a", projectId: "project-a", principalId: "space-a-user" }, (smuggled.response?.body as { memoryId: string }).memoryId)!;
  assert.equal(smuggledItem.layer, "project");
  assert.equal(smuggledItem.ownerId, undefined);
  assert.deepEqual(smuggledItem.authoredBy, { kind: "person", userId: "space-a-user" });
  const foreign = routeRequest({ path: "/api/memory", method: "GET", space: contexts.get("space-b")!, query: { projectId: "project-a" } });
  await route(foreign);
  assert.equal((foreign.response?.body as { total: number }).total, 0);
  const foreignGet = routeRequest({ path: `/api/memory/${encodeURIComponent(memoryId)}`, method: "GET", space: contexts.get("space-b")!, query: { projectId: "project-a" } });
  await assert.rejects(() => route(foreignGet), /memory record not found/);
  const stale = routeRequest({ path: `/api/memory/${encodeURIComponent(memoryId)}`, method: "PATCH", space: contexts.get("space-a")!, body: { projectId: "project-a", expectedRevision: 0, patch: { body: "stale" } } });
  await assert.rejects(() => route(stale), /changed since/);
  const foreignProject = routeRequest({ path: "/api/memory", method: "GET", space: contexts.get("space-a")!, query: { projectId: "project-b" } });
  await assert.rejects(() => route(foreignProject), /project not found/);
  const viewer = routeRequest({ path: "/api/memory", method: "POST", space: space("space-a", "viewer"), body: { projectId: "project-a", title: "Denied", body: "No write" } });
  await assert.rejects(() => route(viewer), /member access/);
  for (const store of stores.values()) store.close();
});

test("memory_remember invokes the shared scoped capability and returns a receipt", async () => {
  const stores = new Map<string, KnowledgeStore>();
  const contexts = new Map([["space-a", space("space-a")]]);
  const source: ScopedMemorySource = {
    async prepareProject(ctx, projectId) {
      let store = stores.get(ctx.spaceId);
      if (!store) {
        const file = join(mkdtempSync(join(tmpdir(), "memory-tool-")), "knowledge.db");
        store = createKnowledgeStore(file, { spaceId: ctx.spaceId });
        stores.set(ctx.spaceId, store);
      }
      return { memory: store.memory };
    },
  };
  const contributions = new Map<string, AgentCapabilityContribution>();
  const registry = {
    register(_owner: string, value: AgentCapabilityContribution) {
      contributions.set((value.descriptor as { name: string }).name, value);
      return { dispose() {} };
    },
  };
  const host = {
    forSpace(ctx: SpaceContext) { return { projects: { get: async () => ({ id: "project-a" }) } }; },
    systemSpaceContext(id: string) { return contexts.get(id)!; },
    services: { get(key: { id: string }) { return key.id === "polyth.service.harness.capabilities" ? registry : undefined; } },
  } as never;
  const service = createMemoryService(host, source);
  const registration = registerMemoryTool(host, service);
  assert.ok(registration);
  const contribution = contributions.get("memory_remember");
  assert.ok(contribution);
  assert.ok(contributions.get("memory_search"));
  assert.ok(contributions.get("memory_get"));
  assert.ok(contributions.get("memory_feedback"));
  const ctx = { spaceId: "space-a", projectId: "project-a", cwd: "/tmp", sessionId: "session-a" };
  const { store, scope } = await service.scope(contexts.get("space-a")!, "project-a");
  let policy = store.getPolicy(scope);
  assert.equal(await contribution!.autoApprove!(ctx), false);
  policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  for (const name of ["memory_remember", "memory_search", "memory_get"]) {
    assert.equal(await contributions.get(name)!.autoApprove!(ctx), true);
    assert.equal(await contributions.get(name)!.autoApprove!({ ...ctx, projectId: "" }), false);
  }
  assert.equal(contributions.get("memory_feedback")!.autoApprove, undefined);
  const result = await contribution!.execute!({ title: "Remembered", body: "Use the shared memory store" }, { spaceId: "space-a", projectId: "project-a", cwd: "/tmp", sessionId: "session-a" });
  assert.equal(JSON.parse(result.output).status, "committed");
  assert.deepEqual(store.get(scope, JSON.parse(result.output).memoryId)?.authoredBy, { kind: "agent", sessionId: "session-a" });
  policy = store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "read-only" } });
  assert.equal(await contribution!.autoApprove!(ctx), false);
  assert.equal(await contributions.get("memory_get")!.autoApprove!(ctx), true);
  await assert.rejects(() => contribution!.execute!({ title: "Denied", body: "Read only" }, ctx), /automatic mode/);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "off" } });
  assert.equal(await contributions.get("memory_search")!.autoApprove!(ctx), false);
  await assert.rejects(() => contributions.get("memory_get")!.execute!({ memoryId: JSON.parse(result.output).memoryId }, ctx), /disabled by project policy/);
  for (const store of stores.values()) store.close();
});

test("memory_search agrees with admission recall and hides inactive records", async () => {
  const contexts = new Map([["space-a", space("space-a")]]);
  const file = join(mkdtempSync(join(tmpdir(), "memory-search-")), "knowledge.db");
  const knowledge = createKnowledgeStore(file, { spaceId: "space-a" });
  const source: ScopedMemorySource = { async prepareProject() { return { memory: knowledge.memory }; } };
  const contributions = new Map<string, AgentCapabilityContribution>();
  const registry = { register(_owner: string, value: AgentCapabilityContribution) { contributions.set((value.descriptor as { name: string }).name, value); return { dispose() {} }; } };
  const host = {
    forSpace() { return { projects: { get: async () => ({ id: "project-a" }) } }; },
    systemSpaceContext(id: string) { return contexts.get(id)!; },
    services: { get(key: { id: string }) { return key.id === "polyth.service.harness.capabilities" ? registry : undefined; } },
  } as never;
  const service = createMemoryService(host, source);
  registerMemoryTool(host, service);
  const runtime = createMemoryRuntimeService(host, service);
  const { store, scope } = await service.scope(contexts.get("space-a")!, "project-a");
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto" } });
  const create = (title: string, body: string, lifecycle: "active" | "candidate" = "active") =>
    store.create(scope, { projectId: "project-a", title, body, lifecycle, evidence: "user-stated" }).memoryId!;
  const scopeCheck = create("Judgment scope-check runs only after auto-approve", "The scope check is consulted after the server decided to answer.");
  const archived = create("Judgment archived note", "An archived judgment record.");
  store.review(scope, archived, 1, "archived");
  const forgotten = create("Judgment forgotten secret", "A forgotten judgment record.");
  store.forget(scope, { id: forgotten, projectId: "project-a", expectedRevision: 1 });
  create("Judgment candidate", "An unreviewed judgment candidate.", "candidate");
  create("Unrelated", "Nothing about the query.");
  const ctx = { spaceId: "space-a", projectId: "project-a", cwd: "/tmp", sessionId: "session-a" };
  const search = async (query: string) => JSON.parse((await contributions.get("memory_search")!.execute!({ query }, ctx)).output) as { items: Array<{ id: string }>; total: number };

  // A natural-language query need not match the whole phrase, exactly like recall.
  const phrase = await search("Judgment scope-check Auto-Approve harness");
  assert.deepEqual(phrase.items.map((item) => item.id), [scopeCheck]);
  assert.equal(phrase.total, 1);
  const recalled = await runtime.recall({ spaceId: "space-a", projectId: "project-a", principalId: "session:a" }, { sessionId: "a", intent: "Judgment scope-check Auto-Approve harness" });
  assert.deepEqual(recalled.selected.map((item) => item.memoryId), phrase.items.map((item) => item.id));
  // Archived, forgotten and candidate records never reach an agent through search.
  assert.deepEqual((await search("Judgment")).items.map((item) => item.id), [scopeCheck]);
  assert.equal((await search("the of and")).total, 0);
  await assert.rejects(() => contributions.get("memory_get")!.execute!({ memoryId: forgotten }, ctx), /memory record not found/);
  const archivedRecord = JSON.parse((await contributions.get("memory_get")!.execute!({ memoryId: archived }, ctx)).output) as { lifecycle: string };
  assert.equal(archivedRecord.lifecycle, "archived");
  knowledge.close();
});

test("runtime recall carries strict policy into every contribution", async () => {
  const stores = new Map<string, KnowledgeStore>();
  const contexts = new Map([["space-a", space("space-a")]]);
  const source: ScopedMemorySource = {
    async prepareProject(ctx) {
      let store = stores.get(ctx.spaceId);
      if (!store) {
        const file = join(mkdtempSync(join(tmpdir(), "memory-runtime-")), "knowledge.db");
        store = createKnowledgeStore(file, { spaceId: ctx.spaceId });
        stores.set(ctx.spaceId, store);
      }
      return { memory: store.memory };
    },
  };
  const host = {
    forSpace(ctx: SpaceContext) { return { projects: { get: async () => ({ id: "project-a" }) } }; },
    systemSpaceContext(id: string) { return contexts.get(id)!; },
  } as never;
  const service = createMemoryService(host, source);
  const store = await service.storeFor(contexts.get("space-a")!, "project-a");
  const policy = store.getPolicy({ spaceId: "space-a", projectId: "project-a", principalId: "space-a-user" });
  store.updatePolicy({ spaceId: "space-a", projectId: "project-a", principalId: "space-a-user" }, { projectId: "project-a", expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto", blockWithoutMemory: true } });
  const contribution = await createMemoryRuntimeService(host, service).recall({ spaceId: "space-a", projectId: "project-a", principalId: "session:s" }, { sessionId: "s", intent: "anything" });
  assert.equal(contribution.requiresMemory, true);
  assert.equal(contribution.status, "empty");
  for (const item of stores.values()) item.close();
});

test("turn admission is fail-open when memory delivery is off", async () => {
  const stores = new Map<string, KnowledgeStore>();
  const contexts = new Map([["space-a", space("space-a")]]);
  const source: ScopedMemorySource = {
    async prepareProject(ctx) {
      let store = stores.get(ctx.spaceId);
      if (!store) {
        const file = join(mkdtempSync(join(tmpdir(), "memory-runtime-off-")), "knowledge.db");
        store = createKnowledgeStore(file, { spaceId: ctx.spaceId });
        stores.set(ctx.spaceId, store);
      }
      return { memory: store.memory };
    },
  };
  const host = {
    forSpace(ctx: SpaceContext) { return { projects: { get: async () => ({ id: "project-a" }) } }; },
    systemSpaceContext(id: string) { return contexts.get(id)!; },
  } as never;
  const service = createMemoryService(host, source);
  const store = await service.storeFor(contexts.get("space-a")!, "project-a");
  const policy = store.getPolicy({ spaceId: "space-a", projectId: "project-a", principalId: "space-a-user" });
  store.updatePolicy({ spaceId: "space-a", projectId: "project-a", principalId: "space-a-user" }, {
    projectId: "project-a",
    expectedSettingsRevision: policy.settingsRevision,
    patch: { mode: "off", blockWithoutMemory: true },
  });
  const contribution = await createMemoryRuntimeService(host, service).recall(
    { spaceId: "space-a", projectId: "project-a", principalId: "session:s" },
    { sessionId: "s", intent: "anything" },
  );
  assert.equal(contribution.status, "blocked");
  assert.equal(contribution.requiresMemory, false);
  for (const item of stores.values()) item.close();
});

test("memory package keeps paired/remote route access default-deny", () => {
  const provided: string[] = [];
  const host = {
    services: {
      provide(key: { id: string }) { provided.push(key.id); },
      get() { return undefined; },
    },
  } as never;
  const pkg = registerMemoryPackage(host);
  // The policy inventory requires every package to declare remoteAccess; an
  // empty http list with no websocket rules keeps paired devices out.
  assert.deepEqual(pkg.remoteAccess, { routeScopes: ["memory"], http: [] });
  assert.deepEqual(provided, ["polyth.service.memory", "polyth.service.memory.runtime"]);
});

const readyUtility = {
  utilityStatus: "ready", utilityModelAllowed: true, consentRequired: false,
  utilityModel: { providerID: "fake", modelID: "small" }, utilityAllowlist: [{ providerID: "fake", modelID: "small" }],
};

test("harvest discovery skips session scans while the utility model is not ready", async () => {
  const ctx = space("harvest-blocked-space");
  for (const blocked of [
    { utilityStatus: "blocked" }, { utilityStatus: "disabled" }, { consentRequired: true }, { utilityModelAllowed: false }, { utilityAllowlist: [] },
  ]) {
    let scanned = 0;
    let claims = 0;
    const memory = {
      getPolicy: () => ({ mode: "auto", harvesting: "paused", generation: "g1", ...readyUtility, ...blocked }),
      claimHarvest: () => { claims++; return undefined; },
    };
    const host = {
      projects: { list: async () => [{ id: "project-a", spaceId: ctx.spaceId }] },
      systemSpaceContext: () => ctx,
      forSpace: () => ({
        projects: { get: async () => ({ id: "project-a" }) },
        sessions: { list: async () => { scanned++; return [{ id: "session-a" }]; } },
      }),
    } as never;
    const service = createMemoryService(host, { prepareProject: async () => ({ memory: memory as never }) });
    assert.equal(await service.harvest.processOnce(), false);
    assert.deepEqual({ scanned, claims }, { scanned: 0, claims: 0 }, JSON.stringify(blocked));
  }
});

test("harvest recovery yields to the event loop while scanning a large session inventory", async () => {
  const ctx = space("harvest-space");
  const sessions = Array.from({ length: 24 }, (_, index) => ({ id: `session-${index}` }));
  let reads = 0;
  const memory = {
    getPolicy: () => ({ mode: "auto", harvesting: "available", generation: "g1", ...readyUtility }),
    harvestCursor: () => ({ nextSeq: 1, policyGeneration: "g1" }),
    claimHarvest: () => undefined,
  };
  const host = {
    projects: { list: async () => [{ id: "project-a", spaceId: ctx.spaceId }] },
    systemSpaceContext: () => ctx,
    forSpace: () => ({
      projects: { get: async () => ({ id: "project-a" }) },
      sessions: { list: async () => sessions },
    }),
    store: { latestSeq: async () => { reads++; return 0; } },
  } as never;
  const service = createMemoryService(host, { prepareProject: async () => ({ memory: memory as never }) });
  let eventLoopRan = false;
  setImmediate(() => { eventLoopRan = true; });

  assert.equal(await service.harvest.processOnce(), false);
  assert.equal(eventLoopRan, true, "asset requests must get an event-loop turn during recovery");
  assert.ok(reads >= sessions.length);
});

const crossProjectFixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), "memory-cross-")), "knowledge.db");
  const knowledge = createKnowledgeStore(file, { spaceId: "space-a" });
  const system = space("space-a");
  const person = { ...space("space-a"), userId: "person-a" };
  // person-a can open project-a and project-b; project-private belongs to someone else.
  const visible: Record<string, Array<{ id: string; name: string }>> = {
    "person-a": [{ id: "project-a", name: "Alpha" }, { id: "project-b", name: "Beta" }],
  };
  const all = [...visible["person-a"]!, { id: "project-private", name: "Private" }];
  const contributions = new Map<string, AgentCapabilityContribution>();
  const registry = { register(_owner: string, value: AgentCapabilityContribution) { contributions.set((value.descriptor as { name?: string; id: string }).name ?? value.descriptor.id, value); return { dispose() {} }; } };
  const host = {
    forSpace(ctx: SpaceContext) {
      const projects = ctx.userId === "person-a" ? visible["person-a"]! : all;
      return { projects: { get: async (id: string) => all.find((item) => item.id === id), list: async () => projects } };
    },
    systemSpaceContext: () => system,
    personSpaceContext: (userId: string) => userId === "person-a" ? person : undefined,
    services: { get(key: { id: string }) { return key.id === "polyth.service.harness.capabilities" ? registry : undefined; } },
  } as never;
  const service = createMemoryService(host, { async prepareProject() { return { memory: knowledge.memory }; } });
  registerMemoryTool(host, service);
  const store = knowledge.memory;
  const scopeOf = (projectId: string) => ({ spaceId: "space-a", projectId, principalId: system.userId });
  const enable = (projectId: string, patch: Record<string, unknown> = {}) => {
    const policy = store.getPolicy(scopeOf(projectId));
    return store.updatePolicy(scopeOf(projectId), { projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "auto", ...patch } });
  };
  const add = (projectId: string, title: string, body: string) => store.create(scopeOf(projectId), { projectId, title, body, lifecycle: "active" }).memoryId!;
  const ctx = { spaceId: "space-a", projectId: "project-a", cwd: "/tmp", sessionId: "session-a", actorUserId: "person-a" };
  return { knowledge, contributions, store, scopeOf, enable, add, ctx };
};

test("memory_search_projects asks first, searches only projects the person can open and names them", async () => {
  const { knowledge, contributions, enable, add, ctx } = crossProjectFixture();
  enable("project-a"); enable("project-b"); enable("project-private");
  const beta = add("project-b", "Router admin", "Router admin over ssh as root.");
  add("project-private", "Router secret", "Someone else's router note.");
  const tool = contributions.get("memory_search_projects")!;
  const read = contributions.get("memory_get_project")!;
  assert.equal(tool.descriptor.kind === "tool" && tool.descriptor.mutating, false);
  // Default policy is "ask": no auto-approval, the permission prompt is the consent.
  assert.equal(await tool.autoApprove!(ctx), false);
  assert.equal(await read.autoApprove!(ctx), false);
  const found = JSON.parse((await tool.execute!({ query: "router" }, ctx)).output) as { items: Array<{ id: string; projectName: string }>; searchedProjects: Array<{ id: string }> };
  assert.deepEqual(found.items.map((item) => [item.id, item.projectName]), [[beta, "Beta"]]);
  assert.deepEqual(found.searchedProjects.map((item) => item.id), ["project-a", "project-b"]);
  // Naming a project the person cannot open does not widen the search.
  const narrowed = JSON.parse((await tool.execute!({ query: "router", projectIds: ["project-private"] }, ctx)).output) as { items: unknown[] };
  assert.equal(narrowed.items.length, 0);
  const record = JSON.parse((await read.execute!({ projectId: "project-b", memoryId: beta }, ctx)).output) as { id: string; projectName: string };
  assert.deepEqual([record.id, record.projectName], [beta, "Beta"]);
  await assert.rejects(() => read.execute!({ projectId: "project-private", memoryId: beta }, ctx), /memory record not found/);
  // No person, no cross-project search.
  await assert.rejects(() => tool.execute!({ query: "router" }, { ...ctx, actorUserId: undefined }), /needs the person/);
  await assert.rejects(() => tool.execute!({ query: "router" }, { ...ctx, actorUserId: "stranger" }), /no longer a member/);
  knowledge.close();
});

test("cross-project recall settings: allow skips the prompt, off refuses", async () => {
  const { knowledge, contributions, enable, ctx } = crossProjectFixture();
  enable("project-a", { crossProjectRecall: "allow" });
  const tool = contributions.get("memory_search_projects")!;
  assert.equal(await tool.autoApprove!(ctx), true);
  enable("project-a", { crossProjectRecall: "off" });
  assert.equal(await tool.autoApprove!(ctx), false);
  await assert.rejects(() => tool.execute!({ query: "router" }, ctx), /cross-project memory search is off/);
  await assert.rejects(() => contributions.get("memory_get_project")!.execute!({ projectId: "project-b", memoryId: "x" }, ctx), /off/);
  knowledge.close();
});

test("memory_remember supersedes outdated agent records but never a person's", async () => {
  const { knowledge, contributions, store, scopeOf, enable, ctx } = crossProjectFixture();
  enable("project-a");
  const remember = contributions.get("memory_remember")!;
  const old = JSON.parse((await remember.execute!({ title: "Router IP", body: "The router is at 192.168.1.1." }, ctx)).output) as { memoryId: string };
  const next = JSON.parse((await remember.execute!({ title: "Router IP", body: "The router moved to 192.168.1.254.", supersedes: [old.memoryId] }, ctx)).output) as { memoryId: string; superseded: string[] };
  assert.deepEqual(next.superseded, [old.memoryId]);
  assert.equal(store.get(scopeOf("project-a"), old.memoryId)?.lifecycle, "superseded");
  assert.deepEqual(store.search(scopeOf("project-a"), { q: "router" }).items.map((item) => item.id), [next.memoryId]);
  const personal = store.create(scopeOf("project-a"), { projectId: "project-a", title: "Owner rule", body: "Always ask before restarting the router.", lifecycle: "active" }, { authoredBy: { kind: "person", userId: "person-a" } }).memoryId!;
  const before = store.list(scopeOf("project-a")).total;
  await assert.rejects(() => remember.execute!({ title: "Rule change", body: "Restart the router freely.", supersedes: [personal] }, ctx), /saved or approved by a person/);
  assert.equal(store.list(scopeOf("project-a")).total, before);
  await assert.rejects(() => remember.execute!({ title: "Ghost", body: "Nothing.", supersedes: ["missing"] }, ctx), /not found/);
  knowledge.close();
});

test("the memory package projects a long-term memory instruction to every harness", () => {
  const { knowledge, contributions } = crossProjectFixture();
  const instruction = contributions.get("memory.long-term-memory-policy");
  assert.ok(instruction && instruction.descriptor.kind === "instruction");
  assert.match((instruction.descriptor as { text: string }).text, /memory_search/);
  assert.match((instruction.descriptor as { text: string }).text, /memory_search_projects/);
  knowledge.close();
});
