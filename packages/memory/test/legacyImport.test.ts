import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import { importLegacyMemory } from "../src/legacyImport.ts";
import { createSpaceMemoryStores } from "../src/spaceStore.ts";
import { createMemoryStore, type MemoryScope } from "../src/store.ts";
import { addLegacyRecord, createLegacyMemoryDatabase } from "./legacyStore.ts";

const SPACE = "space-a";
const scope: MemoryScope = { spaceId: SPACE, projectId: "project-a", principalId: "user-a" };
const olia = { ...scope, layers: [{ layer: "project" as const }, { layer: "person" as const, userId: "olia", projectId: "project-a" }] };
const ctx: SpaceContext = { spaceId: SPACE, spaceSlug: SPACE, userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "" };

/** A Space directory as the server lays it out, with the old database in place. */
const spaceDir = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "memory-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "knowledge"), { recursive: true });
  const legacyFile = join(root, "packages", "knowledge", "knowledge.db");
  const host = {
    pluginId: "memory",
    spaceStorage: () => ({ root, packageDir: (id: string) => { const dir = join(root, "packages", id); mkdirSync(dir, { recursive: true }); return dir; }, path: (relative: string) => join(root, relative) }),
  } as never;
  return { root, legacyFile, host, memoryFile: join(root, "packages", "memory", "memory.db") };
};
const tablesOf = (file: string, like: string): string[] => {
  const db = new DatabaseSync(file);
  try { return (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE ? ORDER BY name").all(like) as Array<{ name: string }>).map((row) => row.name); }
  finally { db.close(); }
};

/** An old database with one of everything the old store kept. */
const seed = (legacyFile: string): void => {
  const db = createLegacyMemoryDatabase(legacyFile);
  db.prepare("INSERT INTO memory_meta VALUES(?, 7)").run(SPACE);
  db.prepare("INSERT INTO memory_policy(space_id, project_id, mode, generation, settings_revision, review_policy, cross_project, updated_at) VALUES(?,?,?,?,?,?,?,?)").run(SPACE, "project-a", "auto", "generation-1", 4, "manual", "allow", 900);
  addLegacyRecord(db, SPACE, { id: "11111111-aaaa-4aaa-8aaa-000000000001", projectId: "project-a", title: "WAL rule", body: "Keep SQLite in WAL mode. ".repeat(200), revision: 2, tags: ["sqlite"] });
  addLegacyRecord(db, SPACE, { id: "22222222-aaaa-4aaa-8aaa-000000000002", projectId: "project-a", title: "Ferritin", body: "My ferritin is 9.", layer: "person", ownerId: "olia" });
  addLegacyRecord(db, SPACE, { id: "33333333-aaaa-4aaa-8aaa-000000000003", projectId: "project-a", title: "Old router", body: "The router is at 192.168.1.1.", lifecycle: "superseded" });
  addLegacyRecord(db, SPACE, { id: "44444444-aaaa-4aaa-8aaa-000000000004", projectId: "project-a", title: "Gone", body: "Forgotten on request.", lifecycle: "forgotten", revision: 2 });
  addLegacyRecord(db, SPACE, { id: "55555555-aaaa-4aaa-8aaa-000000000005", projectId: "project-a", title: "Red meat", body: "Olia asks for more red meat at dinner.", layer: "person", ownerId: "olia", lifecycle: "candidate", shareProposedAt: 950 });
  // Bulk the old store the way real ones are: dead jobs and three copies of the text.
  for (let index = 0; index < 400; index++) {
    addLegacyRecord(db, SPACE, { id: `bulk-${String(index).padStart(4, "0")}-aaaa-4aaa-8aaa-00000000`, projectId: "project-b", title: `Bulk note ${index}`, body: `Deployment detail number ${index}. `.repeat(40) });
    db.prepare("INSERT INTO memory_harvest_jobs(job_key, space_id, project_id, session_id, source_start_seq, source_end_seq, source_digest, policy_generation, extractor_version, status, error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`denied-${index}`, SPACE, "project-a", `session-${index}`, 1, 9, "digest", "generation-1", "memory-harvest-v1", "denied", "utility-unavailable");
  }
  db.prepare("INSERT INTO memory_harvest_jobs(job_key, space_id, project_id, session_id, source_start_seq, source_end_seq, source_digest, policy_generation, extractor_version, status) VALUES(?,?,?,?,?,?,?,?,?,?)").run("live-job", SPACE, "project-a", "session-a", 10, 12, "digest", "generation-1", "memory-harvest-v1", "pending");
  db.prepare("INSERT INTO memory_harvest_jobs(job_key, space_id, project_id, session_id, source_start_seq, source_end_seq, source_digest, policy_generation, extractor_version, status) VALUES(?,?,?,?,?,?,?,?,?,?)").run("done-job", SPACE, "project-a", "session-a", 1, 9, "digest", "generation-1", "memory-harvest-v1", "processed");
  db.prepare("INSERT INTO memory_harvest_cursors VALUES(?,?,?,?,?,?,?)").run(SPACE, "project-a", "session-a", 10, "generation-1", null, 900);
  db.prepare("INSERT INTO memory_idempotency VALUES(?,?,?,?,?)").run("project-a", "harvest:1", "fingerprint", "{}", 900);
  db.prepare("INSERT INTO memory_tombstones VALUES(?,?,?,?,?,?)").run(SPACE, "project-a", "source-key", "generation-0", "forgotten", 900);
  // Knowledge's own rows: an ordinary note, and memory from before it had tables.
  db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("note-1", "project-a", "note", "A plan", "Not memory.", "[]", "user", null, 1, 1, 1);
  db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("ancient-1", "project-a", "memory", "Ancient", "Memory kept as a knowledge item.", "[\"old\"]", "user", "session-ancient", 1, 1, 1);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
};

test("a Space's memory moves into its own store on first open and the old tables are removed", (t) => {
  const { legacyFile, host, memoryFile } = spaceDir(t);
  seed(legacyFile);
  const sizeBefore = statSync(legacyFile).size;

  const stores = createSpaceMemoryStores(host);
  const store = stores.forSpace(ctx);

  // The Space's settings came along: a first read did not create defaults.
  const policy = store.getPolicy(scope);
  assert.deepEqual([policy.mode, policy.generation, policy.settingsRevision, policy.reviewPolicy, policy.crossProjectRecall], ["auto", "generation-1", "4", "manual", "allow"]);

  // Every record, in its layer, with its id, revision, dates and provenance.
  const wal = store.get(scope, "11111111-aaaa-4aaa-8aaa-000000000001")!;
  assert.deepEqual([wal.title, wal.revision, wal.createdAt, wal.updatedAt, wal.layer, wal.tags, wal.userLocked], ["WAL rule", 2, 1_000, 1_005, "project", ["sqlite"], true]);
  assert.deepEqual(wal.authoredBy, { kind: "agent", sessionId: "session-old" });
  assert.equal(store.get(scope, "22222222-aaaa-4aaa-8aaa-000000000002"), undefined, "a personal note is still out of a shared scope's reach");
  assert.equal(store.get(olia, "22222222-aaaa-4aaa-8aaa-000000000002")?.ownerId, "olia");
  assert.equal(store.get(scope, "33333333-aaaa-4aaa-8aaa-000000000003")?.lifecycle, "superseded");
  assert.equal(store.get(scope, "44444444-aaaa-4aaa-8aaa-000000000004")?.lifecycle, "forgotten");
  // An offer an older version left waiting works as a note.
  const offer = store.get(olia, "55555555-aaaa-4aaa-8aaa-000000000005")!;
  assert.deepEqual([offer.lifecycle, offer.shareProposedAt], ["active", undefined]);
  assert.equal(store.get(scope, "ancient-1")?.evidence, "user-stated", "memory from before the tables existed comes too");
  assert.equal(store.list({ ...scope, projectId: "project-b" }).total, 400);

  // Only active records are searchable, exactly as before.
  assert.deepEqual(store.search(scope, { q: "sqlite wal" }).items.map((item) => item.id), [wal.id]);
  assert.equal(store.search(scope, { q: "router" }).total, 0);
  assert.equal(store.search(scope, { q: "forgotten" }).total, 0);
  assert.equal(store.search(olia, { q: "red meat dinner" }).items[0]?.id, offer.id);
  assert.equal(store.recall(scope, { projectId: scope.projectId, intent: "sqlite wal mode" }).selected[0]?.memoryId, wal.id);

  // History: the earlier state only, and it restores.
  const target = new DatabaseSync(memoryFile);
  t.after(() => target.close());
  assert.deepEqual(target.prepare("SELECT record_id, revision FROM memory_revisions ORDER BY record_id").all().map((row) => ({ ...row })), [
    { record_id: wal.id, revision: 1 },
    { record_id: "44444444-aaaa-4aaa-8aaa-000000000004", revision: 1 },
  ]);
  store.restore(scope, wal.id, 2, 1);
  assert.equal(store.get(scope, wal.id)?.title, "WAL rule (draft 1)");

  // Harvesting resumes from the cursors; settled and denied jobs stay behind.
  assert.deepEqual(target.prepare("SELECT job_key FROM memory_harvest_jobs").all().map((row) => row.job_key), ["live-job"]);
  assert.equal(store.harvestCursor(scope, "session-a")?.nextSeq, 10);
  assert.equal(Number((target.prepare("SELECT count(*) AS count FROM memory_idempotency").get() as { count: number }).count), 1);
  assert.equal(Number((target.prepare("SELECT count(*) AS count FROM memory_tombstones").get() as { count: number }).count), 1);
  assert.ok(Number((target.prepare("SELECT data_revision FROM memory_meta WHERE space_id=?").get(SPACE) as { data_revision: number }).data_revision) >= 7);

  // The old database keeps Knowledge's own data and nothing of memory's.
  assert.deepEqual(tablesOf(legacyFile, "memory%"), []);
  assert.deepEqual(tablesOf(legacyFile, "knowledge"), ["knowledge"]);
  const knowledge = new DatabaseSync(legacyFile);
  assert.equal(Number((knowledge.prepare("SELECT count(*) AS count FROM knowledge").get() as { count: number }).count), 2);
  knowledge.close();
  assert.ok(statSync(legacyFile).size < sizeBefore / 10, `the old database shrank: ${sizeBefore} -> ${statSync(legacyFile).size}`);
  assert.ok(statSync(memoryFile).size < sizeBefore / 2, `the new store is far smaller than what it replaces: ${statSync(memoryFile).size} vs ${sizeBefore}`);

  // A restart finds nothing left to move and changes nothing.
  stores.close();
  const reopened = createSpaceMemoryStores(host).forSpace(ctx);
  assert.equal(reopened.get(scope, wal.id)?.title, "WAL rule (draft 1)");
  assert.equal(reopened.list({ ...scope, projectId: "project-b" }).total, 400);
});

test("an interrupted move repeats safely and never overwrites what changed since", (t) => {
  const { root, legacyFile } = spaceDir(t);
  seed(legacyFile);
  // The state after a crash between the copy and the removal: the new store
  // has everything, the old tables are still there.
  const crashed = join(root, "knowledge-after-crash.db");
  copyFileSync(legacyFile, crashed);
  const target = new DatabaseSync(join(root, "memory.db"));
  t.after(() => target.close());
  const store = createMemoryStore(target, SPACE);
  assert.equal(importLegacyMemory(target, legacyFile, { spaceId: SPACE, fresh: true })?.records, 406);

  const id = "33333333-aaaa-4aaa-8aaa-000000000003";
  store.review(scope, id, 1, "active");
  const policy = store.getPolicy(scope);
  store.updatePolicy(scope, { projectId: scope.projectId, expectedSettingsRevision: policy.settingsRevision, patch: { mode: "read-only" } });

  const again = importLegacyMemory(target, crashed, { spaceId: SPACE, fresh: false })!;
  assert.equal(again.records, 0, "nothing is copied twice");
  assert.equal(store.get(scope, id)?.lifecycle, "active", "an edit made after the first copy survives");
  assert.equal(store.getPolicy(scope).mode, "read-only");
  assert.equal(Number((target.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count), 406);
  assert.deepEqual(tablesOf(crashed, "memory%"), [], "the repeat finishes the removal");
});

test("a store written before layers existed moves over as project records with no author", (t) => {
  const { legacyFile, host } = spaceDir(t);
  const db = createLegacyMemoryDatabase(legacyFile, { beforeLayers: true });
  db.prepare("INSERT INTO memory_policy(space_id, project_id, mode, generation, updated_at) VALUES(?,?,?,?,?)").run(SPACE, "project-a", "auto", "generation-1", 1);
  addLegacyRecord(db, SPACE, { id: "old-1", projectId: "project-a", title: "Old rule", body: "Keep SQLite in WAL mode." }, { beforeLayers: true });
  db.close();

  const store = createSpaceMemoryStores(host).forSpace(ctx);
  const item = store.get(scope, "old-1")!;
  assert.deepEqual([item.layer, item.ownerId, item.authoredBy, item.approvedBy], ["project", undefined, undefined, undefined]);
  assert.deepEqual([store.getPolicy(scope).mode, store.getPolicy(scope).crossProjectRecall], ["auto", "ask"]);
  assert.deepEqual(store.search(scope, { q: "sqlite" }).items.map((hit) => hit.id), ["old-1"]);
  assert.deepEqual(tablesOf(legacyFile, "memory%"), []);
});

test("a record that cannot be copied stops the move and leaves the old store whole", (t) => {
  const { legacyFile, host, memoryFile } = spaceDir(t);
  const db = createLegacyMemoryDatabase(legacyFile);
  addLegacyRecord(db, SPACE, { id: "good-1", projectId: "project-a", title: "Good", body: "A healthy record." });
  addLegacyRecord(db, SPACE, { id: "bad-1", projectId: "project-a", title: "Damaged", body: null, at: 2_000 });
  db.close();

  assert.throws(() => createSpaceMemoryStores(host).forSpace(ctx), /NOT NULL/);
  // Nothing was removed, and the half-copied record was rolled back.
  const old = new DatabaseSync(legacyFile);
  assert.equal(Number((old.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count), 2);
  assert.equal(Number((old.prepare("SELECT count(*) AS count FROM memory_revisions").get() as { count: number }).count), 2);
  old.close();
  const target = new DatabaseSync(memoryFile);
  assert.equal(Number((target.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count), 0);
  target.close();
});

test("a Space with no old database, or one already moved, opens without touching it", (t) => {
  const { legacyFile, host } = spaceDir(t);
  const stores = createSpaceMemoryStores(host);
  assert.equal(stores.forSpace(ctx).list(scope).total, 0);
  stores.close();
  assert.throws(() => statSync(legacyFile), /ENOENT/, "no empty database is created in another package's directory");
});
