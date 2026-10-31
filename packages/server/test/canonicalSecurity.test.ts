import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import type { PasswordService } from "@polyth/identity";
import type { IncomingMessage, ServerResponse } from "node:http";

const testPasswords = (): PasswordService => ({
  async hash(password) { return `test-only:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test-only:${password}`, needsRehash: false }; },
  close() {},
});
function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "polyth-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function open(t: test.TestContext, dataDir = root(t)) {
  const security = createCanonicalSecurity({
    dataDir,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
    passwords: testPasswords(),
  });
  t.after(() => security.close());
  return security;
}

test("fresh canonical security creates one stable installation-scoped cookie authority", t => {
  const dataDir = root(t);
  const first = open(t, dataDir);
  const id = first.control.installation().id;
  const cookie = first.http.cookieName;
  assert.equal(first.auth.cookieName(), cookie);
  assert.match(cookie, /^polyth_auth_[a-f0-9]{16}$/);
  first.close();

  const second = open(t, dataDir);
  assert.equal(second.control.installation().id, id);
  assert.equal(second.http.cookieName, cookie);
  assert.equal(second.identity.setup.status().state, "uninitialized");
});

test("unrelated installations never share cookie authority", t => {
  const left = open(t), right = open(t);
  assert.notEqual(left.control.installation().id, right.control.installation().id);
  assert.notEqual(left.http.cookieName, right.http.cookieName);
  assert.notEqual(left.auth.cookieName(), right.auth.cookieName());
});

for (const legacy of ["auth.json", "tenancy.json", "projects.json", "sessions.db", "agent-profile-owners.json"]) {
  test(`legacy ${legacy} blocks replacement authority before any canonical files are created`, t => {
    const dataDir = root(t);
    writeFileSync(join(dataDir, legacy), legacy.endsWith(".db") ? Buffer.from("legacy") : "{}\n");
    assert.throws(() => createCanonicalSecurity({
      dataDir,
      origin: "http://127.0.0.1:4400",
      localOnly: true,
      passwords: testPasswords(),
    }), { code: "recovery-required" });
    assert.equal(existsSync(join(dataDir, "control-plane", "installation.json")), false);
    assert.equal(existsSync(join(dataDir, "control-plane", "control.sqlite")), false);
  });
}

test("operator setup claim is explicit and does not become an authenticated HTTP principal", t => {
  const security = open(t);
  const claim = security.issueSetupClaim();
  assert.match(claim.token, /^[a-f0-9]{64}$/);
  const resolution = security.auth.resolve({ headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never, { kind: "public-http" });
  assert.equal(resolution.authenticated, false);
  assert.equal(resolution.principal.kind, "anonymous");
});

test("invalid browser origin closes partially-opened security authority cleanly", t => {
  const dataDir = root(t);
  assert.throws(() => createCanonicalSecurity({
    dataDir,
    origin: "http://example.test",
    passwords: testPasswords(),
  }), { code: "invalid-input" });
  // The canonical sentinel remains valid after configuration failure; reopening
  // it with a valid local origin must not manufacture a second installation.
  const security = open(t, dataDir);
  assert.match(security.control.installation().id, /^[a-f0-9-]{36}$/);
});

for (const debugAgentAccess of [false, true]) {
  test(`browser account bootstrap honors explicit debug authority (${debugAgentAccess}) without granting identity administration`, async t => {
    const security = createCanonicalSecurity({
      dataDir: root(t), origin: "http://127.0.0.1:4400", localOnly: true,
      debugAgentAccess, passwords: testPasswords(),
    });
    t.after(() => security.close());
    const request = async (path: string, remoteAddress = "127.0.0.1", extraHeaders: Record<string, string> = {}) => {
      let value: Record<string, unknown> = {};
      const req = {
        method: "GET", url: path, headers: { host: "127.0.0.1:4400", ...extraHeaders },
        socket: { remoteAddress, localAddress: "127.0.0.1" },
      } as unknown as IncomingMessage;
      const res = {
        statusCode: 200, setHeader() {}, end(body: string) { value = JSON.parse(body); },
      };
      assert.equal(await security.http.handle(req, res as unknown as ServerResponse), true);
      return { status: res.statusCode, value };
    };
    assert.equal((await request("/api/auth/status")).value.authorized, false,
      "a transport override cannot invent an account before setup");
    const claim = security.issueSetupClaim();
    const binding = "a".repeat(64);
    security.identity.setup.bindClaim(claim.token, binding);
    const recovery = security.identity.setup.prepareRecovery(claim.token, binding);
    const owner = await security.identity.setup.complete({
      claimToken: claim.token, browserBinding: binding, name: "Owner", organizationName: "Local",
      login: "owner", password: "owner test passphrase", recoverySetId: recovery.setId, recoveryAcknowledged: true,
    });
    assert.equal((await request("/api/auth/status")).value.authorized, debugAgentAccess);
    const bootstrap = await request("/api/auth/accounts");
    assert.equal(bootstrap.status, debugAgentAccess ? 200 : 401);
    if (debugAgentAccess) {
      assert.deepEqual(bootstrap.value, { currentAccountId: owner.userId, canManage: false, accounts: [] });
    }
    for (const path of ["/api/auth/me", "/api/auth/sessions", "/api/auth/passkeys", "/api/auth/providers/manage"]) {
      assert.equal((await request(path)).status, 401, path);
    }
    assert.equal((await request("/api/auth/accounts", "203.0.113.8", {
      "x-forwarded-for": "127.0.0.1", "x-polyth-user-id": owner.userId,
    })).status, 403, "client headers cannot create direct-loopback authority");
    const human = await request("/api/auth/accounts", "127.0.0.1", {
      cookie: `${security.http.cookieName}=${owner.token}`,
    });
    assert.equal(human.status, 200);
    assert.equal(human.value.currentAccountId, owner.userId);
    assert.equal(human.value.canManage, true, "a real human session keeps its existing account rights");
    if (debugAgentAccess) {
      security.control.transaction(() => {
        security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_backup','user','active')");
        security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_backup','Backup',0,0)");
        security.control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_backup','owner')");
        security.control.run("UPDATE principals SET status='suspended' WHERE id=?", owner.userId);
      });
      assert.equal((await request("/api/auth/accounts")).value.currentAccountId, "usr_backup",
        "bootstrap must re-resolve authority rather than retain the suspended account");
    }
  });
}
