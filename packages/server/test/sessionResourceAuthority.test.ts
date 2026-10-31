import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Project,
  ProjectService,
  SessionEvent,
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { accessControlledSessionService } from "../src/sessionResourceAccess.ts";
import { canonicalSessionService } from "../src/sessionResourceAuthority.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-session-resource-"));
  const security = createCanonicalSecurity({
    dataDir: root,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
    now: () => 1_000,
  });
  security.control.transaction(() => {
    for (const [id, name] of [["usr_owner", "Owner"], ["usr_viewer", "Viewer"]] as const) {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
    }
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_owner','owner')");
    security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_viewer','guest')");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',1)");
    security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_viewer','viewer',1)");
    security.control.run(
      `INSERT INTO resources(id,kind,org_id,space_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
       VALUES('prj_one','project','org_home','spc_home','usr_owner','usr_owner','space','active',1,1)`,
    );
  });
  const binding = bindCanonicalSecurity(security);
  const project: Project = { id: "prj_one", path: join(root, "project"), name: "One", createdAt: 1, spaceId: "spc_home" };
  const projects: ProjectService = {
    async list() { return [project]; },
    async add() { return project; },
    async create() { return project; },
    async remove() {},
    async get(id) { return id === project.id ? project : undefined; },
  };

  const projections = new Map<string, SessionProjection>();
  const histories = new Map<string, SessionEvent[]>();
  let failCreateAfterProjection = false;
  const projection = (id: string, parentId?: string): SessionProjection => ({
    id,
    projectId: "prj_one",
    spaceId: "spc_home",
    ...(parentId ? { parentId } : {}),
    title: id,
    status: "idle",
    createdAt: 10,
    updatedAt: 10,
  } as SessionProjection);
  const missing = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
  const domain = {
    projections,
    histories,
    setFailCreateAfterProjection(value: boolean) { failCreateAfterProjection = value; },
    insertImportedChild(parentId: string): SessionProjection {
      const child = projection(randomUUID(), parentId);
      projections.set(child.id, child);
      histories.set(child.id, [{
        id: randomUUID(), sessionId: child.id, seq: 1, time: 10,
        type: "session/imported", data: {}, ignorable: true,
      } as SessionEvent]);
      return child;
    },
    insertForkOrphan(parentId: string): SessionProjection {
      const child = projection(randomUUID(), parentId);
      projections.set(child.id, child);
      histories.set(child.id, [{
        id: randomUUID(), sessionId: child.id, seq: 1, time: 10,
        type: "session/forked", data: {}, ignorable: true,
      } as SessionEvent]);
      return child;
    },
    insertRetiredSpaceLeftover(): SessionProjection {
      const leftover = {
        ...projection(randomUUID()),
        projectId: "prj_retired",
        spaceId: "spc_retired",
      } as SessionProjection;
      projections.set(leftover.id, leftover);
      histories.set(leftover.id, []);
      return leftover;
    },
    insertUnadoptedTopLevel(): SessionProjection {
      const row = projection(randomUUID());
      projections.set(row.id, row);
      histories.set(row.id, []);
      return row;
    },
  };

  const base = {
    async create(input: { id?: string; projectId: string }) {
      const id = input.id ?? randomUUID();
      const row = projection(id);
      projections.set(id, row);
      histories.set(id, []);
      if (failCreateAfterProjection) throw Object.assign(new Error("runtime unavailable"), { code: "runtime-unavailable" });
      return { id };
    },
    async snapshot(id: string) {
      const row = projections.get(id);
      if (!row) throw missing();
      return { ...row };
    },
    async list(projectId?: string) {
      return [...projections.values()].filter((row) => !projectId || row.projectId === projectId).map((row) => ({ ...row }));
    },
    async sync(projectId: string) {
      return [...projections.values()].filter((row) => row.projectId === projectId).map((row) => ({ ...row }));
    },
    async events(id: string) {
      if (!projections.has(id)) throw missing();
      return [...(histories.get(id) ?? [])];
    },
    async fork(parentId: string) {
      if (!projections.has(parentId)) throw missing();
      const id = randomUUID();
      const child = projection(id, parentId);
      projections.set(id, child);
      histories.set(id, [{
        id: randomUUID(), sessionId: id, seq: 1, time: 10,
        type: "session/forked", data: { fromSessionId: parentId }, ignorable: true,
      } as SessionEvent]);
      return { id, fromSessionId: parentId };
    },
    async archive(id: string) {
      const row = projections.get(id);
      if (!row) throw missing();
      projections.set(id, { ...row, status: "archived", updatedAt: row.updatedAt + 1 });
    },
    async restore(id: string) {
      const row = projections.get(id);
      if (!row) throw missing();
      projections.set(id, { ...row, status: "idle", updatedAt: row.updatedAt + 1 });
    },
    async delete(id: string) {
      if (!projections.delete(id)) throw missing();
      histories.delete(id);
    },
    async send(id: string) {
      if (!projections.has(id)) throw missing();
      return { turnId: randomUUID() };
    },
    async withWorkspaceMutation() { throw new Error("mutation callback reached domain"); },
    async abort() {},
    async replyPermission() {},
    async replyQuestion() {},
  } as unknown as SessionService;

  const ctx = (userId: string, role: SpaceContext["role"]): SpaceContext => ({
    spaceId: "spc_home",
    spaceSlug: "home",
    userId,
    role,
    deployment: "local-trusted",
    storageDir: join(root, "spaces", "home"),
  });
  t.after(() => {
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, security, projects, base, domain, ctx };
}

test("session create preallocates the canonical id and activates only the durable projection", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one", title: "Hello" });
  const resource = f.security.resources.resource(ref.id);
  assert.ok(resource);
  assert.equal(resource.kind, "session");
  assert.equal(resource.orgId, "org_home");
  assert.equal(resource.spaceId, "spc_home");
  assert.equal(resource.parentId, "prj_one");
  assert.equal(resource.ownerPrincipalId, "usr_owner");
  assert.equal(resource.createdBy, "usr_owner");
  // A chat a person starts takes the Space's default audience: private.
  assert.equal(resource.visibility, "private");
  assert.equal(resource.lifecycle, "active");
  assert.equal(f.domain.projections.has(ref.id), true);
});

test("session create preserves a preallocated internal session id", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const id = randomUUID();
  const ref = await sessions.create({ projectId: "prj_one", id });
  assert.equal(ref.id, id);
  assert.equal(f.domain.projections.has(id), true);
  assert.equal(f.security.resources.resource(id)?.lifecycle, "active");
});

test("runtime startup failure still activates a durable failed/reconciling session resource", async t => {
  const f = fixture(t);
  f.domain.setFailCreateAfterProjection(true);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  await assert.rejects(sessions.create({ projectId: "prj_one" }), { code: "runtime-unavailable" });
  assert.equal(f.domain.projections.size, 1);
  const [id] = [...f.domain.projections.keys()];
  assert.equal(f.security.resources.resource(id!)?.lifecycle, "active");
});

test("archive, restore and hard delete move canonical lifecycle with the domain row", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one" });

  await sessions.archive(ref.id);
  assert.equal((await sessions.snapshot(ref.id)).status, "archived");
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "archived");
  await assert.rejects(sessions.send(ref.id, { text: "no", delivery: "enqueue" } as never), { code: "conflict" });

  await sessions.restore(ref.id);
  assert.equal((await sessions.snapshot(ref.id)).status, "idle");
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "active");

  await sessions.delete!(ref.id);
  assert.equal(f.domain.projections.has(ref.id), false);
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleted");
});

test("archiving an archived session is a no-op so a subtree archive tolerates archived members", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one" });

  await sessions.archive(ref.id);
  const revision = f.security.resources.resource(ref.id)?.revision;
  await sessions.archive(ref.id);

  assert.equal((await sessions.snapshot(ref.id)).status, "archived");
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "archived");
  assert.equal(f.security.resources.resource(ref.id)?.revision, revision);
  await assert.rejects(sessions.send(ref.id, { text: "no", delivery: "enqueue" } as never), { code: "conflict" });
});

test("repeated delete succeeds after the deleted tombstone is durable while reads fail closed", async t => {
  const f = fixture(t);
  const canonical = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const sessions = accessControlledSessionService(f.ctx("usr_owner", "owner"), canonical);
  const ref = await sessions.create({ projectId: "prj_one" });

  await sessions.delete!(ref.id);
  assert.deepEqual(await sessions.list("prj_one"), []);
  await sessions.delete!(ref.id);
  await assert.rejects(sessions.snapshot(ref.id), { code: "not-found" });
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleted");
});

test("a concurrent read does not roll back an in-flight session deletion", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one" });
  let started!: () => void;
  let release!: () => void;
  const deleteStarted = new Promise<void>((resolve) => { started = resolve; });
  const releaseDelete = new Promise<void>((resolve) => { release = resolve; });
  const deleteDomain = f.base.delete!;
  f.base.delete = async (id: string) => {
    started();
    await releaseDelete;
    return deleteDomain(id);
  };

  const deleting = sessions.delete!(ref.id);
  await deleteStarted;
  await sessions.list("prj_one");
  release();
  await deleting;

  assert.equal(f.domain.projections.has(ref.id), false);
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleted");
});

test("failed delete releases the fence when the domain projection survived", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one" });
  // A destructive step that refuses before the purge (for example an
  // isolation-ownership check) must not leave an intact session invisible.
  f.base.delete = async () => {
    throw Object.assign(
      new Error("refusing to delete an isolation workspace whose ownership is not proven"),
      { code: "conflict" },
    );
  };

  await assert.rejects(sessions.delete!(ref.id), { code: "conflict" });

  assert.equal(f.domain.projections.has(ref.id), true);
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "active");
  assert.equal((await sessions.snapshot(ref.id)).id, ref.id);
  assert.ok((await sessions.list("prj_one")).some((row) => row.id === ref.id));
  await assert.rejects(sessions.delete!(ref.id), { code: "conflict" });
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "active");
});

test("failed delete keeps the fence once the domain projection is purged", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one" });
  const deleteDomain = f.base.delete!;
  f.base.delete = async (id: string) => {
    await deleteDomain(id);
    throw Object.assign(new Error("upstream deletion is not confirmed"), { code: "outcome-unknown" });
  };

  await assert.rejects(sessions.delete!(ref.id), { code: "outcome-unknown" });

  assert.equal(f.domain.projections.has(ref.id), false);
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleting");
  await assert.rejects(sessions.snapshot(ref.id), { code: "not-found" });
});

test("missing domain row finalizes an interrupted deleting tombstone on reconciliation", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await sessions.create({ projectId: "prj_one" });
  const resource = f.security.resources.resource(ref.id)!;
  f.security.control.transaction(() => {
    f.security.control.run(
      "UPDATE resources SET lifecycle='deleting',revision=revision+1,access_revision=access_revision+1 WHERE id=? AND revision=?",
      ref.id, resource.revision,
    );
  });
  f.domain.projections.delete(ref.id);
  f.domain.histories.delete(ref.id);

  assert.equal((await sessions.list("prj_one")).some((row) => row.id === ref.id), false);
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleted");
  await sessions.delete!(ref.id);
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleted");
});

test("forked child is admitted with the request actor, while imported delegated child inherits parent owner", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const parent = await sessions.create({ projectId: "prj_one" });
  const fork = await sessions.fork(parent.id);
  assert.equal(f.security.resources.resource(fork.id)?.ownerPrincipalId, "usr_owner");
  assert.equal(f.security.resources.resource(fork.id)?.createdBy, "usr_owner");

  const delegated = f.domain.insertImportedChild(parent.id);
  const listed = await sessions.list("prj_one");
  assert.ok(listed.some((row) => row.id === delegated.id));
  assert.equal(f.security.resources.resource(delegated.id)?.ownerPrincipalId, "usr_owner");
  assert.equal(f.security.resources.resource(delegated.id)?.createdBy, "usr_owner");
});

test("a missing resource for a forked child fails closed instead of inventing its creator", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const parent = await sessions.create({ projectId: "prj_one" });
  const orphan = f.domain.insertForkOrphan(parent.id);
  await assert.rejects(sessions.list("prj_one"), { code: "recovery-required" });
  assert.equal(f.security.resources.resource(orphan.id), undefined);
});

test("a leftover session from a retired Space does not fail closed the current list", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const live = await sessions.create({ projectId: "prj_one" });
  const leftover = f.domain.insertRetiredSpaceLeftover();

  const listed = await sessions.list();
  assert.deepEqual(listed.map((row) => row.id), [live.id]);
  assert.equal(f.security.resources.resource(leftover.id), undefined);
  await assert.rejects(sessions.snapshot(leftover.id), { code: "not-found" });
});

test("an unadopted top-level session in this Space is admitted from its project resource", async t => {
  const f = fixture(t);
  const sessions = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const row = f.domain.insertUnadoptedTopLevel();

  const listed = await sessions.list("prj_one");
  assert.equal(listed.some((item) => item.id === row.id), true);
  const resource = f.security.resources.resource(row.id);
  assert.equal(resource?.kind, "session");
  assert.equal(resource?.lifecycle, "active");
  assert.equal(resource?.parentId, "prj_one");
  assert.equal((await sessions.snapshot(row.id)).id, row.id);
});

test("viewer can read admitted sessions but cannot create or mutate them", async t => {
  const f = fixture(t);
  const owner = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await owner.create({ projectId: "prj_one" });
  const viewer = canonicalSessionService(f.ctx("usr_viewer", "viewer"), f.base, f.projects);
  assert.equal((await viewer.snapshot(ref.id)).id, ref.id);
  await assert.rejects(viewer.create({ projectId: "prj_one" }), { code: "forbidden" });
  await assert.rejects(viewer.archive(ref.id), { code: "forbidden" });
  await assert.rejects(viewer.send(ref.id, { text: "no", delivery: "enqueue" } as never), { code: "forbidden" });
});


test("workspace checkout mutation obeys member role and archived lifecycle fences", async t => {
  const f = fixture(t);
  const owner = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await owner.create({ projectId: "prj_one" });
  const viewer = canonicalSessionService(f.ctx("usr_viewer", "viewer"), f.base, f.projects);
  await assert.rejects(() => viewer.withWorkspaceMutation!(ref.id, 0, async () => undefined), { code: "forbidden" });
  await owner.archive(ref.id);
  await assert.rejects(() => owner.withWorkspaceMutation!(ref.id, 0, async () => undefined), { code: "conflict" });
});

test("an archived session admits only the release of its isolation record", async t => {
  const f = fixture(t);
  const released: Array<unknown> = [];
  (f.base as { patchIsolation?: unknown }).patchIsolation = async (id: string, isolation: unknown) => {
    released.push(isolation);
    return f.base.snapshot(id);
  };
  const owner = canonicalSessionService(f.ctx("usr_owner", "owner"), f.base, f.projects);
  const ref = await owner.create({ projectId: "prj_one" });
  await owner.archive(ref.id);
  await assert.rejects(() => owner.patchIsolation!(ref.id, { state: "active" } as never), { code: "conflict" });
  await owner.patchIsolation!(ref.id, null);
  assert.deepEqual(released, [null]);
  const viewer = canonicalSessionService(f.ctx("usr_viewer", "viewer"), f.base, f.projects);
  await assert.rejects(() => viewer.patchIsolation!(ref.id, null), { code: "forbidden" });
});

test("history of a session announced before its create settles is readable instead of not-found", async t => {
  const f = fixture(t);
  const ctx = f.ctx("usr_owner", "owner");
  const sessions = accessControlledSessionService(ctx, canonicalSessionService(ctx, f.base, f.projects));
  let committed!: () => void;
  let settle!: () => void;
  const projectionCommitted = new Promise<void>((resolve) => { committed = resolve; });
  const createSettles = new Promise<void>((resolve) => { settle = resolve; });
  const createDomain = f.base.create.bind(f.base);
  f.base.create = async (input) => {
    const ref = await createDomain(input);
    // The projection is durable and already announced to clients; the native
    // session is still starting, so the canonical resource is still provisioning.
    committed();
    await createSettles;
    return ref;
  };

  const creating = sessions.create({ projectId: "prj_one" });
  await projectionCommitted;
  const [id] = [...f.domain.projections.keys()];
  assert.equal(f.security.resources.resource(id!)?.lifecycle, "provisioning");

  assert.deepEqual(await sessions.events(id!, 0), []);

  settle();
  assert.deepEqual(await creating, { id });
  assert.equal(f.security.resources.resource(id!)?.lifecycle, "active");
  assert.deepEqual(await sessions.events(id!, 0), []);
});

test("history reads keep answering not-found for rows that must stay unreadable", async t => {
  const f = fixture(t);
  const ctx = f.ctx("usr_owner", "owner");
  const sessions = accessControlledSessionService(ctx, canonicalSessionService(ctx, f.base, f.projects));

  // A provisioning resource with no durable projection has nothing to reconcile.
  const orphanId = randomUUID();
  f.security.resources.begin({
    operationId: randomUUID(),
    resourceId: orphanId,
    kind: "session",
    orgId: "org_home",
    spaceId: "spc_home",
    parentId: "prj_one",
    ownerPrincipalId: "usr_owner",
    createdBy: "usr_owner",
    visibility: "inherit",
  });
  await assert.rejects(sessions.events(orphanId, 0), { code: "not-found" });
  assert.equal(f.security.resources.resource(orphanId)?.lifecycle, "provisioning");

  // A deleting fence stays closed even though the projection is still present.
  const ref = await sessions.create({ projectId: "prj_one" });
  const resource = f.security.resources.resource(ref.id)!;
  f.security.control.transaction(() => {
    f.security.control.run(
      "UPDATE resources SET lifecycle='deleting',revision=revision+1,access_revision=access_revision+1 WHERE id=? AND revision=?",
      ref.id, resource.revision,
    );
  });
  await assert.rejects(sessions.events(ref.id, 0), { code: "not-found" });
  assert.equal(f.security.resources.resource(ref.id)?.lifecycle, "deleting");
});

test("a non-member neither reads nor reconciles a session whose create is still settling", async t => {
  const f = fixture(t);
  f.security.control.transaction(() => {
    f.security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_outsider','user','active')");
    f.security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_outsider','Outsider',1,1)");
  });
  const owner = f.ctx("usr_owner", "owner");
  const outsider = f.ctx("usr_outsider", "viewer");
  const ownerSessions = accessControlledSessionService(owner, canonicalSessionService(owner, f.base, f.projects));
  const outsiderSessions = accessControlledSessionService(outsider, canonicalSessionService(outsider, f.base, f.projects));
  let committed!: () => void;
  let settle!: () => void;
  const projectionCommitted = new Promise<void>((resolve) => { committed = resolve; });
  const createSettles = new Promise<void>((resolve) => { settle = resolve; });
  const createDomain = f.base.create.bind(f.base);
  f.base.create = async (input) => {
    const ref = await createDomain(input);
    committed();
    await createSettles;
    return ref;
  };

  const creating = ownerSessions.create({ projectId: "prj_one" });
  await projectionCommitted;
  const [id] = [...f.domain.projections.keys()];

  await assert.rejects(outsiderSessions.events(id!, 0), { code: "not-found" });
  assert.equal(
    f.security.resources.resource(id!)?.lifecycle,
    "provisioning",
    "an unauthorized read must not drive the resource out of provisioning",
  );

  settle();
  await creating;
  assert.equal(f.security.resources.resource(id!)?.lifecycle, "active");
  await assert.rejects(outsiderSessions.events(id!, 0), { code: "not-found" });
});
