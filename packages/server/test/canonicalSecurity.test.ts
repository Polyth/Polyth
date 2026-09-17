import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import type { PasswordService } from "@polyth/identity";

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
