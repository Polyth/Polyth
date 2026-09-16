import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { inventoryLegacyMigration } from "../src/legacyMigration.ts";

const scrypt = `scrypt$${"a".repeat(32)}$${"b".repeat(64)}`;

function fixture(t: test.TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-migration-inventory-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionsDb(file: string, rows: Array<Record<string, unknown>>, profiles: string[] = []): void {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE projections(session_id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  db.exec("CREATE TABLE events(session_id TEXT, seq INTEGER, data TEXT)");
  db.exec("CREATE TABLE session_queue(queue_id TEXT)");
  db.exec("CREATE TABLE agent_profiles(id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO projections VALUES(?,?)");
  for (const row of rows) insert.run(String(row.id), JSON.stringify(row));
  const profile = db.prepare("INSERT INTO agent_profiles VALUES(?)");
  for (const id of profiles) profile.run(id);
  db.close();
}

function validFixture(t: test.TestContext) {
  const dataDir = fixture(t);
  writeJson(join(dataDir, "auth.json"), {
    version: 2,
    passwordHash: null,
    credentials: [{ userId: "usr_owner", passwordHash: scrypt }],
    sessions: [],
  });
  writeJson(join(dataDir, "tenancy.json"), {
    version: 1,
    users: [{ id: "usr_owner", name: "Owner" }],
    spaces: [{ id: "spc_personal", name: "Personal", slug: "personal", createdAt: 1, isDefault: true }],
    memberships: [{ userId: "usr_owner", spaceId: "spc_personal", role: "owner" }],
    selections: {},
  });
  writeJson(join(dataDir, "projects.json"), [
    { id: "project-owned", path: join(dataDir, "owned"), name: "Owned", createdAt: 1, spaceId: "spc_personal" },
    { id: "project-legacy", path: join(dataDir, "legacy"), name: "Legacy", createdAt: 2 },
  ]);
  sessionsDb(join(dataDir, "sessions.db"), [
    { id: "session-owned", projectId: "project-owned", spaceId: "spc_personal" },
    { id: "session-legacy", projectId: "project-legacy" },
  ], ["profile-old"]);
  return dataDir;
}

test("dry-run inventories every legacy source and is byte-stable across reruns", t => {
  const dataDir = validFixture(t);
  const first = inventoryLegacyMigration({ dataDir });
  const second = inventoryLegacyMigration({ dataDir });
  assert.equal(first.inventoryDigest, second.inventoryDigest);
  assert.deepEqual(first, second);
  assert.equal(first.safeToStage, true);
  assert.deepEqual(first.sources.map((source) => source.kind), ["auth", "tenancy", "projects", "sessions", "profile-owners"]);
  assert.deepEqual(first.plannedAdoptions.map((entry) => `${entry.kind}:${entry.resourceId}`), [
    "agent-profile:profile-old",
    "project:project-legacy",
    "session:session-legacy",
    "user-alias:usr_owner",
  ]);
  assert.equal(new Set(first.plannedAdoptions.map((entry) => `${entry.kind}:${entry.resourceId}`)).size, first.plannedAdoptions.length);
});

test("explicit profile owner wins and an unmapped profile is adopted only with verified legacy owner proof", t => {
  const dataDir = validFixture(t);
  writeJson(join(dataDir, "agent-profile-owners.json"), {
    version: 1,
    owners: { "profile-old": "usr_owner" },
  });
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.safeToStage, true);
  assert.equal(result.plannedAdoptions.some((row) => row.kind === "agent-profile"), false);
  assert.equal(result.ownership.find((row) => row.resourceId === "profile-old")?.proof, "explicit-profile-owner");
});

test("conflicting sidecar owner is quarantined instead of guessed", t => {
  const dataDir = validFixture(t);
  writeJson(join(dataDir, "agent-profile-owners.json"), {
    version: 1,
    owners: { "profile-old": "usr_missing" },
  });
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.safeToStage, false);
  assert.ok(result.issues.some((issue) => issue.code === "unknown-profile-owner" && issue.resourceId === "profile-old"));
  assert.equal(result.ownership.some((row) => row.resourceId === "profile-old"), false);
});

test("missing project referenced by a session is blocking", t => {
  const dataDir = validFixture(t);
  rmSync(join(dataDir, "sessions.db"));
  sessionsDb(join(dataDir, "sessions.db"), [{ id: "orphan-session", projectId: "missing" }]);
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.safeToStage, false);
  assert.ok(result.issues.some((issue) => issue.code === "session-missing-project" && issue.resourceId === "orphan-session"));
});

test("overlapping local project roots require review but are never silently collapsed", t => {
  const dataDir = validFixture(t);
  writeJson(join(dataDir, "projects.json"), [
    { id: "p1", path: join(dataDir, "repo"), createdAt: 1 },
    { id: "p2", path: join(dataDir, "repo", "packages", "web"), createdAt: 2 },
  ]);
  rmSync(join(dataDir, "sessions.db"));
  sessionsDb(join(dataDir, "sessions.db"), []);
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.safeToStage, true, "review-only topology should not invent an owner or block evidence generation");
  assert.ok(result.issues.some((issue) => issue.code === "overlapping-project-roots" && issue.severity === "review"));
  assert.equal(result.plannedAdoptions.filter((row) => row.kind === "project").length, 2);
});

test("partial prior Space adoption remains idempotent and only plans still-unowned rows", t => {
  const dataDir = validFixture(t);
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.plannedAdoptions.some((row) => row.resourceId === "project-owned"), false);
  assert.equal(result.plannedAdoptions.some((row) => row.resourceId === "session-owned"), false);
  assert.ok(result.ownership.some((row) => row.resourceId === "project-owned" && row.proof === "project-space-owner"));
});

test("without verified historical owner, ownerless resources are quarantined", t => {
  const dataDir = fixture(t);
  writeJson(join(dataDir, "projects.json"), [{ id: "p", path: join(dataDir, "repo"), createdAt: 1 }]);
  sessionsDb(join(dataDir, "sessions.db"), [{ id: "s", projectId: "p" }], ["profile"]);
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.safeToStage, false);
  assert.ok(result.issues.some((issue) => issue.code === "ownerless-project"));
  assert.ok(result.issues.some((issue) => issue.code === "session-owner-unproven"));
  assert.ok(result.issues.some((issue) => issue.code === "profile-owner-unproven"));
  assert.equal(result.plannedAdoptions.length, 0);
});

test("malformed source files are evidence, never interpreted as first boot", t => {
  const dataDir = fixture(t);
  writeFileSync(join(dataDir, "auth.json"), "{");
  const result = inventoryLegacyMigration({ dataDir });
  assert.equal(result.safeToStage, false);
  assert.equal(result.sources.find((source) => source.kind === "auth")?.present, true);
  assert.ok(result.issues.some((issue) => issue.code === "malformed-source" && issue.source === "auth"));
});
