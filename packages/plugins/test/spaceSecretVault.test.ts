import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SecureSafeService } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import {
  createServerServiceRegistry,
  SPACE_SECURE_SAFE,
  type ServerPackageHost,
} from "../src/index.ts";
import { secretVault } from "../src/pluginRouteShared.ts";
import { memoryOpaqueVault } from "./helpers.ts";

test("package credential vault routes and audits opaque secrets in the owning Space", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-secret-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storageA = createSpaceStorage(join(root, "space-a"));
  const storageB = createSpaceStorage(join(root, "space-b"));
  const a = memoryOpaqueVault();
  const b = memoryOpaqueVault();
  const services = createServerServiceRegistry();
  services.provide(SPACE_SECURE_SAFE, {
    forSpace() { throw new Error("not used"); },
    forSpaceId(spaceId) {
      if (spaceId === "spc_a") return a as SecureSafeService;
      if (spaceId === "spc_b") return b as SecureSafeService;
      return undefined;
    },
  });
  const host = {
    services,
    packageSpaces: () => [
      { spaceId: "spc_a", storage: storageA },
      { spaceId: "spc_b", storage: storageB },
    ],
  } as unknown as ServerPackageHost;
  const vault = secretVault(host);

  vault.putOpaque("pkgconn:spc_a:github:main", "token-a");
  vault.putOpaque("pkgconn:spc_b:github:main", "token-b");
  assert.equal(a.getOpaque("pkgconn:spc_a:github:main"), "token-a");
  assert.equal(a.getOpaque("pkgconn:spc_b:github:main"), null);
  assert.equal(b.getOpaque("pkgconn:spc_b:github:main"), "token-b");
  assert.equal(b.getOpaque("pkgconn:spc_a:github:main"), null);

  assert.equal(vault.getOpaque("pkgconn:spc_b:github:main"), "token-b");
  const auditFiles = readdirSync(join(storageB.root, "audit"));
  assert.equal(auditFiles.length, 1);
  const audit = readFileSync(join(storageB.root, "audit", auditFiles[0]!), "utf8");
  assert.match(audit, /"action":"secret\.resolved"/);
  assert.match(audit, /"userId":"system:package"/);
  assert.match(audit, /pkgconn:spc_b:github:main/);
  assert.doesNotMatch(audit, /token-b/);
  assert.equal(readdirSync(storageA.root).includes("audit"), false, "reading B must not emit audit under A");

  vault.deleteOpaqueByPrefix("pkgconn:spc_a:github:");
  assert.equal(a.getOpaque("pkgconn:spc_a:github:main"), null);
  assert.equal(b.getOpaque("pkgconn:spc_b:github:main"), "token-b");

  assert.throws(
    () => vault.putOpaque("pkgconn:spc_missing:github:main", "nope"),
    { code: "HOST_UNAVAILABLE" },
  );
});
