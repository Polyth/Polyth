import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyLegacyIdentityMigration } from "../src/migrationApply.ts";
import { applyLegacyResourceAdoptions } from "../src/migrationResources.ts";
import { inventoryLegacyMigration } from "../src/legacyMigration.ts";
import { stageLegacyMigration } from "../src/migrationStage.ts";
import { openControlPlane } from "@polyth/control-plane";

const PASSWORD = `scrypt$${"a".repeat(32)}$${"b".repeat(64)}`;
const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });

function authority(dataDir: string): void {
  json(join(dataDir, "auth.json"), {
    version: 2,
    passwordHash: null,
    credentials: [{ userId: "usr_owner", passwordHash: PASSWORD }],
    sessions: [{ id: "legacy-session-cookie", userId: "usr_owner", tokenHash: "c".repeat(64), createdAt: 1, lastSeenAt: 2, label: "browser" }],
  });
  json(join(dataDir, "tenancy.json"), {
    version: 1,
    users: [{ id: "usr_owner", name: "Owner", createdAt: 1 }],
    spaces: [{ id: "spc_personal", name: "Personal", slug: "personal", createdAt: 1, updatedAt: 1, isDefault: true }],
    memberships: [{ userId: "usr_owner", spaceId: "spc_personal", role: "owner", createdAt: 1 }],
    selections: {},
  });
}

function labels(db: DatabaseSync): void {
  db.exec(`CREATE TABLE labels(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    space_id TEXT
  )`);
}

test("verified resource adoption becomes a clean second capsule that can activate canonical authority", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-adopt-"));
  const dataDir = join(root, "data"), stage1 = join(root, "stage-1"), stage2 = join(root, "stage-2"), projectDir = join(root, "project");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(projectDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  authority(dataDir);
  json(join(dataDir, "projects.json"), [{ id: "project-1", path: projectDir, name: "Legacy", createdAt: 1 }]);

  const db = new DatabaseSync(join(dataDir, "sessions.db"));
  db.exec(`
    CREATE TABLE projections(session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE agent_profiles(id TEXT PRIMARY KEY);
  `);
  labels(db);
  db.prepare("INSERT INTO projections VALUES(?,?)").run("session-1", JSON.stringify({ id: "session-1", projectId: "project-1", title: "Legacy" }));
  db.prepare("INSERT INTO labels(id,name,color) VALUES(?,?,?)").run("label-1", "workspace", "#ffffff");
  db.prepare("INSERT INTO agent_profiles VALUES(?)").run("profile-1");
  db.close();

  const before = inventoryLegacyMigration({ dataDir });
  assert.equal(before.safeToStage, true);
  assert.deepEqual(
    new Set(before.plannedAdoptions.filter(row => row.kind !== "user-alias").map(row => row.kind)),
    new Set(["project", "session", "label", "agent-profile"]),
  );
  const first = stageLegacyMigration({ dataDir, stageDir: stage1, expectedInventoryDigest: before.inventoryDigest });
  assert.equal(first.status, "verified");

  const adopted = applyLegacyResourceAdoptions({ dataDir, stageDir: stage1, expectedManifestDigest: first.manifestDigest, now: () => 10 });
  assert.equal(adopted.projectsAdopted, 1);
  assert.equal(adopted.sessionsAdopted, 1);
  assert.equal(adopted.labelsAdopted, 1);
  assert.equal(adopted.profilesAdopted, 1);
  assert.equal(adopted.remainingAdoptions, 0);
  assert.equal(existsSync(join(dataDir, "control-plane")), false);

  const projects = JSON.parse(readFileSync(join(dataDir, "projects.json"), "utf8")) as Array<{ id: string; spaceId?: string }>;
  assert.equal(projects.find(project => project.id === "project-1")?.spaceId, "spc_personal");
  const owners = JSON.parse(readFileSync(join(dataDir, "agent-profile-owners.json"), "utf8")) as { owners: Record<string, string> };
  assert.equal(owners.owners["profile-1"], "usr_owner");
  const adoptedDb = new DatabaseSync(join(dataDir, "sessions.db"), { readOnly: true });
  try {
    const projection = adoptedDb.prepare("SELECT data FROM projections WHERE session_id='session-1'").get() as { data: string };
    assert.equal((JSON.parse(projection.data) as { spaceId?: string }).spaceId, "spc_personal");
    assert.equal((adoptedDb.prepare("SELECT space_id AS spaceId FROM labels WHERE id='label-1'").get() as { spaceId: string }).spaceId, "spc_personal");
  } finally { adoptedDb.close(); }

  const after = inventoryLegacyMigration({ dataDir });
  assert.equal(after.safeToStage, true);
  assert.deepEqual(after.plannedAdoptions.filter(row => row.kind !== "user-alias"), []);
  const second = stageLegacyMigration({ dataDir, stageDir: stage2, expectedInventoryDigest: after.inventoryDigest });
  assert.equal(second.status, "verified");

  const result = applyLegacyIdentityMigration({ dataDir, stageDir: stage2, expectedManifestDigest: second.manifestDigest, now: () => 20 });
  assert.equal(result.sessionsRevoked, 1);
  const control = openControlPlane({ directory: dataDir });
  try {
    assert.equal(control.installation().state, "ready");
    assert.equal(control.get<{ role: string }>("SELECT role FROM instance_roles WHERE user_id='usr_owner'")?.role, "owner");
    assert.equal(control.get<{ n: number }>("SELECT count(*) AS n FROM auth_sessions")?.n, 0);
  } finally { control.close(); }
});

test("label-only legacy ownership is inventoried and must be adopted before canonical activation", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-label-adopt-"));
  const dataDir = join(root, "data"), stage1 = join(root, "stage-1"), stage2 = join(root, "stage-2");
  mkdirSync(dataDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  authority(dataDir);
  const db = new DatabaseSync(join(dataDir, "sessions.db"));
  labels(db);
  db.prepare("INSERT INTO labels(id,name,color) VALUES(?,?,?)").run("label-only", "legacy", "#000000");
  db.close();

  const before = inventoryLegacyMigration({ dataDir });
  assert.deepEqual(before.plannedAdoptions.filter(row => row.kind !== "user-alias").map(row => row.kind), ["label"]);
  const first = stageLegacyMigration({ dataDir, stageDir: stage1, expectedInventoryDigest: before.inventoryDigest });
  assert.throws(() => applyLegacyIdentityMigration({ dataDir, stageDir: stage1, expectedManifestDigest: first.manifestDigest }), {
    code: "migration-resource-adoption-required",
  });

  const adopted = applyLegacyResourceAdoptions({ dataDir, stageDir: stage1, expectedManifestDigest: first.manifestDigest, now: () => 10 });
  assert.equal(adopted.labelsAdopted, 1);
  assert.equal(adopted.remainingAdoptions, 0);
  const after = inventoryLegacyMigration({ dataDir });
  assert.deepEqual(after.plannedAdoptions.filter(row => row.kind !== "user-alias"), []);
  const second = stageLegacyMigration({ dataDir, stageDir: stage2, expectedInventoryDigest: after.inventoryDigest });
  const result = applyLegacyIdentityMigration({ dataDir, stageDir: stage2, expectedManifestDigest: second.manifestDigest, now: () => 20 });
  assert.equal(result.installationId.length > 0, true);
});
