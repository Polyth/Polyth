import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { openControlPlane } from "@polyth/control-plane";
import type { SessionService, SpaceContext } from "@polyth/contracts";
import { createCanonicalSpaceGateway } from "../src/canonicalSpaces.ts";
import type { ProjectRegistry } from "../src/projects.ts";
import { memorySpaceStore, tmpDataDir } from "./support/spaces.ts";

type AuthoritativeContext = SpaceContext & { instanceOwner: boolean };

test("canonical Space contexts derive instanceOwner from active instance_roles", t => {
  const dataDir = tmpDataDir("polyth-canonical-space-authority-");
  const control = openControlPlane({ directory: dataDir });
  t.after(() => {
    control.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const now = Date.now();
  control.transaction(() => {
    control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", "usr_owner");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)", "usr_owner", "Owner", now, now);
    control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", "usr_admin");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)", "usr_admin", "Admin", now + 1, now + 1);
    control.run("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)", "org_test", "Test", "test");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES(?,?,'owner')", "org_test", "usr_owner");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES(?,?,'member')", "org_test", "usr_admin");
    control.run(
      "INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",
      "spc_test", "org_test", "Test", "spc_test", "shared", 1, now, now,
    );
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,'owner',?)", "spc_test", "usr_owner", now);
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,'admin',?)", "spc_test", "usr_admin", now);
    control.run("INSERT INTO instance_roles(user_id,role) VALUES(?,'owner')", "usr_owner");
  });

  const emptySessions = { list: async () => [], sync: async () => [] } as unknown as SessionService;
  const registry = { spaceOfProject: () => undefined } as unknown as ProjectRegistry;
  const gateway = createCanonicalSpaceGateway({
    control,
    dataDir,
    registry,
    sessions: () => emptySessions,
    store: memorySpaceStore(),
  });

  const owner = gateway.resolver.forUser("usr_owner", "spc_test") as AuthoritativeContext;
  const admin = gateway.resolver.forUser("usr_admin", "spc_test") as AuthoritativeContext;
  assert.equal(owner.role, "owner");
  assert.equal(owner.instanceOwner, true);
  assert.equal(admin.role, "admin");
  assert.equal(admin.instanceOwner, false, "Space admin is not an instance owner");

  control.transaction(() => control.run("DELETE FROM instance_roles WHERE user_id=? AND role='owner'", "usr_owner"));
  const revoked = gateway.resolver.forUser("usr_owner", "spc_test") as AuthoritativeContext;
  assert.equal(revoked.instanceOwner, false, "new contexts re-read canonical instance authority");
});
