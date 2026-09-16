import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import type { AuthPrincipal, Project, SessionService } from "@polyth/contracts";
import type { ProjectRegistry } from "../src/projects.ts";
import { createCanonicalSpaceGateway } from "../src/canonicalSpaces.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-canonical-spaces-"));
  const control = openControlPlane({ directory: dir });
  t.after(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
  control.transaction(() => {
    control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',0,0)");
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_main','Main','org_main')");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_main','usr_owner','owner')");
    control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_owner','owner')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES('spc_home','org_main','Personal','spc_home','personal',1,0,0)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',0)");
    control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });
  const projects = {
    spaceOfProject(projectId: string) { return projectId === "prj" ? "spc_home" : undefined; },
  } as unknown as ProjectRegistry;
  const sessionStore = {
    spaceOfSession(sessionId: string) { return sessionId === "ses" ? "spc_home" : undefined; },
    adoptSessionsIntoSpace() { return 0; },
  };
  const gateway = createCanonicalSpaceGateway({
    control,
    dataDir: dir,
    registry: projects,
    store: sessionStore,
    sessions: () => ({} as SessionService),
    deployment: "local-trusted",
  });
  return { gateway };
}

test("canonical Space gateway resolves an explicitly identified member", t => {
  const { gateway } = fixture(t);
  const principal = {
    kind: "ui-session",
    sessionId: "ses_auth",
    rememberedDeviceId: "browser",
    userId: "usr_owner",
  } as AuthPrincipal & { userId: string };
  const context = gateway.resolve(principal);
  assert.equal(context.userId, "usr_owner");
  assert.equal(context.spaceId, "spc_home");
  assert.equal(context.role, "owner");
});

test("internal services never inherit a human Space", t => {
  const { gateway } = fixture(t);
  assert.throws(() => gateway.resolveInternal(), { code: "unauthorized" });
  assert.throws(() => gateway.resolveInternal("spc_home"), { code: "unauthorized" });
  assert.throws(() => gateway.resolve({ kind: "internal-service", serviceId: "polyth-control" }), { code: "unauthorized" });
});
