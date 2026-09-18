import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import {
  createServerServiceRegistry,
  SPACE_SECURE_SAFE,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import registerPackage from "../src/serverEntry.ts";

const context = (spaceId: string, storageDir: string): SpaceContext => ({
  spaceId,
  userId: `usr_${spaceId.slice(4)}`,
  storageDir,
  role: "owner",
} as SpaceContext);

test("Secure Safe registry stores identical handles and opaque credentials in separate Space roots", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-space-safe-"));
  const rootA = join(root, "space-a");
  const rootB = join(root, "space-b");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const storageA = createSpaceStorage(rootA);
  const storageB = createSpaceStorage(rootB);
  const a = context("spc_a", rootA);
  const b = context("spc_b", rootB);
  const services = createServerServiceRegistry();
  const host = {
    services,
    spaceStorage(space: SpaceContext) {
      if (space.spaceId === a.spaceId) return storageA;
      if (space.spaceId === b.spaceId) return storageB;
      throw new Error("unknown space");
    },
    packageSpaces: () => [
      { spaceId: a.spaceId, storage: storageA },
      { spaceId: b.spaceId, storage: storageB },
    ],
  } as unknown as ServerPackageHost;

  registerPackage(host);
  const registry = services.require(SPACE_SECURE_SAFE);
  const safeA = registry.forSpace(a);
  const safeB = registry.forSpace(b);

  const entryA = await safeA.create({
    handle: "DEPLOY_TOKEN",
    label: "Deploy token",
    kind: "token",
    value: "secret-space-a",
  });
  const entryB = await safeB.create({
    handle: "DEPLOY_TOKEN",
    label: "Deploy token",
    kind: "token",
    value: "secret-space-b",
  });
  assert.notEqual(entryA.id, entryB.id);
  assert.equal(safeA.list().length, 1);
  assert.equal(safeB.list().length, 1);
  assert.equal(safeA.redact("secret-space-a secret-space-b"), "[redacted] secret-space-b");
  assert.equal(safeB.redact("secret-space-a secret-space-b"), "secret-space-a [redacted]");

  safeA.putOpaque!("pkgconn:spc_a:example:main", "opaque-space-a");
  safeB.putOpaque!("pkgconn:spc_b:example:main", "opaque-space-b");
  assert.equal(registry.forSpaceId("spc_a")?.getOpaque("pkgconn:spc_a:example:main"), "opaque-space-a");
  assert.equal(registry.forSpaceId("spc_b")?.getOpaque("pkgconn:spc_b:example:main"), "opaque-space-b");
  assert.equal(safeA.getOpaque("pkgconn:spc_b:example:main"), null);
  assert.equal(safeB.getOpaque("pkgconn:spc_a:example:main"), null);

  const diskA = readFileSync(join(rootA, "secure-safe", "secure-safe-secrets.json"), "utf8");
  const diskB = readFileSync(join(rootB, "secure-safe", "secure-safe-secrets.json"), "utf8");
  assert.match(diskA, /secret-space-a/);
  assert.doesNotMatch(diskA, /secret-space-b/);
  assert.match(diskB, /secret-space-b/);
  assert.doesNotMatch(diskB, /secret-space-a/);
});
