import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpaceContext } from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createProjectService } from "../src/projects.ts";
import { canonicalProjectService } from "../src/projectResourceAuthority.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-project-resource-"));
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
  });
  const binding = bindCanonicalSecurity(security);
  const registry = createProjectService(root);
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
  return { root, security, registry, ctx };
}

test("project create reserves the canonical id before domain persistence and activates only after durability", async t => {
  const f = fixture(t);
  const path = join(f.root, "work", "one");
  mkdirSync(path, { recursive: true });
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const project = await service.add(path, "One");

  const resource = f.security.resources.resource(project.id);
  assert.ok(resource);
  assert.equal(resource.kind, "project");
  assert.equal(resource.orgId, "org_home");
  assert.equal(resource.spaceId, "spc_home");
  assert.equal(resource.ownerPrincipalId, "usr_owner");
  assert.equal(resource.createdBy, "usr_owner");
  assert.equal(resource.lifecycle, "active");
  assert.deepEqual((await service.list()).map(row => row.id), [project.id]);
});

test("durable project plus interrupted control finalization self-heals the existing provisioning saga", async t => {
  const f = fixture(t);
  const projectId = randomUUID();
  const operationId = randomUUID();
  const path = join(f.root, "work", "pending");
  mkdirSync(path, { recursive: true });
  f.security.resources.begin({
    operationId,
    resourceId: projectId,
    kind: "project",
    orgId: "org_home",
    spaceId: "spc_home",
    ownerPrincipalId: "usr_owner",
    createdBy: "usr_owner",
    visibility: "space",
  });
  await f.registry.provision({ id: projectId, spaceId: "spc_home", path, name: "Pending" });
  assert.equal(f.security.resources.resource(projectId)?.lifecycle, "provisioning");

  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const visible = await service.get(projectId);
  assert.equal(visible?.id, projectId);
  assert.equal(f.security.resources.resource(projectId)?.lifecycle, "active");
  assert.equal(f.security.resources.provisioning(operationId)?.state, "finalized");
});

test("project deletion closes canonical access first and leaves a durable deleted resource tombstone", async t => {
  const f = fixture(t);
  const path = join(f.root, "work", "remove");
  mkdirSync(path, { recursive: true });
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const project = await service.add(path, "Remove");
  await service.remove(project.id);

  assert.equal(await service.get(project.id), undefined);
  assert.equal(f.security.resources.resource(project.id)?.lifecycle, "deleted");
  assert.equal(f.security.resources.active(project.id, { orgId: "org_home", spaceId: "spc_home" }), undefined);
});

test("viewer can read active projects but cannot create, update, or delete them", async t => {
  const f = fixture(t);
  const path = join(f.root, "work", "shared");
  mkdirSync(path, { recursive: true });
  const owner = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const project = await owner.add(path, "Shared");
  const viewer = canonicalProjectService(f.ctx("usr_viewer", "viewer"), f.registry);

  assert.equal((await viewer.get(project.id))?.id, project.id);
  await assert.rejects(viewer.create(join(f.root, "viewer-create"), "No"), { code: "forbidden" });
  await assert.rejects(viewer.update!(project.id, { name: "No" }), { code: "forbidden" });
  await assert.rejects(viewer.remove(project.id), { code: "forbidden" });
});
