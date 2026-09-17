import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openControlPlane } from "@polyth/control-plane";
import { applyLegacyIdentityMigration } from "../src/migrationApply.ts";
import { inventoryLegacyMigration } from "../src/legacyMigration.ts";
import { stageLegacyMigration } from "../src/migrationStage.ts";

const PASSWORD = `scrypt$${"a".repeat(32)}$${"b".repeat(64)}`;
const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });

function fixture(t: test.TestContext, owner = "usr_owner", withResources = false) {
  const root = mkdtempSync(join(tmpdir(), "polyth-migration-apply-"));
  const dataDir = join(root, "data"), stageDir = join(root, "stage");
  mkdirSync(dataDir, { mode: 0o700 });
  json(join(dataDir, "auth.json"), {
    version: 2,
    passwordHash: null,
    credentials: [{ userId: owner, passwordHash: PASSWORD }],
    sessions: [{
      id: "old-session",
      userId: owner,
      tokenHash: "c".repeat(64),
      createdAt: 100,
      lastSeenAt: 200,
      label: "legacy browser",
    }],
  });
  json(join(dataDir, "tenancy.json"), {
    version: 1,
    users: [{ id: owner, name: owner === "usr_owner" ? "Owner" : "Alice", createdAt: 50 }],
    spaces: [{ id: "spc_personal", name: "Personal", slug: "personal", createdAt: 60, updatedAt: 70, isDefault: true }],
    memberships: [{ userId: owner, spaceId: "spc_personal", role: "owner", createdAt: 60 }],
    selections: { desktop: "spc_personal" },
  });
  if (withResources) {
    json(join(dataDir, "projects.json"), [{
      id: "prj_one",
      path: join(root, "project-one"),
      name: "One",
      createdAt: 80,
      spaceId: "spc_personal",
    }]);
    const db = new DatabaseSync(join(dataDir, "sessions.db"));
    try {
      db.exec("CREATE TABLE projections(session_id TEXT PRIMARY KEY,data TEXT NOT NULL)");
      db.prepare("INSERT INTO projections(session_id,data) VALUES(?,?)").run("ses_one", JSON.stringify({
        id: "ses_one",
        projectId: "prj_one",
        spaceId: "spc_personal",
        title: "Imported archived session",
        status: "archived",
        createdAt: 90,
        updatedAt: 95,
      }));
    } finally { db.close(); }
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inventory = inventoryLegacyMigration({ dataDir });
  const stage = stageLegacyMigration({ dataDir, stageDir, expectedInventoryDigest: inventory.inventoryDigest });
  return { dataDir, stageDir, inventory, stage };
}

test("verified capsule activates one ready canonical authority and revokes legacy sessions", t => {
  const f = fixture(t);
  assert.equal(f.inventory.safeToStage, true);
  assert.equal(f.stage.status, "verified");
  assert.equal(existsSync(join(f.dataDir, "control-plane")), false);

  const result = applyLegacyIdentityMigration({
    dataDir: f.dataDir,
    stageDir: f.stageDir,
    expectedManifestDigest: f.stage.manifestDigest,
    now: () => 1_000,
  });

  assert.equal(result.usersImported, 1);
  assert.equal(result.spacesImported, 1);
  assert.equal(result.credentialsImported, 1);
  assert.equal(result.sessionsRevoked, 1);
  assert.equal(result.projectResourcesImported, 0);
  assert.equal(result.sessionResourcesImported, 0);
  assert.equal(result.generatedLogins.usr_owner, "owner");
  assert.equal(existsSync(join(f.dataDir, "control-plane")), true);
  assert.equal(existsSync(join(f.dataDir, `.control-plane-adopt-${f.stage.id}`)), false);

  const control = openControlPlane({ directory: f.dataDir });
  try {
    assert.equal(control.installation().state, "ready");
    assert.equal(control.get<{ n: number }>("SELECT count(*) AS n FROM users")?.n, 1);
    assert.equal(control.get<{ n: number }>("SELECT count(*) AS n FROM spaces")?.n, 1);
    assert.equal(control.get<{ n: number }>("SELECT count(*) AS n FROM auth_sessions")?.n, 0);
    assert.equal(control.get<{ login: string }>("SELECT login_name AS login FROM password_credentials WHERE user_id='usr_owner'")?.login, "owner");
    assert.equal(control.get<{ role: string }>("SELECT role FROM instance_roles WHERE user_id='usr_owner'")?.role, "owner");
    assert.equal(control.get<{ space: string }>("SELECT space_id AS space FROM device_selections WHERE device_key='desktop' AND user_id='usr_owner'")?.space, "spc_personal");
    assert.equal(control.get<{ digest: string }>("SELECT digest FROM legacy_imports WHERE name='migration-stage'")?.digest, f.stage.manifestDigest);
  } finally { control.close(); }

  assert.throws(() => applyLegacyIdentityMigration({
    dataDir: f.dataDir,
    stageDir: f.stageDir,
    expectedManifestDigest: f.stage.manifestDigest,
  }), { code: "canonical-authority-exists" });
});

test("reviewed project and archived session topology is materialized before publication", t => {
  const f = fixture(t, "usr_owner", true);
  assert.equal(f.inventory.safeToStage, true);
  assert.equal(f.inventory.plannedAdoptions.filter(row => row.kind !== "user-alias").length, 0);
  assert.ok(f.inventory.ownership.some(row => row.resourceKind === "project" && row.resourceId === "prj_one" && row.ownerUserId === "usr_owner"));
  assert.ok(f.inventory.ownership.some(row => row.resourceKind === "session" && row.resourceId === "ses_one" && row.ownerUserId === "usr_owner"));

  const result = applyLegacyIdentityMigration({
    dataDir: f.dataDir,
    stageDir: f.stageDir,
    expectedManifestDigest: f.stage.manifestDigest,
    now: () => 1_000,
  });
  assert.equal(result.projectResourcesImported, 1);
  assert.equal(result.sessionResourcesImported, 1);

  const control = openControlPlane({ directory: f.dataDir });
  try {
    const project = control.get<{
      kind: string; orgId: string; spaceId: string; ownerId: string; createdBy: string;
      lifecycle: string; visibility: string; createdAt: number;
    }>(`SELECT kind,org_id AS orgId,space_id AS spaceId,owner_principal_id AS ownerId,
              created_by AS createdBy,visibility,lifecycle,created_at_ms AS createdAt
         FROM resources WHERE id='prj_one'`);
    assert.deepEqual(project, {
      kind: "project",
      orgId: control.get<{ id: string }>("SELECT id FROM organizations")!.id,
      spaceId: "spc_personal",
      ownerId: "usr_owner",
      createdBy: "usr_owner",
      visibility: "space",
      lifecycle: "active",
      createdAt: 80,
    });
    const session = control.get<{ kind: string; parentId: string; spaceId: string; lifecycle: string; visibility: string; createdAt: number }>(
      "SELECT kind,parent_id AS parentId,space_id AS spaceId,visibility,lifecycle,created_at_ms AS createdAt FROM resources WHERE id='ses_one'",
    );
    assert.deepEqual(session, {
      kind: "session",
      parentId: "prj_one",
      spaceId: "spc_personal",
      visibility: "inherit",
      lifecycle: "archived",
      createdAt: 90,
    });
  } finally { control.close(); }
});

test("explicit tenant ownership cannot manufacture an instance owner without historical owner proof", t => {
  const f = fixture(t, "usr_alice");
  assert.equal(f.stage.status, "verified");
  assert.equal(f.inventory.ownership.some(row => row.resourceKind === "user" && row.resourceId === "usr_owner"), false);
  assert.throws(() => applyLegacyIdentityMigration({
    dataDir: f.dataDir,
    stageDir: f.stageDir,
    expectedManifestDigest: f.stage.manifestDigest,
  }), { code: "migration-owner-unproven" });
  assert.equal(existsSync(join(f.dataDir, "control-plane")), false);
});

test("wrong operator manifest acknowledgement cannot activate canonical state", t => {
  const f = fixture(t);
  assert.throws(() => applyLegacyIdentityMigration({
    dataDir: f.dataDir,
    stageDir: f.stageDir,
    expectedManifestDigest: "0".repeat(64),
  }), { code: "stage-manifest-changed" });
  assert.equal(existsSync(join(f.dataDir, "control-plane")), false);
});

test("source drift after staging cannot activate stale canonical state", t => {
  const f = fixture(t);
  json(join(f.dataDir, "tenancy.json"), {
    version: 1,
    users: [{ id: "usr_owner", name: "Changed after staging", createdAt: 50 }],
    spaces: [{ id: "spc_personal", name: "Personal", slug: "personal", createdAt: 60, updatedAt: 70, isDefault: true }],
    memberships: [{ userId: "usr_owner", spaceId: "spc_personal", role: "owner", createdAt: 60 }],
    selections: { desktop: "spc_personal" },
  });
  assert.throws(() => applyLegacyIdentityMigration({
    dataDir: f.dataDir,
    stageDir: f.stageDir,
    expectedManifestDigest: f.stage.manifestDigest,
  }), { code: "source-changed" });
  assert.equal(existsSync(join(f.dataDir, "control-plane")), false);
});
