import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { openControlPlane } from "@polyth/control-plane";
import type { SessionService, SpaceContext } from "@polyth/contracts";
import { createCanonicalSpaceGateway } from "../src/canonicalSpaces.ts";
import type { ProjectRegistry } from "../src/projects.ts";
import { memorySpaceStore, tmpDataDir } from "./support/spaces.ts";

type AuthoritativeContext = SpaceContext & { instanceOwner: boolean; harnessManager: boolean; harnessPersonal: boolean };

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

test("canonical Space contexts derive harnessManager from an active account's permissions", t => {
  const dataDir = tmpDataDir("polyth-canonical-harness-manager-");
  const control = openControlPlane({ directory: dataDir });
  t.after(() => {
    control.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const now = Date.now();
  control.transaction(() => {
    for (const id of ["usr_ira", "usr_bob"]) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)", id, id, now, now);
    }
    control.run("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)", "org_test", "Test", "test");
    control.run(
      "INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",
      "spc_test", "org_test", "Test", "spc_test", "shared", 1, now, now,
    );
    for (const id of ["usr_ira", "usr_bob"]) {
      control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES(?,?,'member')", "org_test", id);
      control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,'member',?)", "spc_test", id, now);
    }
    control.run(
      "INSERT INTO account_permissions(user_id,permissions_json,revision,updated_by,updated_at_ms) VALUES(?,?,1,?,?)",
      "usr_ira", JSON.stringify(["harnesses.manage"]), "usr_owner", now,
    );
    control.run(
      "INSERT INTO account_permissions(user_id,permissions_json,revision,updated_by,updated_at_ms) VALUES(?,?,1,?,?)",
      "usr_bob", JSON.stringify(["harnesses.personal"]), "usr_owner", now,
    );
  });
  const gateway = createCanonicalSpaceGateway({
    control,
    dataDir,
    registry: { spaceOfProject: () => undefined } as unknown as ProjectRegistry,
    sessions: () => ({ list: async () => [], sync: async () => [] }) as unknown as SessionService,
    store: memorySpaceStore(),
  });
  const ida = gateway.resolver.forUser("usr_ira", "spc_test") as AuthoritativeContext;
  const bob = gateway.resolver.forUser("usr_bob", "spc_test") as AuthoritativeContext;
  assert.equal(ida.harnessManager, true);
  assert.equal(ida.instanceOwner, false, "a permission is not instance ownership");
  assert.equal(bob.harnessManager, false, "harnesses.personal is not harnesses.manage");
  assert.equal(bob.harnessPersonal, true);
  assert.equal(ida.harnessPersonal, false);

  control.transaction(() => control.run("UPDATE account_permissions SET permissions_json='[]',revision=2 WHERE user_id=?", "usr_ira"));
  assert.equal((gateway.resolver.forUser("usr_ira", "spc_test") as AuthoritativeContext).harnessManager, false, "new contexts re-read the grant");
});
