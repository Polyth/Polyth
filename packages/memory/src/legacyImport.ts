import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { indexRecord } from "./store.ts";

/**
 * Memory used to live inside the Knowledge package's database
 * (`<space>/packages/knowledge/knowledge.db`, tables `memory_*`). This moves a
 * Space's memory into this package's own store, once, and then removes the old
 * tables.
 *
 * Nothing is deleted before it is proven to be in the new store: the copy
 * commits first, every old record is compared with what was written, and only
 * then are the old tables dropped. A crash at any point is safe to repeat:
 * records already present are skipped by id, never overwritten, so an edit made
 * after an interrupted move survives.
 */
/** Where the old store kept a Space's memory, relative to the Space's root.
 * This path is why `package.json` still declares `@polyth/knowledge`: nothing
 * is imported from it. Drop the dependency together with this importer. */
export const LEGACY_MEMORY_DATABASE = "packages/knowledge/knowledge.db";

export interface LegacyImportResult {
  records: number;
  revisions: number;
  policies: number;
  /** Bytes the old database gave back after its memory tables were dropped. */
  reclaimedBytes: number;
}

type Row = Record<string, unknown>;

const RECORD_COLUMNS = ["id", "space_id", "project_id", "title", "body", "category", "tags", "aliases", "applicability", "sources", "lifecycle", "evidence", "freshness", "pinned", "user_locked", "revision", "created_at", "updated_at", "layer", "owner_id", "authored_by", "approved_by", "about", "share_proposed_at"] as const;
/** Columns a store written by an older server may not have yet. */
const RECORD_DEFAULTS: Row = { layer: "project", owner_id: "", authored_by: null, approved_by: null, about: null, share_proposed_at: null };
const POLICY_DEFAULTS: Row = { utility_allowlist: "[]", utility_status: "disabled", utility_max_calls: 0, utility_used_calls: 0, utility_reserved_calls: 0, cross_project: "ask" };
/** Everything the old store's `memory_*` schema created. */
const LEGACY_TABLES = ["memory_fts_tri", "memory_fts", "memory_utility_reservations", "memory_harvest_cursors", "memory_harvest_jobs", "memory_tombstones", "memory_idempotency", "memory_revisions", "memory_records", "memory_policy", "memory_meta"];
const LEGACY_TRIGGERS = ["memory_fts_tri_insert", "memory_fts_tri_update", "memory_fts_tri_delete"];

const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
const columnsOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const parseList = (value: unknown): string[] => {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
};

/** Copies `table` row by row, skipping rows whose key the target already has.
 * Only columns both sides have are copied; the target's defaults fill the rest. */
const copyTable = (legacy: DatabaseSync, target: DatabaseSync, table: string, where = "", defaults: Row = {}): number => {
  if (!hasTable(legacy, table)) return 0;
  const wanted = columnsOf(target, table);
  const present = new Set(columnsOf(legacy, table));
  const columns = wanted.filter((column) => present.has(column) || column in defaults);
  const insert = target.prepare(`INSERT OR IGNORE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
  let copied = 0;
  for (const row of legacy.prepare(`SELECT * FROM ${table} ${where}`).iterate() as Iterable<Row>) {
    copied += Number(insert.run(...columns.map((column) => (row[column] ?? defaults[column] ?? null) as never)).changes);
  }
  return copied;
};

export function importLegacyMemory(target: DatabaseSync, legacyFile: string, options: { spaceId: string; fresh: boolean }): LegacyImportResult | undefined {
  if (!existsSync(legacyFile)) return undefined;
  const legacy = new DatabaseSync(legacyFile);
  try {
    legacy.exec("PRAGMA busy_timeout = 5000");
    const hasRecords = hasTable(legacy, "memory_records");
    const dropping = LEGACY_TABLES.filter((table) => hasTable(legacy, table));
    // Before memory had its own tables it was Knowledge items of kind
    // `memory`. A store that already had the tables copied those on every
    // open, so they are only looked at together with the tables, or once for a
    // Space whose memory store has just been created.
    const fromKnowledge = (hasRecords || options.fresh) && hasTable(legacy, "knowledge");
    if (!dropping.length && !fromKnowledge) return undefined;

    const result: LegacyImportResult = { records: 0, revisions: 0, policies: 0, reclaimedBytes: 0 };
    const insert = target.prepare(`INSERT INTO memory_records(${RECORD_COLUMNS.join(",")}) VALUES(${RECORD_COLUMNS.map(() => "?").join(",")})`);
    const exists = target.prepare("SELECT 1 FROM memory_records WHERE id=?");
    const written = target.prepare(`SELECT ${RECORD_COLUMNS.join(",")} FROM memory_records WHERE id=?`);
    const add = (row: Row): void => {
      const values = RECORD_COLUMNS.map((column) => row[column] ?? RECORD_DEFAULTS[column] ?? null);
      const n = Number(insert.run(...values as never[]).lastInsertRowid);
      indexRecord(target, n, { title: String(row.title), body: String(row.body), tags: parseList(row.tags), aliases: parseList(row.aliases), lifecycle: String(row.lifecycle) as never });
      // Read back what the database holds, not what was sent to it.
      const stored = written.get(String(row.id)) as Row | undefined;
      if (!stored || RECORD_COLUMNS.some((column, index) => stored[column] !== values[index])) {
        throw Object.assign(new Error(`memory import could not verify record ${String(row.id)}`), { code: "invalid-data" });
      }
      result.records++;
    };

    target.exec("BEGIN IMMEDIATE");
    try {
      if (hasRecords) {
        for (const row of legacy.prepare("SELECT * FROM memory_records ORDER BY created_at, id").iterate() as Iterable<Row>) {
          if (exists.get(String(row.id))) continue;
          // An offer for the shared memory used to wait out of recall until
          // someone decided; a note works from the start now.
          const waitingOffer = row.layer === "person" && row.lifecycle === "candidate" && row.share_proposed_at != null;
          add(waitingOffer ? { ...row, lifecycle: "active", share_proposed_at: null } : row);
        }
        // Earlier states only: the current state of a record is the record.
        result.revisions = copyTable(legacy, target, "memory_revisions", "WHERE revision < (SELECT m.revision FROM memory_records m WHERE m.id = memory_revisions.record_id)");
        result.policies = copyTable(legacy, target, "memory_policy", "", POLICY_DEFAULTS);
        copyTable(legacy, target, "memory_idempotency");
        copyTable(legacy, target, "memory_tombstones");
        copyTable(legacy, target, "memory_harvest_cursors");
        // Settled and denied jobs are not carried over: the cursors above are
        // where harvesting resumes, and a denied range is found again from them.
        copyTable(legacy, target, "memory_harvest_jobs", "WHERE status IN ('pending','leased','failed')");
        copyTable(legacy, target, "memory_utility_reservations", "WHERE state='reserved'");
        if (hasTable(legacy, "memory_meta")) {
          for (const row of legacy.prepare("SELECT space_id, data_revision FROM memory_meta").all() as Row[]) {
            target.prepare("INSERT INTO memory_meta(space_id, data_revision) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET data_revision = MAX(data_revision, excluded.data_revision)").run(String(row.space_id), Number(row.data_revision));
          }
        }
      }
      if (fromKnowledge) {
        for (const row of legacy.prepare("SELECT * FROM knowledge WHERE kind='memory'").iterate() as Iterable<Row>) {
          const id = typeof row.id === "string" ? row.id : "";
          const projectId = typeof row.project_id === "string" ? row.project_id : "";
          const title = typeof row.title === "string" ? row.title.trim() : "";
          const body = typeof row.body === "string" ? row.body : "";
          if (!id || !projectId || !title || title.length > 160 || !body || Buffer.byteLength(body, "utf8") > 8 * 1024 || exists.get(id)) continue;
          const createdAt = Number(row.created_at) || Date.now();
          const byUser = row.source === "user";
          add({
            id, space_id: options.spaceId, project_id: projectId, title, body, category: "observation",
            tags: JSON.stringify(parseList(row.tags).slice(0, 12)), aliases: "[]", applicability: "{}",
            sources: JSON.stringify([{ kind: "session", ...(typeof row.source_session_id === "string" && row.source_session_id ? { sessionId: row.source_session_id } : {}) }]),
            lifecycle: "active", evidence: byUser ? "user-stated" : "source-observed", freshness: "unknown", pinned: 0, user_locked: byUser ? 1 : 0,
            revision: Math.max(1, Number(row.revision) || 1), created_at: createdAt, updated_at: Number(row.updated_at) || createdAt,
          });
        }
      }
      // The proof the old tables may go: every record they hold is in the new store.
      if (hasRecords) {
        for (const row of legacy.prepare("SELECT id FROM memory_records").iterate() as Iterable<Row>) {
          if (!exists.get(String(row.id))) throw Object.assign(new Error(`memory import is missing record ${String(row.id)}`), { code: "invalid-data" });
        }
      }
      target.exec("COMMIT");
    } catch (cause) {
      try { target.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw cause;
    }

    if (dropping.length) {
      // The copy is committed and verified. From here a failure only leaves the
      // old tables for the next start to remove.
      const before = statSync(legacyFile).size;
      try {
        legacy.exec("BEGIN IMMEDIATE");
        try {
          for (const trigger of LEGACY_TRIGGERS) legacy.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
          for (const table of dropping) legacy.exec(`DROP TABLE IF EXISTS ${table}`);
          legacy.exec("COMMIT");
        } catch (cause) {
          try { legacy.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
          throw cause;
        }
      } catch (cause) {
        console.warn(`[memory] old memory tables in ${legacyFile} were not removed yet: ${(cause as Error).message}`);
        return result;
      }
      // Giving the space back to the disk is best effort: without it the old
      // database reuses the freed pages for its own data.
      try {
        legacy.exec("VACUUM");
        legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch { /* the tables are gone; only the file stays large */ }
      result.reclaimedBytes = Math.max(0, before - statSync(legacyFile).size);
    }
    return result;
  } finally {
    legacy.close();
  }
}
