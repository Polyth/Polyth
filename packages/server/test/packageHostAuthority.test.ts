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
    systemSpaceContext(spaceId: string): SpaceContext {
      return {
        spaceId, spaceSlug: "home", userId: RUNTIME_SYSTEM_PRINCIPAL_ID,
        role: "owner", deployment: "local-trusted", storageDir: "/tmp/spaces/home",
      };
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
    systemSpaceContext() { assert.fail("shared package-global authority must not derive a Space"); },
    forSpace() { assert.fail("shared package-global authority must not derive a Space"); },
    events: { async append() { assert.fail("unexpected append"); } },
  } as unknown as ServerPackageHost;
  const governed = governPackageHost(host);

  await assert.rejects(governed.projects.get("foreign"), { code: "unavailable" });
  await assert.rejects(governed.projects.list(), { code: "unavailable" });
  await assert.rejects(governed.sessions.create({ projectId: "foreign" }), { code: "unavailable" });
  assert.equal(rawProjectReads, 0);
});

test("indexed package history validates scoped session access before reading", async () => {
  const foreign = { ...projection, id: "ses_foreign", projectId: "prj_foreign", spaceId: "spc_foreign" };
  const calls: unknown[][] = [];
  const scopes: string[] = [];
  const rawStore = {
    async projection(id: string) { return id === projection.id ? projection : id === foreign.id ? foreign : undefined; },
    async eventsOfTypes(...args: unknown[]) { calls.push(args); return []; },
  };
  const host = {
    pluginId: "goals", deployment: "local-trusted", store: rawStore, sessions: {},
    projects: { async get(id: string) {
      return { id, spaceId: id === projection.projectId ? projection.spaceId : foreign.spaceId };
    } },
    systemSpaceContext(spaceId: string) { return { spaceId, userId: RUNTIME_SYSTEM_PRINCIPAL_ID, deployment: "local-trusted", storageDir: `/tmp/spaces/${spaceId}` }; },
    forSpace(ctx: SpaceContext) {
      scopes.push(ctx.spaceId);
      return { sessions: { async snapshot(id: string) {
        if (ctx.spaceId !== projection.spaceId || id !== projection.id) throw Object.assign(new Error("not found"), { code: "not-found" });
        return projection;
      } } };
    },
  } as unknown as ServerPackageHost;
  const indexed = governPackageHost(host).store.eventsOfTypes!;
  const args = [projection.id, ["assistant/message"], 2, 10, 5] as const;
  assert.deepEqual(await indexed(...args), []);
  await assert.rejects(indexed(foreign.id, ["assistant/message"], 0, 10), { code: "not-found" });
  assert.deepEqual(calls, [[...args]]);
  assert.deepEqual(scopes, [projection.spaceId, foreign.spaceId]);

  const shared = governPackageHost({ ...host, deployment: "server-trusted" }).store.eventsOfTypes!;
  await assert.rejects(shared(projection.id, ["assistant/message"], 0, 10), { code: "unavailable" });
  assert.equal(calls.length, 1);
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
      async ensurePackageWorkspace(input: { spaceId: string; packageId: string; path: string }) {
        rawCalls.push(`project.ensurePackageWorkspace:${input.packageId}`);
        return project;
      },
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
    systemSpaceContext(spaceId: string): SpaceContext {
      return {
        spaceId, spaceSlug: "home", userId: RUNTIME_SYSTEM_PRINCIPAL_ID,
        role: "owner", deployment: "local-trusted", storageDir: "/tmp/spaces/home",
      };
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
  const projectsWithWorkspace = governed.projects as typeof governed.projects & {
    ensurePackageWorkspace(input: { spaceId: string; packageId: string; path: string }): Promise<Project>;
  };
  await assert.rejects(
    () => projectsWithWorkspace.ensurePackageWorkspace({
      spaceId: project.spaceId!, packageId: "other-package", path: "/tmp/other",
    }),
    { code: "unavailable" },
  );
  assert.equal(
    (await projectsWithWorkspace.ensurePackageWorkspace({
      spaceId: project.spaceId!, packageId: "test-package", path: "/tmp/project",
    })).id,
    project.id,
  );

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
  assert.deepEqual(rawCalls, ["project.ensurePackageWorkspace:test-package"]);
});

test("package store forwards profile management methods to the underlying store", async () => {
  const profileCalls: string[] = [];
  const fakeProfile = { id: "prof_1", name: "Prof", providerID: "p", modelID: "m", features: {}, revision: 1, createdAt: 1, updatedAt: 1 };
  const rawStore = {
    async profileList() { profileCalls.push("profileList"); return [fakeProfile]; },
    async profileGet(id: string) { profileCalls.push(`profileGet:${id}`); return fakeProfile; },
    async profileCreate(input: unknown) { profileCalls.push("profileCreate"); return fakeProfile; },
    async profileUpdate(id: string, patch: unknown, rev: number) { profileCalls.push(`profileUpdate:${id}`); return fakeProfile; },
    async profileRemove(id: string) { profileCalls.push(`profileRemove:${id}`); return true; },
  };
  const host = {
    pluginId: "models",
    deployment: "local-trusted",
    projects: {},
    sessions: {},
    store: rawStore,
  } as unknown as ServerPackageHost;

  const governed = governPackageHost(host);
  const profileStore = governed.store as typeof governed.store & typeof rawStore;
  assert.deepEqual(await profileStore.profileList(), [fakeProfile]);
  assert.deepEqual(await profileStore.profileGet("prof_1"), fakeProfile);
  assert.deepEqual(await profileStore.profileCreate({ name: "Prof", providerID: "p", modelID: "m" }), fakeProfile);
  assert.deepEqual(await profileStore.profileUpdate("prof_1", {}, 1), fakeProfile);
  assert.equal(await profileStore.profileRemove("prof_1"), true);
  assert.deepEqual(profileCalls, [
    "profileList",
    "profileGet:prof_1",
    "profileCreate",
    "profileUpdate:prof_1",
    "profileRemove:prof_1",
  ]);
});
