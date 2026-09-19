import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuthPrincipal, Project, SessionService } from "@polyth/contracts";
import type { PasswordService } from "@polyth/identity";
import { createAuthService } from "../src/auth.ts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import type { ProjectRegistry } from "../src/projects.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createSpaceGateway } from "../src/spaces.ts";

const testPasswords = (): PasswordService => ({
  async hash(password) { return `test-only:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test-only:${password}`, needsRehash: false }; },
  close() {},
});

function fixture(t: test.TestContext, ready = true, debugAgentAccess = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-runtime-security-"));
  const security = createCanonicalSecurity({
    dataDir,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
    ...(debugAgentAccess ? { debugAgentAccess: true } : {}),
    passwords: testPasswords(),
  });
  if (ready) {
    security.control.transaction(() => {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',0,0)");
      security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_main','Main','org_main')");
      security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_main','usr_owner','owner')");
      security.control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_owner','owner')");
      security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES('spc_home','org_main','Personal','spc_home','personal',1,0,0)");
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',0)");
      security.control.run("INSERT INTO password_credentials(user_id,login_name,password_hash,changed_at_ms) VALUES('usr_owner','owner','test-only:password',0)");
      security.control.run("UPDATE installation SET state='ready' WHERE singleton=1");
    });
  }
  const binding = bindCanonicalSecurity(security);
  t.after(() => {
    binding.dispose();
    security.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, security };
}

test("bound auth facade never opens legacy auth.json and loopback does not manufacture a user", t => {
  const { dataDir, security } = fixture(t);
  const auth = createAuthService({
    file: join(dataDir, "auth.json"),
    envPassword: "must-be-ignored",
    localhostOptional: true,
  });
  assert.equal(existsSync(join(dataDir, "auth.json")), false);
  assert.equal(auth.enabled(), true);
  assert.deepEqual(auth.accountIds(), ["usr_owner"]);
  assert.equal(auth.hasCredential("usr_owner"), true);
  assert.throws(() => auth.setPassword("usr_owner", "replacement"), { code: "unavailable" });

  const anonymous = auth.resolve(
    { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    { kind: "public-http", listenerId: "public", loopback: true, secure: false },
  );
  assert.equal(anonymous.authenticated, false);
  assert.equal(anonymous.principal.kind, "anonymous");

  const issued = security.control.transaction(() => security.identity.sessions.issue("usr_owner", "test"));
  const cookie = `${security.auth.cookieName()}=${issued.token}`;
  const resolved = auth.resolve(
    { headers: { cookie }, socket: { remoteAddress: "127.0.0.1" } },
    { kind: "public-http", listenerId: "public", loopback: true, secure: false },
  );
  assert.equal(resolved.authenticated, true);
  assert.equal(auth.userIdForPrincipal(resolved.principal), "usr_owner");
  assert.equal(auth.tokenOf({ headers: { cookie: `${cookie}; ${cookie}` }, socket: {} }), null);

  auth.logout(issued.token);
  assert.equal(auth.resolve(
    { headers: { cookie }, socket: { remoteAddress: "127.0.0.1" } },
    { kind: "public-http", listenerId: "public", loopback: true, secure: false },
  ).authenticated, false);
});


test("validated canonical debug authority reaches the bound auth facade only on loopback", t => {
  const { dataDir } = fixture(t, true, true);
  const auth = createAuthService({ file: join(dataDir, "auth.json") });
  const local = auth.resolve(
    { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    { kind: "public-http", listenerId: "public", loopback: true, secure: false },
  );
  assert.equal(local.authenticated, true);
  assert.equal(local.principal.kind, "local-user");
  assert.equal(auth.userIdForPrincipal(local.principal), "usr_owner");

  const remote = auth.resolve(
    { headers: {}, socket: { remoteAddress: "10.0.0.2" } },
    { kind: "public-http", listenerId: "public", loopback: false, secure: false },
  );
  assert.equal(remote.authenticated, false);
  assert.equal(remote.principal.kind, "anonymous");
});

test("bound Space gateway never opens tenancy.json and internal runtime does not impersonate owner", async t => {
  const { dataDir } = fixture(t);
  const projects = {
    spaceOfProject: (id: string) => id === "prj" ? "spc_home" : undefined,
    adoptIntoSpace: () => assert.fail("canonical boot must not run legacy project adoption"),
    forSpace: () => ({}) as never,
  } as unknown as ProjectRegistry;
  const sessionStore = {
    spaceOfSession: (id: string) => id === "ses" ? "spc_home" : undefined,
    adoptSessionsIntoSpace: async () => assert.fail("canonical boot must not run legacy session adoption"),
  };
  const { gateway, migration } = await createSpaceGateway({
    dataDir,
    registry: projects,
    store: sessionStore,
    sessions: () => ({} as SessionService),
    deployment: "local-trusted",
  });
  assert.equal(existsSync(join(dataDir, "tenancy.json")), false);
  assert.equal(migration.created, false);
  assert.equal(migration.projectsAdopted, 0);
  assert.equal(migration.sessionsAdopted, 0);

  const human = gateway.resolve({
    kind: "ui-session",
    sessionId: "ses_auth",
    rememberedDeviceId: "browser",
    userId: "usr_owner",
  } as AuthPrincipal & { userId: string });
  assert.equal(human.userId, "usr_owner");
  assert.equal(human.spaceId, "spc_home");

  const system = gateway.resolveInternal("spc_home") as typeof human & {
    authority?: { kind: string; serviceId: string };
  };
  assert.equal(system.userId, "system:polyth-runtime");
  assert.equal(system.spaceId, "spc_home");
  assert.equal(system.authority?.kind, "system");
  assert.throws(() => gateway.store.requireMembership(system.userId, system.spaceId), { code: "not-found" });
});

test("application runtime cannot start through tenancy seam before canonical setup is ready", async t => {
  const { dataDir } = fixture(t, false);
  await assert.rejects(() => createSpaceGateway({
    dataDir,
    registry: {} as ProjectRegistry,
    store: {
      spaceOfSession: () => undefined,
      adoptSessionsIntoSpace: async () => 0,
    },
    sessions: () => ({} as SessionService),
  }), { code: "setup-required" });
  assert.equal(existsSync(join(dataDir, "tenancy.json")), false);
});
