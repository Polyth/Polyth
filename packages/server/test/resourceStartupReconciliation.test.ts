import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, SessionProjection } from "@polyth/contracts";
import type { ProjectRegistry } from "../src/projects.ts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { reconcileCanonicalResourcesAtBoot } from "../src/resourceStartupReconciliation.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-boot-"));
  const security = createCanonicalSecurity({
    dataDir: root,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
    now: () => 1_000,
  });
  security.control.transaction(() => {
    security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
    security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',1,1)");
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_owner','owner')");
    security.control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_owner','owner')");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1,1)");
    security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',1)");
    security.control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });

  const projects = new Map<string, Project>();
  const projections = new Map<string, SessionProjection>();
  const registry = {
    async get(id: string) { return projects.get(id); },
  } as unknown as ProjectRegistry;
  const sessions = {
    async projection(id: string) { return projections.get(id); },
  };
  t.after(() => {
    security.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, security, projects, projections, registry, sessions };
}

const project = (id: string): Project => ({
  id,
  path: `/workspace/${id}`,
  name: id,
  spaceId: "spc_home",
  createdAt: 10,
});
const projection = (id: string, status: SessionProjection["status"] = "idle"): SessionProjection => ({
  id,
  projectId: "prj_parent",
  spaceId: "spc_home",
  title: id,
  status,
  createdAt: 10,
  updatedAt: 10,
} as SessionProjection);

function activeProjectResource(f: ReturnType<typeof fixture>, id = "prj_parent"): void {
  f.security.control.transaction(() => f.security.control.run(
    `INSERT INTO resources(id,kind,org_id,space_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
     VALUES(?,'project','org_home','spc_home','usr_owner','usr_owner','space','active',1,1)`,
    id,
  ));
  f.projects.set(id, project(id));
}

function beginProject(f: ReturnType<typeof fixture>, operationId: string, id: string) {
  return f.security.resources.begin({
    operationId,
    resourceId: id,
    kind: "project",
    orgId: "org_home",
    spaceId: "spc_home",
    ownerPrincipalId: "usr_owner",
    createdBy: "usr_owner",
    visibility: "space",
  });
}

function beginSession(f: ReturnType<typeof fixture>, operationId: string, id: string) {
  return f.security.resources.begin({
    operationId,
    resourceId: id,
    kind: "session",
    orgId: "org_home",
    spaceId: "spc_home",
    parentId: "prj_parent",
    ownerPrincipalId: "usr_owner",
    createdBy: "usr_owner",
    visibility: "inherit",
  });
}

test("startup finalizes durable project provisioning and aborts missing uncommitted provisioning", async t => {
  const f = fixture(t);
  beginProject(f, "op_project_durable", "prj_durable");
  f.projects.set("prj_durable", project("prj_durable"));
  beginProject(f, "op_project_missing", "prj_missing");

  const result = await reconcileCanonicalResourcesAtBoot({
    security: f.security,
    projects: f.registry,
    sessions: f.sessions,
  });

  assert.equal(result.provisioningFinalized, 1);
  assert.equal(result.provisioningAborted, 1);
  assert.equal(f.security.resources.resource("prj_durable")?.lifecycle, "active");
  assert.equal(f.security.resources.resource("prj_missing")?.lifecycle, "deleted");
  assert.equal(f.security.resources.provisioning("op_project_missing")?.state, "aborted");
});

test("startup reconciles session archive, restore and committed hard delete before serving", async t => {
  const f = fixture(t);
  activeProjectResource(f);

  beginSession(f, "op_session_new", "ses_new");
  f.projections.set("ses_new", projection("ses_new"));

  beginSession(f, "op_session_archive", "ses_archive");
  f.projections.set("ses_archive", projection("ses_archive"));
  f.security.resources.recordDomainReady("op_session_archive", JSON.stringify({ id: "ses_archive", projectId: "prj_parent", spaceId: "spc_home", parentId: null }));
  f.security.resources.activate("op_session_archive", f.security.resources.resource("ses_archive")!.revision);
  let archive = f.security.resources.resource("ses_archive")!;
  archive = f.security.resourceLifecycle.transition({
    resourceId: archive.id, kind: archive.kind, orgId: archive.orgId, spaceId: archive.spaceId,
    from: ["active"], to: "archiving", expectedRevision: archive.revision,
    actor: "usr_owner", action: "resource.archiving",
  });
  f.projections.set("ses_archive", projection("ses_archive", "archived"));

  beginSession(f, "op_session_restore", "ses_restore");
  f.projections.set("ses_restore", projection("ses_restore"));
  f.security.resources.recordDomainReady("op_session_restore", JSON.stringify({ id: "ses_restore", projectId: "prj_parent", spaceId: "spc_home", parentId: null }));
  f.security.resources.activate("op_session_restore", f.security.resources.resource("ses_restore")!.revision);
  let restore = f.security.resources.resource("ses_restore")!;
  restore = f.security.resourceLifecycle.transition({
    resourceId: restore.id, kind: restore.kind, orgId: restore.orgId, spaceId: restore.spaceId,
    from: ["active"], to: "archiving", expectedRevision: restore.revision,
    actor: "usr_owner", action: "resource.archiving",
  });
  restore = f.security.resourceLifecycle.transition({
    resourceId: restore.id, kind: restore.kind, orgId: restore.orgId, spaceId: restore.spaceId,
    from: ["archiving"], to: "archived", expectedRevision: restore.revision,
    actor: "usr_owner", action: "resource.archived",
  });

  beginSession(f, "op_session_delete", "ses_delete");
  f.projections.set("ses_delete", projection("ses_delete"));
  f.security.resources.recordDomainReady("op_session_delete", JSON.stringify({ id: "ses_delete", projectId: "prj_parent", spaceId: "spc_home", parentId: null }));
  f.security.resources.activate("op_session_delete", f.security.resources.resource("ses_delete")!.revision);
  const deleting = f.security.resources.resource("ses_delete")!;
  f.security.resourceLifecycle.transition({
    resourceId: deleting.id, kind: deleting.kind, orgId: deleting.orgId, spaceId: deleting.spaceId,
    from: ["active"], to: "deleting", expectedRevision: deleting.revision,
    actor: "usr_owner", action: "resource.deleting",
  });
  f.projections.delete("ses_delete");

  const result = await reconcileCanonicalResourcesAtBoot({
    security: f.security,
    projects: f.registry,
    sessions: f.sessions,
  });

  assert.equal(result.provisioningFinalized, 1);
  assert.equal(result.archivesFinalized, 1);
  assert.equal(result.restoresFinalized, 1);
  assert.equal(result.deletionsFinalized, 1);
  assert.equal(f.security.resources.resource("ses_new")?.lifecycle, "active");
  assert.equal(f.security.resources.resource("ses_archive")?.lifecycle, "archived");
  assert.equal(f.security.resources.resource("ses_restore")?.lifecycle, "active");
  assert.equal(f.security.resources.resource("ses_delete")?.lifecycle, "deleted");
});

test("a durable receipt without its domain row blocks boot instead of being aborted", async t => {
  const f = fixture(t);
  beginProject(f, "op_uncertain", "prj_uncertain");
  f.security.resources.recordDomainReady("op_uncertain", "durable-domain-receipt");

  await assert.rejects(() => reconcileCanonicalResourcesAtBoot({
    security: f.security,
    projects: f.registry,
    sessions: f.sessions,
  }), { code: "recovery-required" });
  assert.equal(f.security.resources.resource("prj_uncertain")?.lifecycle, "provisioning");
  assert.equal(f.security.resources.provisioning("op_uncertain")?.state, "domain-ready");
});

test("scope or parent mismatch blocks boot before the resource can be served", async t => {
  const f = fixture(t);
  activeProjectResource(f);
  beginSession(f, "op_bad_parent", "ses_bad");
  f.projections.set("ses_bad", {
    ...projection("ses_bad"),
    projectId: "different-project",
  });

  await assert.rejects(() => reconcileCanonicalResourcesAtBoot({
    security: f.security,
    projects: f.registry,
    sessions: f.sessions,
  }), { code: "recovery-required" });
  assert.equal(f.security.resources.resource("ses_bad")?.lifecycle, "provisioning");
});
