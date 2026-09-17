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

  const input = (resourceId: string, principalId: string) => ({ resourceId, principalId, orgId: "org_home", spaceId: "spc_home" });
  assert.equal(access.requireReadable(input("prj_space", "usr_member")).id, "prj_space");
  assert.equal(access.requireReadable(input("ses_child", "usr_member")).id, "ses_child");
  assert.equal(access.requireReadable(input("prj_private", "usr_owner")).id, "prj_private");
  assert.equal(access.readable(input("prj_private", "usr_member")), undefined);
  assert.equal(access.readable(input("prj_restricted", "usr_member")), undefined);
  assert.equal(access.readable(input("prj_space", "usr_outside")), undefined);
  assert.equal(access.requireReadable(input("prj_space", "usr_expiring")).id, "prj_space");

  now = 2_000;
  assert.equal(access.readable(input("prj_space", "usr_expiring")), undefined);
  assert.throws(() => access.requireReadable(input("prj_private", "usr_member")), { code: "not-found" });
});
