import { DatabaseSync } from "node:sqlite";

/**
 * The memory tables exactly as the Knowledge package's database held them
 * before memory moved into its own store: the fixture a move is tested from.
 * `beforeLayers` is the earlier shape, without layers, provenance and the
 * later policy columns. One deliberate difference: `body` may be NULL here, so
 * a test can plant a damaged row.
 */
export function createLegacyMemoryDatabase(file: string, options: { beforeLayers?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(file);
  const layers = options.beforeLayers ? "" : `,
      layer TEXT NOT NULL DEFAULT 'project',
      owner_id TEXT NOT NULL DEFAULT '',
      authored_by TEXT,
      approved_by TEXT,
      about TEXT,
      share_proposed_at INTEGER`;
  const laterPolicy = options.beforeLayers ? "" : `
      utility_allowlist TEXT NOT NULL DEFAULT '[]',
      utility_status TEXT NOT NULL DEFAULT 'disabled',
      utility_max_calls INTEGER NOT NULL DEFAULT 0,
      utility_used_calls INTEGER NOT NULL DEFAULT 0,
      utility_reserved_calls INTEGER NOT NULL DEFAULT 0,
      cross_project TEXT NOT NULL DEFAULT 'ask',`;
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'user', source_session_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_meta (space_id TEXT PRIMARY KEY, data_revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memory_policy (
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('auto','read-only','off')),
      generation TEXT NOT NULL,
      settings_revision INTEGER NOT NULL DEFAULT 1,
      max_records INTEGER NOT NULL DEFAULT 6,
      max_bytes INTEGER NOT NULL DEFAULT 6144,
      max_tokens INTEGER,
      harvesting TEXT NOT NULL DEFAULT 'paused',
      utility_model TEXT,${laterPolicy}
      utility_model_allowed INTEGER NOT NULL DEFAULT 0,
      consent_required INTEGER NOT NULL DEFAULT 1,
      block_without_memory INTEGER NOT NULL DEFAULT 0,
      review_policy TEXT NOT NULL DEFAULT 'manual',
      exclusions TEXT NOT NULL DEFAULT '{"sessions":[],"sources":[],"paths":[]}',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(space_id, project_id)
    );
    CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      category TEXT NOT NULL,
      tags TEXT NOT NULL,
      aliases TEXT NOT NULL,
      applicability TEXT NOT NULL,
      sources TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      evidence TEXT NOT NULL,
      freshness TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      user_locked INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${layers}
    );
    CREATE INDEX idx_memory_project ON memory_records(space_id, project_id, lifecycle, updated_at);
    CREATE TABLE memory_revisions (
      record_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(record_id, revision)
    );
    CREATE TABLE memory_idempotency (
      project_id TEXT NOT NULL, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, operation_key)
    );
    CREATE TABLE memory_tombstones (
      space_id TEXT NOT NULL, project_id TEXT NOT NULL, source_key TEXT NOT NULL, generation TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(space_id, project_id, source_key)
    );
    CREATE TABLE memory_harvest_jobs (
      job_key TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      source_start_seq INTEGER NOT NULL, source_end_seq INTEGER NOT NULL, source_digest TEXT NOT NULL,
      policy_generation TEXT NOT NULL, extractor_version TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_expires_at INTEGER, next_attempt_at INTEGER, receipt_id TEXT, checkpoint_digest TEXT, error_code TEXT
    );
    CREATE INDEX idx_memory_jobs_ready ON memory_harvest_jobs(space_id, project_id, status, next_attempt_at);
    CREATE TABLE memory_harvest_cursors (
      space_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL, next_seq INTEGER NOT NULL,
      policy_generation TEXT NOT NULL, checkpoint_digest TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(space_id, project_id, session_id)
    );
    CREATE TABLE memory_utility_reservations (
      reservation_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT NOT NULL, generation TEXT NOT NULL,
      max_output_tokens INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      memory_id UNINDEXED, space_id UNINDEXED, project_id UNINDEXED,
      title, body, tags, aliases, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE memory_fts_tri USING fts5(
      memory_id UNINDEXED, space_id UNINDEXED, project_id UNINDEXED, text, tokenize='trigram'
    );
    CREATE TRIGGER memory_fts_tri_insert AFTER INSERT ON memory_records BEGIN
      INSERT INTO memory_fts_tri(memory_id, space_id, project_id, text) VALUES(new.id, new.space_id, new.project_id, new.title || char(10) || new.body || char(10) || new.tags || char(10) || new.aliases);
    END;
    CREATE TRIGGER memory_fts_tri_update AFTER UPDATE OF title, body, tags, aliases, project_id ON memory_records BEGIN
      DELETE FROM memory_fts_tri WHERE memory_id = old.id;
      INSERT INTO memory_fts_tri(memory_id, space_id, project_id, text) VALUES(new.id, new.space_id, new.project_id, new.title || char(10) || new.body || char(10) || new.tags || char(10) || new.aliases);
    END;
    CREATE TRIGGER memory_fts_tri_delete AFTER DELETE ON memory_records BEGIN
      DELETE FROM memory_fts_tri WHERE memory_id = old.id;
    END;
  `);
  return db;
}

export interface LegacyRecord {
  id: string;
  projectId: string;
  title: string;
  body: string | null;
  lifecycle?: string;
  revision?: number;
  layer?: string;
  ownerId?: string;
  shareProposedAt?: number;
  tags?: string[];
  at?: number;
}

/** A record written the way the old store wrote one: the row, a copy of the
 * current state in the revision table and an entry in each index. */
export function addLegacyRecord(db: DatabaseSync, spaceId: string, record: LegacyRecord, options: { beforeLayers?: boolean } = {}): void {
  const at = record.at ?? 1_000;
  const tags = JSON.stringify(record.tags ?? []);
  const base = [record.id, spaceId, record.projectId, record.title, record.body, "gotcha", tags, "[]", "{}", JSON.stringify([{ kind: "session", sessionId: "session-old" }]), record.lifecycle ?? "active", "user-stated", "unknown", 0, 1, record.revision ?? 1, at, at + 5];
  if (options.beforeLayers) {
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...base);
  } else {
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...base, record.layer ?? "project", record.ownerId ?? "", JSON.stringify({ kind: "agent", sessionId: "session-old" }), null, null, record.shareProposedAt ?? null);
  }
  for (let revision = 1; revision <= (record.revision ?? 1); revision++) {
    const payload = { id: record.id, projectId: record.projectId, title: revision === (record.revision ?? 1) ? record.title : `${record.title} (draft ${revision})`, body: record.body, category: "gotcha", tags: record.tags ?? [], aliases: [], applicability: {}, sources: [], lifecycle: "active", evidence: "user-stated", freshness: "unknown", pinned: false, userLocked: true, revision, createdAt: at, updatedAt: at + revision };
    db.prepare("INSERT INTO memory_revisions VALUES(?,?,?,?,?)").run(record.id, record.projectId, revision, JSON.stringify(payload), at + revision);
  }
  db.prepare("INSERT INTO memory_fts(memory_id, space_id, project_id, title, body, tags, aliases) VALUES(?,?,?,?,?,?,?)").run(record.id, spaceId, record.projectId, record.title, record.body, (record.tags ?? []).join(" "), "");
}
