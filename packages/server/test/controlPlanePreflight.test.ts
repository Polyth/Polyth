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
  security.control.transaction(() => {
    security.control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });
  security.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  assert.deepEqual(inspectCanonicalInstallation(dataDir), {
    kind: "existing",
    id,
    state: "ready",
  });
});
