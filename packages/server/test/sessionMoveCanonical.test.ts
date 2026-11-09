import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Project,
  ProjectService,
  SessionMoveHooks,
  SessionMoveInput,
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { reconcileCanonicalResourcesAtBoot } from "../src/resourceStartupReconciliation.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { accessControlledSessionService } from "../src/sessionResourceAccess.ts";
import { canonicalSessionService } from "../src/sessionResourceAuthority.ts";
import { sessionAccess } from "../src/sessionSharing.ts";
import type { ProjectRegistry } from "../src/projects.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-move-canonical-"));
  const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true, now: () => 1_000 });
  security.control.transaction(() => {
    for (const [id, name] of [["usr_owner", "Owner"], ["usr_member", "Member"], ["usr_viewer", "Viewer"], ["usr_stranger", "Stranger"]] as const) {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
    }
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_far','Far','far')");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_far','org_far','Far','far','shared',1,1)");
    for (const [userId, role] of [["usr_owner", "owner"], ["usr_member", "member"], ["usr_viewer", "viewer"]] as const) {
      security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home',?,?)", userId, role === "viewer" ? "guest" : role);
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home',?,?,1)", userId, role);
    }
    const project = (id: string, org: string, space: string, visibility: string, owner = "usr_owner") => security.control.run(
      `INSERT INTO resources(id,kind,org_id,space_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
       VALUES(?,'project',?,?,?,?,?,'active',1,1)`, id, org, space, owner, owner, visibility);
    project("prj_one", "org_home", "spc_home", "space");
    project("prj_two", "org_home", "spc_home", "space");
    project("prj_mine", "org_home", "spc_home", "private", "usr_member");
    project("prj_secret", "org_home", "spc_home", "private");
    project("prj_viewable", "org_home", "spc_home", "restricted");
    project("prj_far", "org_far", "spc_far", "space", "usr_owner");
    security.control.run(
      `INSERT INTO resource_grants(resource_id,principal_id,access,granted_by,created_at_ms,updated_at_ms)
       VALUES('prj_viewable','usr_member','view','usr_owner',1,1)`,
    );
  });
  const binding = bindCanonicalSecurity(security);
  const projectRow = (id: string, spaceId = "spc_home"): Project => ({ id, path: join(root, id), name: id, createdAt: 1, spaceId });
  const rows = new Map<string, Project>(["prj_one", "prj_two", "prj_mine", "prj_secret", "prj_viewable"].map((id) => [id, projectRow(id)]));
  rows.set("prj_far", projectRow("prj_far", "spc_far"));
  const projects: ProjectService = {
    async list() { return [...rows.values()]; },
    async add() { return rows.get("prj_one")!; },
    async create() { return rows.get("prj_one")!; },
    async remove() {},
    async get(id) { return rows.get(id); },
  };

  const projections = new Map<string, SessionProjection>();
  const missing = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
  const domainState = { failAfterCommit: false, calls: 0 };
  const base = {
    async create(input: { id?: string; projectId: string; parentId?: string }) {
      const id = input.id ?? randomUUID();
      projections.set(id, {
        id, projectId: input.projectId, spaceId: "spc_home", title: id, status: "idle", createdAt: 1, updatedAt: 1,
        ...(input.parentId ? { parentId: input.parentId } : {}),
      });
      return { id };
    },
    async snapshot(id: string) {
      const row = projections.get(id);
      if (!row) throw missing();
      return { ...row };
    },
    async previewMoveToProject(id: string, input: SessionMoveInput) {
      const row = projections.get(id)!;
      return { sessionId: id, fromProjectId: row.projectId, toProjectId: input.projectId, sessionIds: [id], restartsAgent: false, gains: [], loses: [] };
    },
    async moveToProject(id: string, input: SessionMoveInput, hooks?: SessionMoveHooks) {
      domainState.calls += 1;
      const row = projections.get(id)!;
      const ids = [id, ...[...projections.values()].filter((candidate) => candidate.parentId === id).map((candidate) => candidate.id)];
      const move = { fromProjectId: row.projectId, toProjectId: input.projectId, at: 5, operationId: "op" };
      for (const sessionId of ids) {
        projections.set(sessionId, { ...projections.get(sessionId)!, projectId: input.projectId, projectMove: move });
      }
      // A crash here: the domain committed and the registry never heard.
      if (domainState.failAfterCommit) return { session: { ...projections.get(id)! }, sessionIds: ids };
      hooks?.afterCommit?.(move, ids);
      return { session: { ...projections.get(id)! }, sessionIds: ids };
    },
  } as unknown as SessionService;

  const ctx = (userId: string, role: SpaceContext["role"], spaceId = "spc_home"): SpaceContext => ({
    spaceId,
    spaceSlug: spaceId,
    userId,
    role,
    deployment: "local-trusted",
    storageDir: join(root, "spaces", spaceId),
  });
  /** The stack a request reaches, minus the Space guard tested separately. */
  const as = (userId: string, role: SpaceContext["role"]) =>
    accessControlledSessionService(ctx(userId, role), canonicalSessionService(ctx(userId, role), base, projects));
  t.after(() => {
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { security, projects, rows, projections, domainState, base, ctx, as };
}

const owner = (f: ReturnType<typeof fixture>) => f.as("usr_owner", "owner");

test("the registry follows the chat and its subagents", async (t) => {
  const f = fixture(t);
  const sessions = owner(f);
  const { id } = await sessions.create({ projectId: "prj_one" });
  const child = await sessions.create({ projectId: "prj_one", parentId: id });
  const result = await sessions.moveToProject!(id, { projectId: "prj_two" });
  assert.deepEqual(result.sessionIds, [id, child.id]);
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_two");
  assert.equal(f.security.resources.resource(child.id)?.parentId, "prj_two");
  assert.equal(f.security.resources.resource(child.id)?.accessParentId, id, "a subagent still follows its chat");
  assert.equal((await sessions.snapshot(id)).projectId, "prj_two", "reads agree with the registry");
});

test("a crash between the domain commit and the registry heals on the next read", async (t) => {
  const f = fixture(t);
  const sessions = owner(f);
  const { id } = await sessions.create({ projectId: "prj_one" });
  f.domainState.failAfterCommit = true;
  await sessions.moveToProject!(id, { projectId: "prj_two" });
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_one", "the crash left them apart");
  assert.equal((await sessions.snapshot(id)).projectId, "prj_two");
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_two");
});

test("a crash between the two heals at boot, before anyone reads", async (t) => {
  const f = fixture(t);
  const { id } = await owner(f).create({ projectId: "prj_one" });
  f.domainState.failAfterCommit = true;
  await owner(f).moveToProject!(id, { projectId: "prj_two" });
  const result = await reconcileCanonicalResourcesAtBoot({
    security: f.security,
    projects: { get: f.projects.get } as unknown as ProjectRegistry,
    sessions: { projection: async (sessionId: string) => f.projections.get(sessionId) },
  });
  assert.equal(result.projectMovesFinished, 1);
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_two");
});

test("without the receipt a mismatch is still corruption, not a move", async (t) => {
  const f = fixture(t);
  const sessions = owner(f);
  const { id } = await sessions.create({ projectId: "prj_one" });
  // Domain state says another project, with nothing to prove a move happened.
  f.projections.set(id, { ...f.projections.get(id)!, projectId: "prj_two" });
  await assert.rejects(sessions.snapshot(id), { code: "recovery-required" });
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_one");
  // A receipt naming other projects is no evidence either.
  f.projections.set(id, { ...f.projections.get(id)!, projectMove: { fromProjectId: "prj_secret", toProjectId: "prj_two", at: 1, operationId: "x" } });
  await assert.rejects(sessions.snapshot(id), { code: "recovery-required" });
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_one");
});

test("unknown, another Space's and closed projects answer alike", async (t) => {
  const f = fixture(t);
  const sessions = f.as("usr_member", "member");
  const { id } = await sessions.create({ projectId: "prj_one" });
  for (const projectId of ["prj_nope", "prj_far", "prj_secret"]) {
    await assert.rejects(sessions.moveToProject!(id, { projectId }), { code: "not-found", message: "project not found" }, projectId);
    await assert.rejects(sessions.previewMoveToProject!(id, { projectId }), { code: "not-found", message: "project not found" }, projectId);
  }
  assert.equal(f.domainState.calls, 0);
});

test("a project this person can only view can't receive their chat", async (t) => {
  const f = fixture(t);
  const sessions = f.as("usr_member", "member");
  const { id } = await sessions.create({ projectId: "prj_one" });
  await assert.rejects(sessions.moveToProject!(id, { projectId: "prj_viewable" }), { code: "forbidden" });
  assert.equal(f.domainState.calls, 0);
});

test("moving a chat takes manage access; a foreign id reads as unknown", async (t) => {
  const f = fixture(t);
  const { id } = await owner(f).create({ projectId: "prj_one" });
  const stranger = f.as("usr_member", "member");
  // A chat its owner keeps private reads as nothing to anyone else.
  await assert.rejects(stranger.moveToProject!(id, { projectId: "prj_two" }), { code: "not-found" });
  await assert.rejects(f.as("usr_stranger", "member").moveToProject!(id, { projectId: "prj_two" }), { code: "not-found" });
  // Opened to the Space, a member can work in it but not move it.
  f.security.sharing.share({ resourceId: id, orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "space" });
  assert.equal(sessionAccess("usr_member", "spc_home", id)?.level, "collaborate");
  await assert.rejects(stranger.moveToProject!(id, { projectId: "prj_two" }), { code: "forbidden" });
  await assert.rejects(stranger.previewMoveToProject!(id, { projectId: "prj_two" }), { code: "forbidden" });
  // A Space viewer never acts above view.
  await assert.rejects(f.as("usr_viewer", "viewer").moveToProject!(id, { projectId: "prj_two" }), { code: "forbidden" });
  assert.equal(f.domainState.calls, 0);
  assert.equal(f.security.resources.resource(id)?.parentId, "prj_one");
});

/** A chat that follows its project: server work, or one from before sharing. */
async function inheriting(f: ReturnType<typeof fixture>, projectId: string, actor = owner(f)) {
  const { id } = await actor.create({ projectId });
  f.security.sharing.share({ resourceId: id, orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "inherit" });
  return id;
}

test("the preview names who gains and who loses a chat that follows its project", async (t) => {
  const f = fixture(t);
  const sessions = owner(f);
  const id = await inheriting(f, "prj_secret");
  const wider = await sessions.previewMoveToProject!(id, { projectId: "prj_one" });
  assert.deepEqual(wider.gains.map((person) => person.name).sort(), ["Member", "Viewer"]);
  assert.deepEqual(wider.loses, []);
  await sessions.moveToProject!(id, { projectId: "prj_one" });
  const narrower = await sessions.previewMoveToProject!(id, { projectId: "prj_secret" });
  assert.deepEqual(narrower.gains, []);
  assert.deepEqual(narrower.loses.map((person) => person.name).sort(), ["Member", "Viewer"]);
  assert.equal(sessionAccess("usr_member", "spc_home", id)?.level, "collaborate", "access really followed");
});

test("a private chat keeps its audience wherever it goes", async (t) => {
  const f = fixture(t);
  const sessions = owner(f);
  const { id } = await sessions.create({ projectId: "prj_secret" });
  const preview = await sessions.previewMoveToProject!(id, { projectId: "prj_one" });
  assert.deepEqual([preview.gains, preview.loses], [[], []]);
  await sessions.moveToProject!(id, { projectId: "prj_one" });
  assert.equal(sessionAccess("usr_member", "spc_home", id), undefined, "still only its owner's");
});

test("a chat where the agent read personal notes can't move where others could read it", async (t) => {
  const f = fixture(t);
  const sessions = owner(f);
  const id = await inheriting(f, "prj_secret");
  f.projections.set(id, { ...f.projections.get(id)!, personalContext: true });
  const preview = await sessions.previewMoveToProject!(id, { projectId: "prj_one" });
  assert.equal(preview.blocked?.reason, "private");
  await assert.rejects(sessions.moveToProject!(id, { projectId: "prj_one" }), (error: { code?: string; reason?: string }) =>
    error.code === "conflict" && error.reason === "private");
  assert.equal(f.domainState.calls, 0);
  // Nobody new reads it there: narrowing is always allowed.
  const staysPrivate = await sessions.create({ projectId: "prj_secret" });
  f.projections.set(staysPrivate.id, { ...f.projections.get(staysPrivate.id)!, personalContext: true });
  await sessions.moveToProject!(staysPrivate.id, { projectId: "prj_one" });
  assert.equal(f.security.resources.resource(staysPrivate.id)?.parentId, "prj_one");
});

test("the Space policy that limits sharing limits a move that widens", async (t) => {
  const f = fixture(t);
  f.security.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_owner", patch: { membersMayShare: false } });
  const member = f.as("usr_member", "member");
  const id = await inheriting(f, "prj_mine", member);
  const preview = await member.previewMoveToProject!(id, { projectId: "prj_one" });
  assert.equal(preview.blocked?.reason, "widening");
  await assert.rejects(member.moveToProject!(id, { projectId: "prj_one" }), (error: { reason?: string }) => error.reason === "widening");
  assert.equal(f.domainState.calls, 0);
});
