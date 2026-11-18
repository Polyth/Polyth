import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, pendingSessionMigrations, SESSION_SCHEMA_VERSION } from "@polyth/session";
import { pendingControlPlaneMigrations } from "@polyth/control-plane";
import {
  canonicalDatabases,
  PRE_MIGRATION_DIR,
  PRE_MIGRATION_KEEP,
  snapshotBeforeMigrations,
} from "../src/preMigrationSnapshot.ts";

const dataDirectory = (t: { after: (fn: () => void) => void }): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-premigration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A sessions database as an older Polyth left it: `version` migrations applied. */
function sessionsAt(file: string, version: number): void {
  const store = createStore(file);
  store.close?.();
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO events (session_id, seq, id, time, type, data) VALUES ('s1', 1, 'e1', 1, 'user/message', '{}')").run();
  db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(version));
  db.close();
}

test("pending migrations are read without changing the databases", (t) => {
  const dir = dataDirectory(t);
  const sessions = join(dir, "sessions.db");
  sessionsAt(sessions, SESSION_SCHEMA_VERSION);
  assert.equal(pendingSessionMigrations(sessions), 0);
  sessionsAt(join(dir, "old.db"), SESSION_SCHEMA_VERSION - 2);
  assert.equal(pendingSessionMigrations(join(dir, "old.db")), 2);
  const empty = join(dir, "empty.db");
  new DatabaseSync(empty).close();
  assert.equal(pendingSessionMigrations(empty), 0, "an empty file has nothing to protect");

  const control = join(dir, "control.sqlite");
  const db = new DatabaseSync(control);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL)");
  db.prepare("INSERT INTO schema_migrations VALUES (1, 'x', 1)").run();
  db.close();
  assert.ok(pendingControlPlaneMigrations(control) > 0);
  const before = statSync(control).mtimeMs;
  pendingControlPlaneMigrations(control);
  assert.equal(statSync(control).mtimeMs, before);
});

test("only databases about to migrate are copied, and the copy opens", (t) => {
  const dir = dataDirectory(t);
  sessionsAt(join(dir, "sessions.db"), SESSION_SCHEMA_VERSION - 1);
  const results = snapshotBeforeMigrations(dir, { version: "1.2.357", now: () => Date.UTC(2026, 10, 17), log: () => {} });
  assert.equal(results.length, 1, "control-plane is absent; sessions has one pending migration");
  const [result] = results;
  assert.equal(result!.label, "sessions");
  assert.equal(result!.pending, 1);
  assert.match(result!.snapshot ?? "", /pre-migration[\\/]sessions-before-1\.2\.357-2026-11-17T00-00-00-000Z\.sqlite$/);
  if (process.platform !== "win32") assert.equal(statSync(result!.snapshot!).mode & 0o777, 0o600);
  const copy = new DatabaseSync(result!.snapshot!, { readOnly: true });
  assert.equal((copy.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n, 1);
  copy.close();

  const current = dataDirectory(t);
  sessionsAt(join(current, "sessions.db"), SESSION_SCHEMA_VERSION);
  assert.deepEqual(snapshotBeforeMigrations(current, { version: "1.2.357", log: () => {} }), []);
  assert.equal(existsSync(join(current, PRE_MIGRATION_DIR)), false, "nothing to migrate, nothing written");
});

test("a snapshot that would fill the disk is skipped and the server still starts", (t) => {
  const dir = dataDirectory(t);
  sessionsAt(join(dir, "sessions.db"), 0);
  const logged: string[] = [];
  const results = snapshotBeforeMigrations(dir, { version: "1.2.357", freeBytes: () => 1024, log: (line) => logged.push(line) });
  assert.deepEqual(results, [{ label: "sessions", pending: SESSION_SCHEMA_VERSION, skipped: "no-space" }]);
  assert.match(logged.join("\n"), /not enough free space/);
  assert.deepEqual(readdirSync(join(dir, PRE_MIGRATION_DIR)), []);
});

test("old snapshots are pruned per database and a damaged one is left to its owner", (t) => {
  const dir = dataDirectory(t);
  const file = join(dir, "sessions.db");
  sessionsAt(file, SESSION_SCHEMA_VERSION - 1);
  const sessions = canonicalDatabases(dir).filter((db) => db.label === "sessions");
  for (let i = 0; i < PRE_MIGRATION_KEEP + 2; i += 1) {
    snapshotBeforeMigrations(dir, { version: `1.2.${300 + i}`, now: () => Date.UTC(2026, 10, 1 + i), databases: sessions, log: () => {} });
  }
  const kept = readdirSync(join(dir, PRE_MIGRATION_DIR)).sort();
  assert.equal(kept.length, PRE_MIGRATION_KEEP);
  assert.match(kept.at(-1)!, /before-1\.2\.304-/, "the newest snapshot stays");

  const damaged = dataDirectory(t);
  mkdirSync(join(damaged, "control-plane"));
  const logged: string[] = [];
  const results = snapshotBeforeMigrations(damaged, {
    version: "1.2.357",
    databases: [{ label: "broken", file: join(damaged, "control-plane"), pending: () => { throw new Error("not a database"); } }],
    log: (line) => logged.push(line),
  });
  assert.deepEqual(results, []);
  assert.match(logged.join("\n"), /broken skipped: not a database/);
});
