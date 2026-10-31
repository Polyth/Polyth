import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { inspectCanonicalInstallation } from "../src/controlPlanePreflight.ts";

test("preflight on a fresh data directory is read-only and does not bootstrap authority", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-preflight-empty-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  assert.deepEqual(inspectCanonicalInstallation(dataDir), { kind: "absent" });
  assert.equal(existsSync(join(dataDir, "control-plane")), false);
  assert.equal(existsSync(join(dataDir, ".polyth-writer.lock")), false);
});

test("preflight reads an existing installation state without opening a replacement authority", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-preflight-existing-"));
  const security = createCanonicalSecurity({
    dataDir,
    origin: "http://127.0.0.1:4400",
    localOnly: true,
  });
  const id = security.control.installation().id;
  // A ready installation must have an active instance owner (schema trigger).
  security.control.transaction(() => {
    security.control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active')");
    security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',0,0)");
    security.control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_owner','owner')");
    security.control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });
  security.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  assert.deepEqual(inspectCanonicalInstallation(dataDir), {
    kind: "existing",
    id,
    state: "ready",
    accessMode: "accounts",
  });
});

test("preflight reports a password-less Desktop owner so boot can refuse a public origin early", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-preflight-local-"));
  const security = createCanonicalSecurity({ dataDir, origin: "http://127.0.0.1:4400", localOnly: true });
  security.identity.setup.completeLocal({ name: "Ida" });
  const id = security.control.installation().id;
  security.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.deepEqual(inspectCanonicalInstallation(dataDir), { kind: "existing", id, state: "ready", accessMode: "local" });
});
