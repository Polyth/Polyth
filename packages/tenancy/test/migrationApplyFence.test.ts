import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLegacyIdentityMigration } from "../src/migrationApply.ts";
import { inventoryLegacyMigration } from "../src/legacyMigration.ts";
import { stageLegacyMigration } from "../src/migrationStage.ts";

const PASSWORD = `scrypt$${"a".repeat(32)}$${"b".repeat(64)}`;
const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });

test("canonical ready is fenced while a verified project still needs ownership adoption", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-apply-fence-"));
  const dataDir = join(root, "data"), stageDir = join(root, "stage"), projectDir = join(root, "project");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(projectDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  json(join(dataDir, "auth.json"), {
    version: 2,
    passwordHash: null,
    credentials: [{ userId: "usr_owner", passwordHash: PASSWORD }],
    sessions: [],
  });
  json(join(dataDir, "tenancy.json"), {
    version: 1,
    users: [{ id: "usr_owner", name: "Owner", createdAt: 1 }],
    spaces: [{ id: "spc_personal", name: "Personal", slug: "personal", createdAt: 1, updatedAt: 1, isDefault: true }],
    memberships: [{ userId: "usr_owner", spaceId: "spc_personal", role: "owner", createdAt: 1 }],
    selections: {},
  });
  json(join(dataDir, "projects.json"), [{ id: "project-1", path: projectDir, name: "Legacy", createdAt: 1 }]);

  const inventory = inventoryLegacyMigration({ dataDir });
  assert.equal(inventory.safeToStage, true);
  assert.ok(inventory.plannedAdoptions.some(row => row.kind === "project" && row.resourceId === "project-1"));
  const stage = stageLegacyMigration({ dataDir, stageDir, expectedInventoryDigest: inventory.inventoryDigest });
  assert.equal(stage.status, "verified");

  assert.throws(() => applyLegacyIdentityMigration({
    dataDir,
    stageDir,
    expectedManifestDigest: stage.manifestDigest,
  }), { code: "migration-resource-adoption-required" });
  assert.equal(existsSync(join(dataDir, "control-plane")), false);
});
