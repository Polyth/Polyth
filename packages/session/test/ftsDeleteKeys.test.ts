import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "@polyth/session";

// FTS5 cannot index its UNINDEXED session_id/seq columns. Deleting mirrored
// rows by those columns scans the whole mirror; doing it once per deleted
// event held the synchronous store for minutes (2026-10-15 server stall).

function freshPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "polyth-fts-keys-"));
  return { path: join(dir, "sessions.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seed(path: string, sessions: Record<string, number>): void {
  const db = new DatabaseSync(path);
  const insert = db.prepare("INSERT INTO events (session_id, seq, id, time, type, data) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const [sessionId, total] of Object.entries(sessions)) {
    for (let seq = 1; seq <= total; seq += 1) {
      const type = seq % 2 === 0 ? "assistant/message" : "tool/started";
      insert.run(sessionId, seq, `${sessionId}-${seq}`, seq, type, JSON.stringify({ text: `${sessionId} note ${seq}` }));
    }
  }
  db.exec("COMMIT");
  db.close();
}

test("mirrored messages are keyed and deleted without scanning the mirror", async () => {
  const { path, cleanup } = freshPath();
  try {
    await createStore(path).close();
    seed(path, { victim: 4_000, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`other-${i}`, 2_000])) });

    const db = new DatabaseSync(path);
    const keys = Number((db.prepare("SELECT COUNT(*) AS n FROM events_fts_keys").get() as { n: number }).n);
    const mirrored = Number((db.prepare("SELECT COUNT(*) AS n FROM events_fts").get() as { n: number }).n);
    assert.equal(keys, mirrored, "every mirrored message has a key");
    const deleteTrigger = String((db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_events_fts_delete'",
    ).get() as { sql: string }).sql);
    assert.match(deleteTrigger, /events_fts_keys/);
    assert.match(deleteTrigger, /WHEN OLD\.type IN/);
    db.close();

    const store = createStore(path);
    const started = performance.now();
    await store.deleteSession("victim");
    const elapsed = performance.now() - started;
    // The per-event scan took ~3 minutes for this shape; keyed deletes take
    // milliseconds. The bound only has to separate the two.
    assert.ok(elapsed < 5_000, `deleteSession took ${Math.round(elapsed)}ms`);

    const remaining = await store.searchMessages({ q: "note" });
    assert.ok(remaining.length > 0, "other sessions stay searchable");
    assert.ok(remaining.every((hit) => hit.sessionId !== "victim"));
    await store.close();

    const after = new DatabaseSync(path);
    const count = (sql: string): number => Number((after.prepare(sql).get() as { n: number }).n);
    assert.equal(count("SELECT COUNT(*) AS n FROM events_fts WHERE session_id = 'victim'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM events_fts_keys WHERE session_id = 'victim'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM events_fts"), 20 * 1_000);
    assert.equal(count("SELECT COUNT(*) AS n FROM events_fts_keys"), 20 * 1_000);
    after.close();
  } finally {
    cleanup();
  }
});

test("upgrading a v21 store backfills keys for the existing mirror", async () => {
  const { path, cleanup } = freshPath();
  try {
    await createStore(path).close();
    // Recreate the v21 shape: the scanning delete trigger and no key table.
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TRIGGER trg_events_fts_insert;
      DROP TRIGGER trg_events_fts_delete;
      DROP TABLE events_fts_keys;
      CREATE TRIGGER trg_events_fts_insert AFTER INSERT ON events
      WHEN NEW.type IN ('user/message', 'assistant/message')
      BEGIN
        INSERT INTO events_fts (text, session_id, seq, role)
        VALUES (json_extract(NEW.data, '$.text'), NEW.session_id, NEW.seq, 'assistant');
      END;
      CREATE TRIGGER trg_events_fts_delete AFTER DELETE ON events
      BEGIN
        DELETE FROM events_fts WHERE session_id = OLD.session_id AND seq = OLD.seq;
      END;
      UPDATE schema_meta SET value = '21' WHERE key = 'version';
    `);
    raw.close();
    seed(path, { legacy: 10, kept: 10 });

    const store = createStore(path);
    await store.deleteSession("legacy");
    await store.append("kept", "user/message", { text: "appended after upgrade" });
    assert.deepEqual((await store.searchMessages({ q: "legacy" })).map((hit) => hit.sessionId), []);
    assert.deepEqual((await store.searchMessages({ q: "upgrade" })).map((hit) => hit.sessionId), ["kept"]);
    await store.close();

    const after = new DatabaseSync(path);
    const keyed = after.prepare(
      "SELECT COUNT(*) AS n FROM events_fts f JOIN events_fts_keys k ON k.fts_rowid = f.rowid AND k.session_id = f.session_id AND k.seq = f.seq",
    ).get() as { n: number };
    const mirrored = after.prepare("SELECT COUNT(*) AS n FROM events_fts").get() as { n: number };
    assert.equal(Number(mirrored.n), 6, "five pre-upgrade messages of `kept` plus the new one");
    assert.equal(Number(keyed.n), Number(mirrored.n));
    after.close();
  } finally {
    cleanup();
  }
});
