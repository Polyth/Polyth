// Bounded SQLite evidence extract for one Polyth data dir (optionally one
// session). Usage: node dbdump.mjs <sessions.db> [sessionId] > out.json
import { DatabaseSync } from "node:sqlite";

const [dbPath, sessionId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = (sql, ...params) => {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    return [{ __error: String(error.message) }];
  }
};

const bySession = (table, column = "session_id") =>
  sessionId
    ? rows(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 500`, sessionId)
    : rows(`SELECT * FROM ${table} LIMIT 500`);

const truncate = (value) => {
  if (typeof value === "string" && value.length > 2000) return value.slice(0, 2000) + `…[${value.length} bytes]`;
  return value;
};
const bound = (list) => list.map((row) => {
  const out = {};
  for (const [key, val] of Object.entries(row)) out[key] = truncate(val);
  return out;
});

const dump = {
  dbPath,
  sessionId: sessionId ?? null,
  capturedAt: new Date().toISOString(),
  integrityCheck: rows("PRAGMA integrity_check"),
  walCheckpoint: rows("PRAGMA wal_checkpoint(PASSIVE)"),
  journalMode: rows("PRAGMA journal_mode"),
  events: bound(bySession("events")),
  projections: sessionId
    ? bound(rows("SELECT * FROM projections WHERE id = ?", sessionId))
    : bound(rows("SELECT * FROM projections LIMIT 100")),
  runtime_operations: bound(bySession("runtime_operations")),
  session_queue: bound(bySession("session_queue")),
  response_intents: bound(bySession("response_intents")),
  observations: bound(bySession("observations")),
  observation_checkpoints: bound(bySession("observation_checkpoints")),
  observation_cursors: bound(bySession("observation_cursors")),
  session_reconciliations: bound(bySession("session_reconciliations")),
  deletion_tombstones: bound(bySession("deletion_tombstones")),
  attention_open: bound(bySession("attention_open")),
};
console.log(JSON.stringify(dump, null, 2));
db.close();
