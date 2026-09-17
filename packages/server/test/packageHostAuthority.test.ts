import test from "node:test";
import assert from "node:assert/strict";
import type { Project, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { RUNTIME_SYSTEM_PRINCIPAL_ID } from "@polyth/plugins";
import { governPackageHost } from "../src/packageHostAuthority.ts";

const projection: SessionProjection = {
  id: "ses_one", projectId: "prj_one", spaceId: "spc_home", title: "One",
  status: "idle", createdAt: 1, updatedAt: 1,
};

test("discovered package sessions route through system-scoped Space services", async () => {
  let rawCreate = 0;
  let rawSnapshot = 0;
  let rawProjection = 0;
  let rawStoreAppend = 0;
  let scopedCreate = 0;
  let scopedSnapshot = 0;
  let appended = 0;
  const project: Project = { id: "prj_one", path: "/tmp/project", name: "One", createdAt: 1, spaceId: "spc_home" };
  const scoped = {
    async create() { scopedCreate++; return { id: "ses_created" }; },
    async snapshot() { scopedSnapshot++; return projection; },
  } as unknown as SessionService;
  const raw = {
    async create() { rawCreate++; throw new Error("raw create called"); },
    async snapshot() { rawSnapshot++; throw new Error("raw snapshot called"); },
  } as unknown as SessionService;
  const host = {
    pluginId: "test-package",
    deployment: "local-trusted",
    projects: { get: async (id: string) => id === project.id ? project : undefined },
    sessions: raw,
    store: {
      async projection(id: string) { rawProjection++; return id === projection.id ? projection : undefined; },
      async append() { rawStoreAppend++; throw new Error("raw store append called"); },
    },
    forSpace(ctx: SpaceContext) {
      assert.equal(ctx.spaceId, "spc_home");
      assert.equal(ctx.userId, RUNTIME_SYSTEM_PRINCIPAL_ID);
      return { projects: {} as never, sessions: scoped };
    },
    events: {
      async append(sessionId: string) {
        assert.equal(sessionId, projection.id);
        appended++;
        return { sessionId, seq: 1, ts: 1, type: "test/event", data: {} } as never;
      },
    },
  } as unknown as ServerPackageHost;

  const governed = governPackageHost(host);
  assert.deepEqual(await governed.sessions.create({ projectId: project.id }), { id: "ses_created" });
  assert.equal((await governed.sessions.snapshot(projection.id)).id, projection.id);
  await governed.events.append(projection.id, "test/event", {});
  assert.equal((await governed.store.projection(projection.id))?.id, projection.id);
  await governed.store.append(projection.id, "test/store-event", {});

  assert.equal(rawCreate, 0);
  assert.equal(rawSnapshot, 0);
  assert.equal(rawStoreAppend, 0);
  assert.equal(rawProjection, 4);
  assert.equal(scopedCreate, 1);
  assert.equal(scopedSnapshot, 4);
  assert.equal(appended, 2);
});

test("shared deployments reject package-global project and session authority", async () => {
  let rawProjectReads = 0;
  const host = {
    pluginId: "test-package",
    deployment: "server-trusted",
    projects: {
      async get() { rawProjectReads++; return { id: "foreign", path: "/tmp/foreign", name: "Foreign", createdAt: 1, spaceId: "spc_foreign" }; },
      async list() { rawProjectReads++; return []; },
    },
    sessions: {} as SessionService,
    store: {},
    forSpace() { assert.fail("shared package-global authority must not derive a Space"); },
    events: { async append() { assert.fail("unexpected append"); } },
  } as unknown as ServerPackageHost;
  const governed = governPackageHost(host);

  await assert.rejects(governed.projects.get("foreign"), { code: "unavailable" });
  await assert.rejects(governed.projects.list(), { code: "unavailable" });
  await assert.rejects(governed.sessions.create({ projectId: "foreign" }), { code: "unavailable" });
  assert.equal(rawProjectReads, 0);
});

test("package host authority fails closed instead of exposing new raw methods", async () => {
  const rawCalls: string[] = [];
  const scopedCalls: string[] = [];
  const project: Project = { id: "prj_one", path: "/tmp/project", name: "One", createdAt: 1, spaceId: "spc_home" };
  const scoped = {
    async clientMutationStatus() { scopedCalls.push("clientMutationStatus"); return {} as never; },
    async renameWorktreeBranch() { scopedCalls.push("renameWorktreeBranch"); return projection; },
    async patchIsolation() { scopedCalls.push("patchIsolation"); return projection; },
    async rebindWorkspace() { scopedCalls.push("rebindWorkspace"); return projection; },
  } as unknown as SessionService;
  const rawSessions = {
    async clientMutationStatus() { rawCalls.push("session.clientMutationStatus"); return {} as never; },
    async renameWorktreeBranch() { rawCalls.push("session.renameWorktreeBranch"); return projection; },
    async patchIsolation() { rawCalls.push("session.patchIsolation"); return projection; },
    async rebindWorkspace() { rawCalls.push("session.rebindWorkspace"); return projection; },
    rawEscape() { rawCalls.push("session.rawEscape"); },
  } as unknown as SessionService;
  const host = {
    pluginId: "test-package",
    deployment: "local-trusted",
    projects: {
      async get(id: string) { return id === project.id ? project : undefined; },
      clone() { rawCalls.push("project.clone"); return project; },
      rawEscape() { rawCalls.push("project.rawEscape"); },
    },
    sessions: rawSessions,
    store: {
      async projection(id: string) { return id === projection.id ? projection : undefined; },
      deleteSession() { rawCalls.push("store.deleteSession"); },
      setReadCursor() { rawCalls.push("store.setReadCursor"); },
      close() { rawCalls.push("store.close"); },
      prepareOperation() { rawCalls.push("store.prepareOperation"); },
      operations() { rawCalls.push("store.operations"); },
      claimOperation() { rawCalls.push("store.claimOperation"); },
      settleOperation() { rawCalls.push("store.settleOperation"); },
      rawEscape() { rawCalls.push("store.rawEscape"); },
    },
    forSpace(ctx: SpaceContext) {
      assert.equal(ctx.spaceId, "spc_home");
      assert.equal(ctx.userId, RUNTIME_SYSTEM_PRINCIPAL_ID);
      return { projects: {} as never, sessions: scoped };
    },
    events: { async append() { assert.fail("unexpected append"); } },
  } as unknown as ServerPackageHost;

  const governed = governPackageHost(host);
  await governed.sessions.clientMutationStatus?.(projection.id, "op_1");
  await governed.sessions.renameWorktreeBranch?.(projection.id, { worktreePath: "/tmp/project", from: "old", to: "new" });
  await governed.sessions.patchIsolation?.(projection.id, null);
  await governed.sessions.rebindWorkspace?.(projection.id, { worktreePath: "/tmp/project" });

  const sessionsWithEscape = governed.sessions as SessionService & { rawEscape(): void };
  const projectsWithEscape = governed.projects as typeof governed.projects & { rawEscape(): void };
  const storeWithEscape = governed.store as typeof governed.store & { rawEscape(): void };
  assert.throws(() => sessionsWithEscape.rawEscape(), { code: "unavailable" });
  assert.throws(() => projectsWithEscape.rawEscape(), { code: "unavailable" });
  assert.throws(() => governed.projects.clone?.("https://example.test/repo.git", "/tmp"), { code: "unavailable" });
  assert.throws(() => governed.store.deleteSession?.(projection.id), { code: "unavailable" });
  assert.throws(() => governed.store.setReadCursor?.(projection.id, 1), { code: "unavailable" });
  assert.throws(() => governed.store.close(), { code: "unavailable" });
  assert.throws(() => storeWithEscape.rawEscape(), { code: "unavailable" });

  for (const method of ["prepareOperation", "operations", "claimOperation", "settleOperation"] as const) {
    assert.throws(() => (governed.store[method] as (...args: unknown[]) => unknown)(), { code: "unavailable" });
  }

  assert.deepEqual(scopedCalls, [
    "clientMutationStatus",
    "renameWorktreeBranch",
    "patchIsolation",
    "rebindWorkspace",
  ]);
  assert.deepEqual(rawCalls, []);
});
