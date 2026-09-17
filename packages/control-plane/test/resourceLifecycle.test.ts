import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "../src/index.ts";
import { createResourceRegistry } from "../src/resources.ts";
import { createResourceLifecycleAuthority } from "../src/resourceLifecycle.ts";

test("resource lifecycle authority enforces graph, scope and optimistic revision", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-lifecycle-"));
  const control = openControlPlane({ directory: root });
  let now = 100;
  const resources = createResourceRegistry(control, { now: () => now });
  const lifecycle = createResourceLifecycleAuthority(control, resources, { now: () => now });
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });

  control.transaction(() => {
    control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',1,1)");
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
  });
  const begun = resources.begin({
    operationId: "op_resource",
    resourceId: "prj_one",
    kind: "project",
    orgId: "org_home",
    spaceId: "spc_home",
    ownerPrincipalId: "usr_owner",
    createdBy: "usr_owner",
    visibility: "space",
  });
  resources.recordDomainReady("op_resource", "durable project");
  const active = resources.activate("op_resource", begun.resource.revision);
  assert.equal(active.lifecycle, "active");

  now = 200;
  const archiving = lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["active"], to: "archiving", expectedRevision: active.revision,
    actor: "usr_owner", action: "resource.archiving",
  });
  assert.equal(archiving.lifecycle, "archiving");
  assert.equal(archiving.updatedAt, 200);
  assert.equal(archiving.accessRevision, active.accessRevision + 1);

  assert.throws(() => lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["active"], to: "deleting", expectedRevision: active.revision,
    actor: "usr_owner", action: "resource.deleting",
  }), (error: unknown) => ["conflict", "invalid-transition"].includes(String((error as { code?: unknown }).code)));

  const archived = lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["archiving"], to: "archived", expectedRevision: archiving.revision,
    actor: "usr_owner", action: "resource.archived",
  });
  const restored = lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["archived"], to: "active", expectedRevision: archived.revision,
    actor: "usr_owner", action: "resource.restored",
  });
  const deleting = lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["active"], to: "deleting", expectedRevision: restored.revision,
    actor: "usr_owner", action: "resource.deleting",
  });
  const deleted = lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["deleting"], to: "deleted", expectedRevision: deleting.revision,
    actor: "system:resource-reconciler", action: "resource.delete-reconciled", bumpAccess: false,
  });
  assert.equal(deleted.lifecycle, "deleted");
  assert.equal(deleted.accessRevision, deleting.accessRevision);

  assert.throws(() => lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_other", spaceId: "spc_home",
    from: ["deleted"], to: "active", expectedRevision: deleted.revision,
    actor: "usr_owner", action: "resource.invalid",
  }), { code: "invalid-transition" });
  assert.throws(() => lifecycle.transition({
    resourceId: "prj_one", kind: "project", orgId: "org_home", spaceId: "spc_home",
    from: ["active"], to: "deleted", expectedRevision: deleted.revision,
    actor: "usr_owner", action: "resource.invalid",
  }), { code: "invalid-transition" });
});
