import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "../src/index.ts";
import { createResourceAccessAuthority } from "../src/resourceAccess.ts";
import { createResourceRegistry } from "../src/resources.ts";

test("resource access enforces space, owner-only and inherited visibility with membership expiry", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-access-"));
  const control = openControlPlane({ directory: root });
  let now = 1_000;
  const resources = createResourceRegistry(control, { now: () => now });
  const access = createResourceAccessAuthority(control, resources, { now: () => now });
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });

  control.transaction(() => {
    for (const id of ["usr_owner", "usr_member", "usr_expiring", "usr_outside"]) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, id);
    }
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES('spc_home','usr_owner','owner','active',1)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES('spc_home','usr_member','member','active',1)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms,expires_at_ms) VALUES('spc_home','usr_expiring','member','active',1,1500)");
  });

  const activate = (operationId: string, resourceId: string, visibility: "space" | "private" | "restricted" | "inherit", parentId?: string) => {
    const begun = resources.begin({
      operationId, resourceId, kind: parentId ? "session" : "project",
      orgId: "org_home", spaceId: "spc_home", ...(parentId ? { parentId } : {}),
      ownerPrincipalId: "usr_owner", createdBy: "usr_owner", visibility,
    });
    resources.recordDomainReady(operationId, resourceId);
    return resources.activate(operationId, begun.resource.revision);
  };

  activate("op_space", "prj_space", "space");
  activate("op_private", "prj_private", "private");
  activate("op_restricted", "prj_restricted", "restricted");
  activate("op_child", "ses_child", "inherit", "prj_space");
  const systemBegun = resources.begin({
    operationId: "op_system", resourceId: "prj_system", kind: "project",
    orgId: "org_home", spaceId: "spc_home",
    ownerPrincipalId: "system:polyth-runtime", createdBy: "system:polyth-runtime", visibility: "private",
  });
  resources.recordDomainReady("op_system", "prj_system");
  resources.activate("op_system", systemBegun.resource.revision);

  const input = (resourceId: string, principalId: string) => ({ resourceId, principalId, orgId: "org_home", spaceId: "spc_home" });
  assert.equal(access.requireReadable(input("prj_space", "usr_member")).id, "prj_space");
  assert.equal(access.requireReadable(input("ses_child", "usr_member")).id, "ses_child");
  assert.equal(access.requireReadable(input("prj_private", "usr_owner")).id, "prj_private");
  assert.equal(access.readable(input("prj_private", "usr_member")), undefined);
  assert.equal(access.readable(input("prj_restricted", "usr_member")), undefined);
  assert.equal(access.readable(input("prj_space", "usr_outside")), undefined);
  assert.equal(access.requireReadable(input("prj_space", "usr_expiring")).id, "prj_space");
  assert.equal(access.requireReadable(input("prj_system", "system:polyth-runtime")).id, "prj_system");
  // Background runtime work owns no tenant resource and holds no membership, so
  // its read authority is the Space it was already scoped to — and nothing else.
  assert.equal(access.requireReadable(input("prj_private", "system:polyth-runtime")).id, "prj_private");
  assert.equal(access.readable({ ...input("prj_private", "system:polyth-runtime"), spaceId: "spc_other" }), undefined);

  control.transaction(() => control.run("UPDATE resources SET lifecycle='deleting',revision=revision+1 WHERE id='ses_child'"));
  assert.equal(access.readable(input("ses_child", "usr_member")), undefined);
  assert.equal(access.requireReadable({
    ...input("ses_child", "usr_member"),
    lifecycles: ["active", "archived", "archiving", "deleting"],
  }).id, "ses_child");
  assert.equal(access.readable({
    ...input("ses_child", "usr_outside"),
    lifecycles: ["active", "archived", "archiving", "deleting"],
  }), undefined);

  control.transaction(() => control.run("UPDATE space_memberships SET state='revoked' WHERE space_id='spc_home' AND principal_id='usr_owner'"));
  assert.equal(access.readable(input("prj_private", "usr_owner")), undefined);
  assert.equal(access.requireReadable(input("prj_system", "system:polyth-runtime")).id, "prj_system");

  now = 2_000;
  assert.equal(access.readable(input("prj_space", "usr_expiring")), undefined);
  assert.throws(() => access.requireReadable(input("prj_private", "usr_member")), { code: "not-found" });
});

test("an owner-set project list narrows a project and every resource under it, owned or not", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-projects-"));
  const control = openControlPlane({ directory: root });
  const resources = createResourceRegistry(control);
  const allowed = new Map<string, string[]>([["usr_limited", ["prj_allowed"]]]);
  const access = createResourceAccessAuthority(control, resources, {
    projectAllowed: (principalId, projectId) => allowed.get(principalId)?.includes(projectId) ?? true,
  });
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });

  control.transaction(() => {
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    for (const id of ["usr_owner", "usr_limited"]) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, id);
      control.run("INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES('spc_home',?,'member','active',1)", id);
    }
  });
  const activate = (resourceId: string, owner: string, parentId?: string) => {
    const operationId = `op_${resourceId}`;
    const begun = resources.begin({
      operationId, resourceId, kind: parentId ? "session" : "project",
      orgId: "org_home", spaceId: "spc_home", ...(parentId ? { parentId } : {}),
      ownerPrincipalId: owner, createdBy: owner, visibility: parentId ? "inherit" : "space",
    });
    resources.recordDomainReady(operationId, resourceId);
    resources.activate(operationId, begun.resource.revision);
  };
  activate("prj_allowed", "usr_owner");
  activate("prj_hidden", "usr_owner");
  activate("ses_allowed", "usr_owner", "prj_allowed");
  activate("ses_hidden", "usr_owner", "prj_hidden");
  // A chat the limited account started before the owner narrowed its list.
  activate("ses_own_hidden", "usr_limited", "prj_hidden");

  const input = (resourceId: string, principalId: string) => ({ resourceId, principalId, orgId: "org_home", spaceId: "spc_home" });
  assert.equal(access.requireReadable(input("prj_allowed", "usr_limited")).id, "prj_allowed");
  assert.equal(access.requireReadable(input("ses_allowed", "usr_limited")).id, "ses_allowed");
  assert.equal(access.readable(input("prj_hidden", "usr_limited")), undefined);
  assert.equal(access.readable(input("ses_hidden", "usr_limited")), undefined);
  assert.equal(access.readable(input("ses_own_hidden", "usr_limited")), undefined);
  assert.throws(() => access.requireReadable(input("ses_hidden", "usr_limited")), { code: "not-found" });
  // Everyone else is unaffected.
  assert.equal(access.requireReadable(input("ses_hidden", "usr_owner")).id, "ses_hidden");
});
