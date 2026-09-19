import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import { createIdentityService, type PasswordService } from "@polyth/identity";
import type { AuthPrincipal } from "@polyth/contracts";
import { createCanonicalAuthGateway } from "../src/canonicalAuth.ts";

const passwords: PasswordService = {
  async hash(password) { return `test:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test:${password}`, needsRehash: false }; },
  close() {},
};

async function fixture(
  t: test.TestContext,
  options: { debugAgentAccess?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-canonical-auth-"));
  const control = openControlPlane({ directory: dir });
  const identity = createIdentityService(control, { passwords });
  t.after(() => { identity.close(); control.close(); rmSync(dir, { recursive: true, force: true }); });
  const claim = identity.setup.issueClaim();
  const binding = "a".repeat(64);
  identity.setup.bindClaim(claim.token, binding);
  const recovery = identity.setup.prepareRecovery(claim.token, binding);
  const owner = await identity.setup.complete({
    claimToken: claim.token, browserBinding: binding, name: "Owner", organizationName: "Local",
    login: "owner", password: "owner test passphrase", recoverySetId: recovery.setId, recoveryAcknowledged: true,
  });
  const cookieName = identity.sessions.cookieName();
  const gateway = createCanonicalAuthGateway({ control, identity, cookieName, ...options });
  const request = (cookie?: string) => ({ headers: { ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "127.0.0.1" } });
  return { control, identity, owner, cookieName, gateway, request };
}

test("loopback is never account authority; only the canonical session cookie authenticates", async t => {
  const f = await fixture(t);
  const ingress = { kind: "public-http", listenerId: "public", loopback: true, secure: false } as const;
  assert.equal(f.gateway.resolve(f.request(), ingress).authenticated, false);
  const good = f.gateway.resolve(f.request(`${f.cookieName}=${f.owner.token}`), ingress);
  assert.equal(good.authenticated, true);
  assert.equal((good.principal as AuthPrincipal & { userId?: string }).userId, f.owner.userId);
  assert.equal(f.gateway.resolve(f.request(`${f.cookieName}=bad`), ingress).authenticated, false);
  assert.equal(f.gateway.resolve(f.request(`${f.cookieName}=${f.owner.token}; ${f.cookieName}=${f.owner.token}`), ingress).authenticated, false);
});


test("debug agent access is explicit and restricted to direct public loopback ingress", async t => {
  const f = await fixture(t, { debugAgentAccess: true });
  const loopback = { kind: "public-http", listenerId: "public", loopback: true, secure: false } as const;
  const remote = { kind: "public-http", listenerId: "public", loopback: false, secure: false } as const;

  const local = f.gateway.resolve(f.request(), loopback);
  assert.equal(local.authenticated, true);
  assert.equal(local.principal.kind, "local-user");
  assert.equal((local.principal as AuthPrincipal & { userId?: string }).userId, f.owner.userId);
  assert.equal(local.principal.kind === "local-user" ? local.principal.sessionId : undefined, "debug-agent");
  assert.ok(f.gateway.refreshPrincipal(local.principal));
  assert.equal(
    f.gateway.refreshPrincipal({
      kind: "local-user",
      trustedLoopback: true,
      userId: f.owner.userId,
    } as AuthPrincipal),
    null,
  );

  const browser = f.gateway.resolve(f.request(`${f.cookieName}=${f.owner.token}`), loopback);
  assert.equal(browser.authenticated, true);
  assert.equal(browser.principal.kind, "ui-session");

  assert.equal(f.gateway.resolve(f.request(), remote).authenticated, false);
  assert.equal(
    f.gateway.resolve(
      f.request(),
      { kind: "polyth-link", connectionId: "debug-must-not-cross-link", transport: "relay" },
    ).authenticated,
    false,
  );

  f.control.run(
    "UPDATE principals SET status='suspended',auth_epoch=auth_epoch+1 WHERE id=?",
    f.owner.userId,
  );
  assert.equal(f.gateway.refreshPrincipal(local.principal), null);
  assert.equal(f.gateway.resolve(f.request(), loopback).authenticated, false);
});

test("bound UI principal is invalidated by logout without caching authority", async t => {
  const f = await fixture(t);
  const ingress = { kind: "public-http", listenerId: "public", loopback: true, secure: false } as const;
  const principal = f.gateway.resolve(f.request(`${f.cookieName}=${f.owner.token}`), ingress).principal;
  assert.ok(f.gateway.refreshPrincipal(principal));
  f.identity.sessions.logout(f.owner.token);
  assert.equal(f.gateway.refreshPrincipal(principal), null);
});

test("paired transport requires both live pairing and active canonical user", async t => {
  const f = await fixture(t);
  const pair = {
    kind: "paired-device", deviceId: "dev", deviceEndpointId: "ep", connectionId: "conn", transport: "direct",
    grants: ["sessions.read"], grantRevision: 1, userId: f.owner.userId,
  } as AuthPrincipal & { userId: string };
  f.gateway.attachPairedDeviceResolver((ingress) => ingress.connectionId === "conn" ? pair : null);
  const ingress = { kind: "polyth-link", connectionId: "conn", transport: "direct" } as const;
  assert.equal(f.gateway.resolve(f.request(), ingress).authenticated, true);
  assert.ok(f.gateway.refreshPrincipal(pair));
  f.control.transaction(() => {
    f.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_backup','user','active')");
    f.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_backup','Backup',0,0)");
    f.control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_backup','owner')");
    f.control.run("UPDATE principals SET status='suspended',auth_epoch=auth_epoch+1 WHERE id=?", f.owner.userId);
  });
  assert.equal(f.gateway.resolve(f.request(), ingress).authenticated, false);
  assert.equal(f.gateway.refreshPrincipal(pair), null);
});

test("paired principal without durable user binding is denied", async t => {
  const f = await fixture(t);
  const pair = { kind: "paired-device", deviceId: "dev", deviceEndpointId: "ep", connectionId: "conn", transport: "relay", grants: [], grantRevision: 1 } as const;
  f.gateway.attachPairedDeviceResolver(() => pair);
  const resolution = f.gateway.resolve(f.request(), { kind: "polyth-link", connectionId: "conn", transport: "relay" });
  assert.equal(resolution.authenticated, false);
});
