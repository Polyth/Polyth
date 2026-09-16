import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { inventoryLegacyMigration } from "../src/legacyMigration.ts";

const hash = `scrypt$${"a".repeat(32)}$${"b".repeat(64)}`;
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-inventory-security-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function auth(root: string, userIds = ["usr_owner"]) {
  json(join(root, "auth.json"), { version: 2, passwordHash: null,
    credentials: userIds.map(userId => ({ userId, passwordHash: hash })), sessions: [] });
}
function project(root: string, spaceId?: string) {
  json(join(root, "projects.json"), [{ id: "p", path: join(root, "repo"), spaceId }]);
}
function assertBlocked(root: string, code: string) {
  const result = inventoryLegacyMigration({ dataDir: root });
  assert.equal(result.safeToStage, false);
  assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues));
  return result;
}

test("JSON parser errors never echo raw authentication content into a report", t => {
  const root = fixture(t);
  writeFileSync(join(root, "auth.json"), "CANARY_SECRET_MUST_NOT_ESCAPE");
  const result = assertBlocked(root, "malformed-source");
  assert.equal(JSON.stringify(result).includes("CANARY"), false);
});
for (const mutation of ["future-version", "invalid-hash", "duplicate-credential"] as const) {
  test(`inventory uses the runtime credential validator: ${mutation}`, t => {
    const root = fixture(t); auth(root); project(root);
    const data = JSON.parse(readFileSync(join(root, "auth.json"), "utf8"));
    if (mutation === "future-version") data.version = 100;
    if (mutation === "invalid-hash") data.credentials[0].passwordHash = "arbitrary-string";
    if (mutation === "duplicate-credential") data.credentials.push(data.credentials[0]);
    json(join(root, "auth.json"), data);
    const result = assertBlocked(root, "invalid-auth-shape");
    assert.equal(result.ownership.length, 0);
  });
}

test("an ownerless legacy session is not a durable historical ownership proof", t => {
  const root = fixture(t); project(root);
  json(join(root, "auth.json"), { version: 1, passwordHash: null, sessions: [{
    id: "old-session", tokenHash: "a".repeat(64), createdAt: 1, lastSeenAt: 1, label: "old",
  }] });
  const result = assertBlocked(root, "ownerless-project");
  assert.equal(result.plannedAdoptions.length, 0);
});

test("unassigned resources in a multi-user installation are quarantined, not guessed", t => {
  const root = fixture(t); auth(root, ["usr_owner", "usr_second"]); project(root);
  const db = new DatabaseSync(join(root, "sessions.db"));
  db.exec("CREATE TABLE agent_profiles(id TEXT PRIMARY KEY); INSERT INTO agent_profiles VALUES('preset')"); db.close();
  const result = assertBlocked(root, "ownerless-project");
  assert.ok(result.issues.some(issue => issue.code === "profile-owner-unproven"));
  assert.equal(result.ownership.some(row => row.resourceKind === "agent-profile"), false);
});

test("a session cannot supply a foreign Space to a project with no Space", t => {
  const root = fixture(t); auth(root); project(root);
  const db = new DatabaseSync(join(root, "sessions.db"));
  db.exec("CREATE TABLE projections(session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.prepare("INSERT INTO projections VALUES(?,?)").run("s", JSON.stringify({ projectId: "p", spaceId: "foreign" })); db.close();
  const result = assertBlocked(root, "session-space-conflict");
  assert.equal(result.ownership.some(row => row.resourceKind === "session"), false);
});

test("committed WAL-only content changes invalidate the inventory digest even when counts stay equal", t => {
  const root = fixture(t); auth(root); project(root);
  const file = join(root, "sessions.db");
  const db = new DatabaseSync(file); t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projections(session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  const insert = db.prepare("INSERT OR REPLACE INTO projections VALUES(?,?)");
  insert.run("s", JSON.stringify({ projectId: "p", title: "first" }));
  const mainHash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const beforeBytes = mainHash(), before = inventoryLegacyMigration({ dataDir: root });
  assert.equal(before.safeToStage, true);
  insert.run("s", JSON.stringify({ projectId: "p", title: "other" }));
  assert.equal(mainHash(), beforeBytes, "fixture really changed only WAL");
  const after = inventoryLegacyMigration({ dataDir: root });
  assert.equal(after.safeToStage, true);
  assert.notEqual(after.inventoryDigest, before.inventoryDigest);
  assert.deepEqual(after.sources.map(row => row.counts), before.sources.map(row => row.counts));
});

test("symbolic-link source and symbolic-link data root never get read", t => {
  const root = fixture(t), target = fixture(t);
  auth(target);
  symlinkSync(join(target, "auth.json"), join(root, "auth.json"));
  assertBlocked(root, "unsafe-source-file");
  const link = join(root, "linked-root"); symlinkSync(target, link, "dir");
  assertBlocked(link, "unsafe-data-root");
});

test("missing data root is an error, not a fresh authority", t => {
  assertBlocked(join(fixture(t), "missing"), "unsafe-data-root");
});

test("dot-prefixed nested directories are still overlapping project roots", t => {
  const root = fixture(t); auth(root);
  json(join(root, "projects.json"), [
    { id: "parent", path: join(root, "repo") },
    { id: "child", path: join(root, "repo", "..hidden") },
  ]);
  const result = inventoryLegacyMigration({ dataDir: root });
  assert.ok(result.issues.some(issue => issue.code === "overlapping-project-roots"));
});
