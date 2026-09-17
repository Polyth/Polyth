import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { packageWorkspace, RUNTIME_SYSTEM_PRINCIPAL_ID } from "@polyth/plugins";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { canonicalProjectService } from "../src/projectResourceAuthority.ts";
import { createProjectService } from "../src/projects.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";

const storage = (ctx: SpaceContext): SpaceStorage => ({
  root: resolve(ctx.storageDir),
  packageDir: (packageId) => join(resolve(ctx.storageDir), "packages", packageId),
  path: (relative) => join(resolve(ctx.storageDir), relative),
});

test("package workspace is canonicalized only through the system project facade", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-workspace-canonical-"));
  const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true });
  security.control.transaction(() => {
    security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
    security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',1,1)");
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_owner','owner')");
    security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',1)");
  });
  const binding = bindCanonicalSecurity(security);
  const projects = createProjectService(root);
  t.after(() => {
    binding.dispose();
    security.close();
    rmSync(root, { recursive: true, force: true });
  });

  const human: SpaceContext = {
    spaceId: "spc_home", spaceSlug: "home", userId: "usr_owner", role: "owner",
    deployment: "local-trusted", storageDir: join(root, "spaces", "home"),
  };
  const host = {
    pluginId: "personal-coach",
    projects,
    spaceStorage: storage,
    forSpace(ctx: SpaceContext) {
      return { projects: canonicalProjectService(ctx, projects), sessions: {} as never };
    },
  };

  const workspace = await packageWorkspace(host, human);
  assert.match(workspace.projectId, /^__polyth_pkg_[a-f0-9]{32}$/);
  const resource = security.resources.resource(workspace.projectId);
  assert.ok(resource);
  assert.equal(resource.kind, "project");
  assert.equal(resource.spaceId, "spc_home");
  assert.equal(resource.lifecycle, "active");
  assert.equal(resource.ownerPrincipalId, RUNTIME_SYSTEM_PRINCIPAL_ID);
  assert.equal(resource.createdBy, RUNTIME_SYSTEM_PRINCIPAL_ID);

  const humanView = canonicalProjectService(human, projects);
  assert.equal((await humanView.get(workspace.projectId))?.id, workspace.projectId);
});
