// Polyth session log: append-only event store on node:sqlite (WAL).
// Erasable TS only. Local imports use explicit .ts.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { MODEL_VISIBLE_TYPES } from "@polyth/contracts";
import type {
  AgentProfile,
  AttachmentRef,
  ChildSnapshotInput,
  ChildSnapshotResult,
  DeliveryMode,
  JsonObject,
  ModelMessage,
  QueueItemDto,
  SessionEvent,
  SessionFolderDto,
  SessionPersistence,
  SessionProjection,
  WorkspaceLabel,
} from "@polyth/contracts";

export { sessionRetentionSummary } from "./retention.ts";
export type { SessionRetentionSummary } from "./retention.ts";

/** Unresolved-request counters derived from durable events (never cached). */
export interface AttentionCounts { questions: number; permissions: number }

export interface SearchHit { sessionId: string; field: "message"; snippet: string }

export interface PinnedMessageContext {
  sourceEventSeq: number;
  role: "user" | "assistant";
  text: string;
}

/** Fold pin/unpin events against their canonical message source rows. */
export function activePinnedMessages(events: readonly SessionEvent[]): PinnedMessageContext[] {
  const active = new Map<number, boolean>();
  for (const event of events) {
    if (event.type !== "context/pinned" && event.type !== "context/unpinned") continue;
    const seq = Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq);
    if (Number.isSafeInteger(seq) && seq > 0) active.set(seq, event.type === "context/pinned");
  }
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const out: PinnedMessageContext[] = [];
  for (const [sourceEventSeq, pinned] of active) {
    if (!pinned) continue;
    const source = bySeq.get(sourceEventSeq);
    if (source?.type !== "user/message" && source?.type !== "assistant/message") continue;
    const text = (source.data as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) continue;
    out.push({
      sourceEventSeq,
      role: source.type === "user/message" ? "user" : "assistant",
      text,
    });
  }
  return out.sort((a, b) => a.sourceEventSeq - b.sourceEventSeq);
}

/** Latest upstream compaction not already carried by an admitted user turn. */
export function unrestoredCompactionSeq(events: readonly SessionEvent[]): number | null {
  let latest = 0;
  const restored = new Set<number>();
  for (const event of events) {
    if (event.type === "session/compacted") latest = event.seq;
    if (event.type === "user/message") {
      const seq = Number(
        (event.data as { compactionRecovery?: { compactionSeq?: unknown } })
          .compactionRecovery?.compactionSeq,
      );
      if (Number.isSafeInteger(seq) && seq > 0) restored.add(seq);
    }
  }
  return latest > 0 && !restored.has(latest) ? latest : null;
}

export function compactionRecoveryText(input: {
  compactionSeq: number;
  objective?: string;
  pinned: readonly PinnedMessageContext[];
}): string {
  const lines = [
    `<polyth-compaction-recovery compaction-seq="${input.compactionSeq}">`,
    "The upstream session compacted. Restore the durable context below before handling the new request.",
  ];
  if (input.objective?.trim()) {
    lines.push("", "Active objective:", input.objective.trim());
  }
  if (input.pinned.length > 0) {
    lines.push("", "User-pinned context:");
    for (const pin of input.pinned) {
      lines.push(
        `[${pin.role} message, source event ${pin.sourceEventSeq}]`,
        pin.text,
      );
    }
  }
  lines.push("</polyth-compaction-recovery>");
  return lines.join("\n");
}

export const recoveredUserText = (text: string, recoveryContext?: string): string =>
  recoveryContext ? `${recoveryContext}\n\n${text}` : text;

export interface Store extends SessionPersistence {
  exportJsonl(sessionId: string): Promise<string>;
  // -- durable delivery queue (WP3) --
  enqueue(sessionId: string, text: string, delivery: DeliveryMode, attachments?: AttachmentRef[]): Promise<QueueItemDto>;
  queueList(sessionId: string): Promise<QueueItemDto[]>;
  /** Updates only the queued text; delivery, attachments, position, and timestamps stay unchanged. */
  queueEdit(sessionId: string, queueId: string, text: string): Promise<QueueItemDto | undefined>;
  /** Validates ids are an exact permutation for the session; positions update transactionally. */
  queueReorder(sessionId: string, ids: string[]): Promise<QueueItemDto[]>;
  queueRemove(sessionId: string, queueId: string): Promise<boolean>;
  /** Pop the first item (FIFO); undefined when the queue is empty. */
  queueShift(sessionId: string): Promise<QueueItemDto | undefined>;
  deleteProjection(sessionId: string): Promise<void>;
  /** Hard delete: events + projection + queued messages, one transaction. */
  deleteSession(sessionId: string): Promise<void>;
  // -- organization: folders + labels (WP5) --
  folderList(projectId: string): Promise<SessionFolderDto[]>;
  folderCreate(projectId: string, name: string, parentId?: string): Promise<SessionFolderDto>;
  /** Stale expectedRevision → conflict; parent move validates same-project + acyclic. */
  folderUpdate(id: string, patch: { name?: string; parentId?: string | null; position?: number }, expectedRevision: number): Promise<SessionFolderDto>;
  /** Children reparent to the removed folder's parent. Returns false when absent. */
  folderRemove(id: string): Promise<boolean>;
  labelList(): Promise<WorkspaceLabel[]>;
  labelCreate(name: string, color: string): Promise<WorkspaceLabel>;
  labelUpdate(id: string, patch: { name?: string; color?: string; position?: number }, expectedRevision: number): Promise<WorkspaceLabel>;
  labelRemove(id: string): Promise<boolean>;
  // -- derived counters + search (WP5) --
  attentionFor(sessionIds: string[]): Promise<Record<string, AttentionCounts>>;
  /** Bounded LIKE search over message text; snippets are trimmed around the hit. */
  searchEventText(q: string, limit?: number): Promise<SearchHit[]>;
  // -- server-owned agent profiles (WP8) --
  profileList(): Promise<AgentProfile[]>;
  profileGet(id: string): Promise<AgentProfile | undefined>;
  profileCreate(input: Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">): Promise<AgentProfile>;
  /** Stale expectedRevision → conflict. providerID/modelID stay immutable per profile. */
  profileUpdate(id: string, patch: Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">>, expectedRevision: number): Promise<AgentProfile>;
  profileRemove(id: string): Promise<boolean>;
}

const EVENTS_COLS = [
  "session_id",
  "seq",
  "id",
  "time",
  "type",
  "data",
  "ignorable",
  "surface_op",
  "source_seqs",
  "producer",
  "v",
] as const;

export function createStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      id        TEXT NOT NULL,
      time      INTEGER NOT NULL,
      type      TEXT NOT NULL,
      data      TEXT NOT NULL,
      ignorable INTEGER NOT NULL DEFAULT 0,
      surface_op TEXT,
      source_seqs TEXT,
      producer  TEXT,
      v         INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (session_id, seq)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projections (
      session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // Forward-only, transactional schema migrations. Reopening an old DB runs
  // only the missing steps; reopening a new DB is a no-op.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const getVersion = (): number => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  };
  const setVersion = (v: number): void => {
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(v));
  };
  const MIGRATIONS: Array<() => void> = [
    // v1: durable per-session delivery queue (WP3)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_queue (
          queue_id   TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          position   INTEGER NOT NULL,
          text       TEXT NOT NULL,
          delivery   TEXT NOT NULL DEFAULT 'queue',
          created_at INTEGER NOT NULL
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_queue_session ON session_queue (session_id, position)");
    },
    // v2: session folders + workspace labels (WP5)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS folders (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_id  TEXT,
          name       TEXT NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          revision   INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_folders_project ON folders (project_id, position)");
      db.exec(`
        CREATE TABLE IF NOT EXISTS labels (
          id       TEXT PRIMARY KEY,
          name     TEXT NOT NULL,
          color    TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1
        )
      `);
    },
    // v3: server-owned agent profiles (WP8)
    () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_profiles (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id    TEXT NOT NULL,
          agent       TEXT,
          mode        TEXT,
          thinking    TEXT,
          features    TEXT NOT NULL DEFAULT '{}',
          notes       TEXT,
          icon        TEXT,
          color       TEXT,
          revision    INTEGER NOT NULL DEFAULT 1,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        )
      `);
    },
    // v4: queued messages keep their attachments (F2)
    () => {
      db.exec("ALTER TABLE session_queue ADD COLUMN attachments TEXT");
    },
    // v5: index for the message-search read path (searchEventText filters on
    // type and orders by time; the primary key only covers session_id+seq)
    () => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_type_time ON events (type, time)");
    },
  ];
  {
    const current = getVersion();
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        MIGRATIONS[v]!();
        setVersion(v + 1);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  // Prepared-statement cache for the fixed queries below (compiled once, then
  // reused). Created only after migrations so no statement predates an ALTER.
  // Queries with a variable placeholder count (attentionFor) stay uncached.
  const stmts = new Map<string, StatementSync>();
  const prep = (sql: string): StatementSync => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  // ------------------------------------------------------------- append

  function append(
    sessionId: string,
    type: string,
    data: JsonObject,
    opts: Partial<
      Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
    > = {},
  ): Promise<SessionEvent> {
    const id = randomUUID();
    const time = Date.now();
    let seq = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = prep("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?")
        .get(sessionId) as { next: number };
      seq = Number(row.next);
      prep(
        `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        sessionId,
        seq,
        id,
        time,
        type,
        JSON.stringify(data),
        opts.ignorable ? 1 : 0,
        opts.surfaceOp ?? null,
        opts.sourceEventSeqs ? JSON.stringify(opts.sourceEventSeqs) : null,
        opts.producerPlugin ?? null,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    const event: SessionEvent = {
      id,
      sessionId,
      seq,
      time,
      type,
      data,
      ignorable: opts.ignorable,
      surfaceOp: opts.surfaceOp,
      sourceEventSeqs: opts.sourceEventSeqs,
      producerPlugin: opts.producerPlugin,
      v: 1,
    };
    return Promise.resolve(event);
  }

  // ------------------------------------------------------------- reads

  function events(sessionId: string, afterSeq = 0): Promise<SessionEvent[]> {
    const rows = prep("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq")
      .all(sessionId, afterSeq) as unknown as Row[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  function latestSeq(sessionId: string): Promise<number> {
    const row = prep("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE session_id = ?")
      .get(sessionId) as { s: number };
    return Promise.resolve(Number(row.s));
  }

  // ------------------------------------------------------------- fork copy

  function copyTo(srcSessionId: string, dstSessionId: string, upToSeq?: number): Promise<void> {
    db.exec("BEGIN IMMEDIATE");
    try {
      const limit = upToSeq === undefined ? Number.MAX_SAFE_INTEGER : upToSeq;
      const src = prep("SELECT * FROM events WHERE session_id = ? AND seq <= ? ORDER BY seq")
        .all(srcSessionId, limit) as unknown as Row[];

      const next = prep("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?")
        .get(dstSessionId) as { m: number };
      let seq = Number(next.m);

      const ins = prep(
        `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of src) {
        seq += 1;
        ins.run(
          dstSessionId,
          seq,
          r.id,
          r.time,
          r.type,
          r.data,
          r.ignorable,
          r.surface_op,
          r.source_seqs,
          r.producer,
          r.v,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve();
  }

  // ------------------------------------------------------------- atomic child snapshot (UX-MSG-ACTIONS)

  // Per-message fork publication: prefix events + projection + one lineage
  // marker commit together or not at all. Copied events keep their exact
  // source times/payloads, get fresh child ids, and record source-sequence
  // provenance in source_seqs.
  function publishChildSession(input: ChildSnapshotInput): Promise<ChildSnapshotResult> {
    const childId = input.childSessionId;
    const out: SessionEvent[] = [];
    let marker: SessionEvent;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?")
        .get(childId) as { m: number };
      if (Number(existing.m) > 0) {
        throw Object.assign(new Error("child session already has events"), { code: "conflict" });
      }
      const ins = db.prepare(
        `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      let seq = 0;
      for (const e of input.events) {
        seq += 1;
        const id = randomUUID();
        ins.run(
          childId, seq, id, e.time, e.type, JSON.stringify(e.data),
          e.ignorable ? 1 : 0,
          e.surfaceOp ?? null,
          e.sourceSeq !== undefined ? JSON.stringify([e.sourceSeq]) : null,
          e.producerPlugin ?? null,
        );
        out.push({
          id, sessionId: childId, seq, time: e.time, type: e.type, data: e.data,
          ...(e.ignorable ? { ignorable: true } : {}),
          ...(e.surfaceOp ? { surfaceOp: e.surfaceOp } : {}),
          ...(e.sourceSeq !== undefined ? { sourceEventSeqs: [e.sourceSeq] } : {}),
          ...(e.producerPlugin ? { producerPlugin: e.producerPlugin } : {}),
          v: 1,
        });
      }
      seq += 1;
      const markerId = randomUUID();
      const markerTime = Date.now();
      ins.run(
        childId, seq, markerId, markerTime, input.marker.type, JSON.stringify(input.marker.data),
        input.marker.ignorable ? 1 : 0, null, null, null,
      );
      marker = {
        id: markerId, sessionId: childId, seq, time: markerTime,
        type: input.marker.type, data: input.marker.data,
        ...(input.marker.ignorable ? { ignorable: true } : {}),
        v: 1,
      };
      db.prepare(
        `INSERT INTO projections (session_id, data) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
      ).run(input.projection.id, JSON.stringify(input.projection));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve({ events: out, marker });
  }

  // ------------------------------------------------------------- projections

  function upsertProjection(p: SessionProjection): Promise<void> {
    prep(
      `INSERT INTO projections (session_id, data) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
    ).run(p.id, JSON.stringify(p));
    return Promise.resolve();
  }

  // Atomic read-modify-write: increments (token totals) and status patches
  // always apply to the latest committed row, so an awaited callback can never
  // overwrite fields a later callback already changed.
  function patchProjection(
    sessionId: string,
    patch: (current: SessionProjection) => SessionProjection,
  ): Promise<SessionProjection | undefined> {
    let next: SessionProjection | undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT data FROM projections WHERE session_id = ?")
        .get(sessionId) as { data: string } | undefined;
      if (row) {
        next = patch(JSON.parse(row.data) as SessionProjection);
        db.prepare("UPDATE projections SET data = ? WHERE session_id = ?")
          .run(JSON.stringify(next), sessionId);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve(next);
  }

  function projection(sessionId: string): Promise<SessionProjection | undefined> {
    const row = prep("SELECT data FROM projections WHERE session_id = ?")
      .get(sessionId) as { data: string } | undefined;
    return Promise.resolve(row ? (JSON.parse(row.data) as SessionProjection) : undefined);
  }

  function projections(projectId?: string): Promise<SessionProjection[]> {
    const rows = projectId === undefined
      ? (prep("SELECT data FROM projections").all() as { data: string }[])
      : (prep("SELECT data FROM projections WHERE json_extract(data, '$.projectId') = ?")
          .all(projectId) as { data: string }[]);
    return Promise.resolve(rows.map((r) => JSON.parse(r.data) as SessionProjection));
  }

  // ------------------------------------------------------------- export

  function exportJsonl(sessionId: string): Promise<string> {
    const rows = db
      .prepare("SELECT data FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { data: string }[];
    return Promise.resolve(rows.map((r) => r.data).join("\n"));
  }

  // ------------------------------------------------------------- delivery queue (WP3)

  interface QueueRow {
    queue_id: string;
    session_id: string;
    position: number;
    text: string;
    delivery: string;
    created_at: number;
    attachments: string | null;
  }

  const parseAttachments = (raw: string | null): AttachmentRef[] | undefined => {
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) && v.length > 0 ? (v as AttachmentRef[]) : undefined;
    } catch {
      return undefined;
    }
  };

  const rowToQueueItem = (r: QueueRow): QueueItemDto => {
    const attachments = parseAttachments(r.attachments);
    return {
      id: r.queue_id,
      sessionId: r.session_id,
      position: Number(r.position),
      text: r.text,
      delivery: (["normal", "steer", "queue", "interrupt"].includes(r.delivery) ? r.delivery : "queue") as DeliveryMode,
      createdAt: Number(r.created_at),
      ...(attachments ? { attachments } : {}),
    };
  };

  async function enqueue(sessionId: string, text: string, delivery: DeliveryMode, attachments?: AttachmentRef[]): Promise<QueueItemDto> {
    const queueId = randomUUID();
    const createdAt = Date.now();
    let position = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = prep("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM session_queue WHERE session_id = ?")
        .get(sessionId) as { next: number };
      position = Number(row.next);
      prep(
        "INSERT INTO session_queue (queue_id, session_id, position, text, delivery, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(queueId, sessionId, position, text, delivery, createdAt, attachments?.length ? JSON.stringify(attachments) : null);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return {
      id: queueId, sessionId, position, text, delivery, createdAt,
      ...(attachments?.length ? { attachments } : {}),
    };
  }

  function queueList(sessionId: string): Promise<QueueItemDto[]> {
    const rows = prep("SELECT * FROM session_queue WHERE session_id = ? ORDER BY position")
      .all(sessionId) as unknown as QueueRow[];
    return Promise.resolve(rows.map(rowToQueueItem));
  }

  function queueEdit(sessionId: string, queueId: string, text: string): Promise<QueueItemDto | undefined> {
    const result = prep("UPDATE session_queue SET text = ? WHERE session_id = ? AND queue_id = ?")
      .run(text, sessionId, queueId);
    if (Number(result.changes) === 0) return Promise.resolve(undefined);
    const row = prep("SELECT * FROM session_queue WHERE session_id = ? AND queue_id = ?")
      .get(sessionId, queueId) as unknown as QueueRow;
    return Promise.resolve(rowToQueueItem(row));
  }

  async function queueReorder(sessionId: string, ids: string[]): Promise<QueueItemDto[]> {
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = prep("SELECT queue_id FROM session_queue WHERE session_id = ?")
        .all(sessionId) as { queue_id: string }[];
      const existing = new Set(rows.map((r) => r.queue_id));
      const submitted = new Set(ids);
      if (existing.size !== submitted.size || ids.length !== submitted.size || [...existing].some((id) => !submitted.has(id))) {
        throw Object.assign(new Error("ids must be an exact permutation of the session queue"), { code: "invalid-input" });
      }
      const upd = prep("UPDATE session_queue SET position = ? WHERE queue_id = ? AND session_id = ?");
      ids.forEach((id, i) => upd.run(i, id, sessionId));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return queueList(sessionId);
  }

  function queueRemove(sessionId: string, queueId: string): Promise<boolean> {
    const res = prep("DELETE FROM session_queue WHERE session_id = ? AND queue_id = ?")
      .run(sessionId, queueId);
    return Promise.resolve(Number(res.changes) > 0);
  }

  function queueShift(sessionId: string): Promise<QueueItemDto | undefined> {
    let item: QueueItemDto | undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = prep("SELECT * FROM session_queue WHERE session_id = ? ORDER BY position LIMIT 1")
        .get(sessionId) as QueueRow | undefined;
      if (row) {
        prep("DELETE FROM session_queue WHERE queue_id = ?").run(row.queue_id);
        item = rowToQueueItem(row);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve(item);
  }

  function deleteProjection(sessionId: string): Promise<void> {
    prep("DELETE FROM projections WHERE session_id = ?").run(sessionId);
    return Promise.resolve();
  }

  /** Hard delete: events + projection + queued messages, one transaction. */
  function deleteSession(sessionId: string): Promise<void> {
    db.exec("BEGIN IMMEDIATE");
    try {
      prep("DELETE FROM events WHERE session_id = ?").run(sessionId);
      prep("DELETE FROM projections WHERE session_id = ?").run(sessionId);
      prep("DELETE FROM session_queue WHERE session_id = ?").run(sessionId);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return Promise.resolve();
  }

  // ------------------------------------------------------------- folders + labels (WP5)

  interface FolderRow { id: string; project_id: string; parent_id: string | null; name: string; position: number; revision: number }
  const rowToFolder = (r: FolderRow): SessionFolderDto => ({
    id: r.id,
    projectId: r.project_id,
    ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
    name: r.name,
    position: Number(r.position),
    revision: Number(r.revision),
  });

  const folderRow = (id: string): FolderRow | undefined =>
    prep("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | undefined;

  const folderNameKey = (name: string): string => name.normalize("NFKC").trim().toLowerCase();
  const assertUniqueFolderName = (
    projectId: string,
    parentId: string | null,
    name: string,
    exceptIds: readonly string[] = [],
  ): void => {
    const siblings = db.prepare("SELECT * FROM folders WHERE project_id = ?").all(projectId) as unknown as FolderRow[];
    const duplicate = siblings.some((row) =>
      !exceptIds.includes(row.id)
      && row.parent_id === parentId
      && folderNameKey(row.name) === folderNameKey(name));
    if (duplicate) {
      throw Object.assign(new Error(`A folder named "${name}" already exists here.`), { code: "conflict" });
    }
  };

  /** True when `candidateAncestor` is `id` itself or any ancestor of `id`. */
  const folderHasAncestor = (id: string, candidateAncestor: string): boolean => {
    let cur: string | null = id;
    for (let hops = 0; cur !== null && hops < 1000; hops++) {
      if (cur === candidateAncestor) return true;
      const row = folderRow(cur);
      cur = row?.parent_id ?? null;
    }
    return false;
  };

  async function folderList(projectId: string): Promise<SessionFolderDto[]> {
    const rows = db
      .prepare("SELECT * FROM folders WHERE project_id = ? ORDER BY position, name")
      .all(projectId) as unknown as FolderRow[];
    return rows.map(rowToFolder);
  }

  async function folderCreate(projectId: string, name: string, parentId?: string): Promise<SessionFolderDto> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw Object.assign(new Error("folder name required (≤120 chars)"), { code: "invalid-input" });
    if (parentId !== undefined) {
      const parent = folderRow(parentId);
      if (!parent) throw Object.assign(new Error("parent folder not found"), { code: "not-found" });
      if (parent.project_id !== projectId) throw Object.assign(new Error("parent folder belongs to another project"), { code: "invalid-input" });
    }
    assertUniqueFolderName(projectId, parentId ?? null, trimmed);
    const id = randomUUID();
    const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM folders WHERE project_id = ?").get(projectId) as { next: number };
    db.prepare("INSERT INTO folders (id, project_id, parent_id, name, position, revision) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, projectId, parentId ?? null, trimmed, Number(pos.next));
    return rowToFolder(folderRow(id)!);
  }

  async function folderUpdate(
    id: string,
    patch: { name?: string; parentId?: string | null; position?: number },
    expectedRevision: number,
  ): Promise<SessionFolderDto> {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = folderRow(id);
      if (!row) throw Object.assign(new Error("folder not found"), { code: "not-found" });
      if (Number(row.revision) !== expectedRevision) {
        throw Object.assign(new Error("stale folder revision"), { code: "conflict" });
      }
      let name = row.name;
      if (patch.name !== undefined) {
        name = patch.name.trim();
        if (!name || name.length > 120) throw Object.assign(new Error("folder name required (≤120 chars)"), { code: "invalid-input" });
      }
      let parentId = row.parent_id;
      if (patch.parentId !== undefined) {
        if (patch.parentId === null) {
          parentId = null;
        } else {
          const parent = folderRow(patch.parentId);
          if (!parent) throw Object.assign(new Error("parent folder not found"), { code: "not-found" });
          if (parent.project_id !== row.project_id) {
            throw Object.assign(new Error("cross-project folder moves are not allowed"), { code: "invalid-input" });
          }
          // Cycle guard: the new parent must not be the folder or its descendant.
          if (folderHasAncestor(patch.parentId, id)) {
            throw Object.assign(new Error("folder move would create a cycle"), { code: "invalid-input" });
          }
          parentId = patch.parentId;
        }
      }
      assertUniqueFolderName(row.project_id, parentId, name, [id]);
      const position = patch.position !== undefined ? patch.position : Number(row.position);
      db.prepare("UPDATE folders SET name = ?, parent_id = ?, position = ?, revision = revision + 1 WHERE id = ?")
        .run(name, parentId, position, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return rowToFolder(folderRow(id)!);
  }

  async function folderRemove(id: string): Promise<boolean> {
    let removed = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = folderRow(id);
      if (row) {
        const children = db.prepare("SELECT * FROM folders WHERE parent_id = ?").all(id) as unknown as FolderRow[];
        for (const child of children) {
          assertUniqueFolderName(row.project_id, row.parent_id, child.name, [id, child.id]);
        }
        db.prepare("UPDATE folders SET parent_id = ?, revision = revision + 1 WHERE parent_id = ?").run(row.parent_id, id);
        db.prepare("DELETE FROM folders WHERE id = ?").run(id);
        removed = true;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return removed;
  }

  interface LabelRow { id: string; name: string; color: string; position: number; revision: number }
  const rowToLabel = (r: LabelRow): WorkspaceLabel => ({
    id: r.id, name: r.name, color: r.color, position: Number(r.position), revision: Number(r.revision),
  });

  async function labelList(): Promise<WorkspaceLabel[]> {
    const rows = db.prepare("SELECT * FROM labels ORDER BY position, name").all() as unknown as LabelRow[];
    return rows.map(rowToLabel);
  }

  async function labelCreate(name: string, color: string): Promise<WorkspaceLabel> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) throw Object.assign(new Error("label name required (≤60 chars)"), { code: "invalid-input" });
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) throw Object.assign(new Error("label color must be a hex value"), { code: "invalid-input" });
    const id = randomUUID();
    const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM labels").get() as { next: number };
    db.prepare("INSERT INTO labels (id, name, color, position, revision) VALUES (?, ?, ?, ?, 1)")
      .run(id, trimmed, color, Number(pos.next));
    const row = db.prepare("SELECT * FROM labels WHERE id = ?").get(id) as unknown as LabelRow;
    return rowToLabel(row);
  }

  async function labelUpdate(
    id: string,
    patch: { name?: string; color?: string; position?: number },
    expectedRevision: number,
  ): Promise<WorkspaceLabel> {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT * FROM labels WHERE id = ?").get(id) as LabelRow | undefined;
      if (!row) throw Object.assign(new Error("label not found"), { code: "not-found" });
      if (Number(row.revision) !== expectedRevision) throw Object.assign(new Error("stale label revision"), { code: "conflict" });
      const name = patch.name !== undefined ? patch.name.trim() : row.name;
      if (!name || name.length > 60) throw Object.assign(new Error("label name required (≤60 chars)"), { code: "invalid-input" });
      const color = patch.color ?? row.color;
      if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) throw Object.assign(new Error("label color must be a hex value"), { code: "invalid-input" });
      const position = patch.position ?? Number(row.position);
      db.prepare("UPDATE labels SET name = ?, color = ?, position = ?, revision = revision + 1 WHERE id = ?")
        .run(name, color, position, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    const row = db.prepare("SELECT * FROM labels WHERE id = ?").get(id) as unknown as LabelRow;
    return rowToLabel(row);
  }

  async function labelRemove(id: string): Promise<boolean> {
    const res = db.prepare("DELETE FROM labels WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  // ------------------------------------------------------------- agent profiles (WP8)

  interface ProfileRow {
    id: string; name: string; provider_id: string; model_id: string;
    agent: string | null; mode: string | null; thinking: string | null;
    features: string; notes: string | null; icon: string | null; color: string | null;
    revision: number; created_at: number; updated_at: number;
  }
  const rowToProfile = (r: ProfileRow): AgentProfile => ({
    id: r.id,
    name: r.name,
    providerID: r.provider_id,
    modelID: r.model_id,
    ...(r.agent ? { agent: r.agent } : {}),
    ...(r.mode ? { mode: r.mode } : {}),
    ...(r.thinking ? { thinking: r.thinking } : {}),
    features: safeFeatures(r.features),
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.icon ? { icon: r.icon } : {}),
    ...(r.color ? { color: r.color } : {}),
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
  const safeFeatures = (raw: string): Record<string, boolean> => {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, boolean> = {};
      for (const [k, val] of Object.entries(v)) if (typeof val === "boolean") out[k] = val;
      return out;
    } catch {
      return {};
    }
  };
  const profileRow = (id: string): ProfileRow | undefined =>
    db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as unknown as ProfileRow | undefined;

  async function profileList(): Promise<AgentProfile[]> {
    const rows = db.prepare("SELECT * FROM agent_profiles ORDER BY name").all() as unknown as ProfileRow[];
    return rows.map(rowToProfile);
  }

  async function profileGet(id: string): Promise<AgentProfile | undefined> {
    const row = profileRow(id);
    return row ? rowToProfile(row) : undefined;
  }

  async function profileCreate(
    input: Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">,
  ): Promise<AgentProfile> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw Object.assign(new Error("profile name required (≤80 chars)"), { code: "invalid-input" });
    if (!input.providerID || !input.modelID) throw Object.assign(new Error("providerID and modelID are required"), { code: "invalid-input" });
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO agent_profiles (id, name, provider_id, model_id, agent, mode, thinking, features, notes, icon, color, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id, name, input.providerID, input.modelID,
      input.agent ?? null, input.mode ?? null, input.thinking ?? null,
      JSON.stringify(input.features ?? {}), input.notes ?? null, input.icon ?? null, input.color ?? null,
      now, now,
    );
    return rowToProfile(profileRow(id)!);
  }

  async function profileUpdate(
    id: string,
    patch: Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">>,
    expectedRevision: number,
  ): Promise<AgentProfile> {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = profileRow(id);
      if (!row) throw Object.assign(new Error("profile not found"), { code: "not-found" });
      if (Number(row.revision) !== expectedRevision) throw Object.assign(new Error("stale profile revision"), { code: "conflict" });
      const name = patch.name !== undefined ? patch.name.trim() : row.name;
      if (!name || name.length > 80) throw Object.assign(new Error("profile name required (≤80 chars)"), { code: "invalid-input" });
      db.prepare(
        `UPDATE agent_profiles SET name = ?, provider_id = ?, model_id = ?, agent = ?, mode = ?, thinking = ?,
         features = ?, notes = ?, icon = ?, color = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      ).run(
        name,
        patch.providerID ?? row.provider_id,
        patch.modelID ?? row.model_id,
        patch.agent !== undefined ? patch.agent || null : row.agent,
        patch.mode !== undefined ? patch.mode || null : row.mode,
        patch.thinking !== undefined ? patch.thinking || null : row.thinking,
        patch.features !== undefined ? JSON.stringify(patch.features) : row.features,
        patch.notes !== undefined ? patch.notes || null : row.notes,
        patch.icon !== undefined ? patch.icon || null : row.icon,
        patch.color !== undefined ? patch.color || null : row.color,
        Date.now(), id,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return rowToProfile(profileRow(id)!);
  }

  async function profileRemove(id: string): Promise<boolean> {
    const res = db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  // ------------------------------------------------------------- attention + search (WP5)

  async function attentionFor(sessionIds: string[]): Promise<Record<string, AttentionCounts>> {
    const out: Record<string, AttentionCounts> = {};
    if (sessionIds.length === 0) return out;
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT session_id, type, json_extract(data, '$.requestId') AS rid FROM events
         WHERE type IN ('permission/requested','permission/resolved','question/asked','question/answered')
           AND session_id IN (${placeholders}) ORDER BY seq`,
      )
      .all(...sessionIds) as Array<{ session_id: string; type: string; rid: string | null }>;
    const open = new Map<string, { q: Set<string>; p: Set<string> }>();
    for (const r of rows) {
      if (!r.rid) continue;
      let s = open.get(r.session_id);
      if (!s) open.set(r.session_id, (s = { q: new Set(), p: new Set() }));
      if (r.type === "permission/requested") s.p.add(r.rid);
      else if (r.type === "permission/resolved") s.p.delete(r.rid);
      else if (r.type === "question/asked") s.q.add(r.rid);
      else if (r.type === "question/answered") s.q.delete(r.rid);
    }
    for (const id of sessionIds) {
      const s = open.get(id);
      out[id] = { questions: s?.q.size ?? 0, permissions: s?.p.size ?? 0 };
    }
    return out;
  }

  const SNIPPET_RADIUS = 40;

  async function searchEventText(q: string, limit = 50): Promise<SearchHit[]> {
    const needle = q.trim();
    if (!needle) return [];
    const like = `%${needle.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = prep(
      `SELECT session_id, data FROM events
       WHERE type IN ('user/message','assistant/message') AND data LIKE ? ESCAPE '\\'
       ORDER BY time DESC LIMIT ?`,
    ).all(like, limit * 4) as Array<{ session_id: string; data: string }>;
    const out: SearchHit[] = [];
    const perSession = new Map<string, number>();
    for (const r of rows) {
      if (out.length >= limit) break;
      const count = perSession.get(r.session_id) ?? 0;
      if (count >= 2) continue; // at most 2 snippets per session
      let text = "";
      try {
        text = String((JSON.parse(r.data) as { text?: string }).text ?? "");
      } catch { continue; }
      const at = text.toLowerCase().indexOf(needle.toLowerCase());
      if (at < 0) continue;
      const start = Math.max(0, at - SNIPPET_RADIUS);
      const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
      const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
      out.push({ sessionId: r.session_id, field: "message", snippet });
      perSession.set(r.session_id, count + 1);
    }
    return out;
  }

  function close(): Promise<void> {
    db.close();
    return Promise.resolve();
  }

  return {
    append,
    events,
    latestSeq,
    copyTo,
    publishChildSession,
    upsertProjection,
    patchProjection,
    projection,
    projections,
    exportJsonl,
    enqueue,
    queueList,
    queueEdit,
    queueReorder,
    queueRemove,
    queueShift,
    deleteProjection,
    deleteSession,
    folderList,
    folderCreate,
    folderUpdate,
    folderRemove,
    labelList,
    labelCreate,
    labelUpdate,
    labelRemove,
    attentionFor,
    searchEventText,
    profileList,
    profileGet,
    profileCreate,
    profileUpdate,
    profileRemove,
    close,
  };
}

// ------------------------------------------------------------- row mapping

interface Row {
  session_id: string;
  seq: number;
  id: string;
  time: number;
  type: string;
  data: string;
  ignorable: number;
  surface_op: string | null;
  source_seqs: string | null;
  producer: string | null;
  v: number;
}

function rowToEvent(r: Row): SessionEvent {
  const event: SessionEvent = {
    id: r.id,
    sessionId: r.session_id,
    seq: Number(r.seq),
    time: Number(r.time),
    type: r.type,
    data: JSON.parse(r.data) as JsonObject,
    v: 1,
  };
  if (r.ignorable) event.ignorable = true;
  if (r.surface_op !== null) event.surfaceOp = r.surface_op as "append" | "replace";
  if (r.source_seqs !== null) event.sourceEventSeqs = JSON.parse(r.source_seqs) as number[];
  if (r.producer !== null) event.producerPlugin = r.producer;
  return event;
}

// ------------------------------------------------------------- deriveMessages

export interface ActiveRewind {
  markerSeq: number;
  atSeq: number;
  restoredText?: string;
}

/** Latest unresolved rewind marker. Replaced clears and redo clears both resolve it. */
export function activeRewind(events: readonly SessionEvent[]): ActiveRewind | null {
  let active: ActiveRewind | null = null;
  for (const ev of events) {
    if (ev.type === "session/rewound") {
      const atSeq = Number((ev.data as { atSeq?: unknown }).atSeq);
      if (Number.isSafeInteger(atSeq) && atSeq > 0) {
        const restored = (ev.data as { restoredText?: unknown }).restoredText;
        active = {
          markerSeq: ev.seq,
          atSeq,
          ...(typeof restored === "string" ? { restoredText: restored } : {}),
        };
      }
      continue;
    }
    if (ev.type === "session/rewind-cleared" && active) {
      const rewindSeq = Number((ev.data as { rewindSeq?: unknown }).rewindSeq);
      if (!Number.isSafeInteger(rewindSeq) || rewindSeq === active.markerSeq) active = null;
    }
  }
  return active;
}

/** The one pure effective-history selector (UX-MSG-ACTIONS): timeline replay,
 *  model derivation, export, mutation eligibility, and backend branch
 *  preparation all consume this so they can never disagree about the visible
 *  prefix. Rewinds splice history without mutating old rows: redo restores the
 *  captured tail; a replacement clear permanently drops it and lets subsequent
 *  events form a new tail. */
export interface EffectiveHistory {
  /** Visible events in order; rewind markers themselves are excluded. */
  events: SessionEvent[];
  /** Tail hidden by the currently active rewind marker (empty when none). */
  hidden: SessionEvent[];
  /** The active (unresolved) rewind marker, if any. */
  rewind: { markerSeq: number; atSeq: number } | null;
}

export function effectiveHistory(events: readonly SessionEvent[]): EffectiveHistory {
  let visibleEvents: SessionEvent[] = [];
  let hidden: { markerSeq: number; atSeq: number; events: SessionEvent[] } | null = null;

  for (const ev of events) {
    if (ev.type === "session/rewound") {
      const atSeq = Number((ev.data as { atSeq?: unknown }).atSeq);
      if (Number.isSafeInteger(atSeq) && atSeq > 0) {
        hidden = { markerSeq: ev.seq, atSeq, events: visibleEvents.filter((item) => item.seq >= atSeq) };
        visibleEvents = visibleEvents.filter((item) => item.seq < atSeq);
      }
      continue;
    }
    if (ev.type === "session/rewind-cleared" && hidden) {
      const d = ev.data as { rewindSeq?: unknown; replaced?: unknown };
      const markerMatches = d.rewindSeq === undefined || Number(d.rewindSeq) === hidden.markerSeq;
      if (markerMatches) {
        if (d.replaced !== true) visibleEvents.push(...hidden.events);
        hidden = null;
      }
      continue;
    }
    visibleEvents.push(ev);
  }

  return {
    events: visibleEvents,
    hidden: hidden?.events ?? [],
    rewind: hidden ? { markerSeq: hidden.markerSeq, atSeq: hidden.atSeq } : null,
  };
}

/** Composer seed for the active rewind marker: the hidden target's exact
 *  `raw ?? text` plus attachments. Null when no rewind is active. */
export function rewindDraft(events: readonly SessionEvent[]): { text: string; attachments: AttachmentRef[] } | null {
  const eff = effectiveHistory(events);
  if (!eff.rewind) return null;
  const target = eff.hidden.find((ev) => ev.seq === eff.rewind!.atSeq && ev.type === "user/message");
  if (!target) return null;
  const d = target.data as { raw?: unknown; text?: unknown; attachments?: unknown };
  const text = typeof d.raw === "string" ? d.raw : typeof d.text === "string" ? d.text : "";
  const attachments = Array.isArray(d.attachments) ? (d.attachments as AttachmentRef[]) : [];
  return { text, attachments };
}

export function deriveMessages(events: SessionEvent[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  const visibleEvents = effectiveHistory(events).events;

  const pushText = (role: "user" | "assistant" | "tool", text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts.push({ type: "text", text });
    } else {
      out.push({ role, parts: [{ type: "text", text }] });
    }
  };

  // Attachments ride the same user message so replay/fork keeps them adjacent
  // to the text the model saw. Malformed rows are skipped, never thrown.
  const pushUserFiles = (attachments: unknown) => {
    if (!Array.isArray(attachments)) return;
    const last = out[out.length - 1];
    if (!last || last.role !== "user") return;
    for (const raw of attachments) {
      const a = raw as { name?: unknown; mime?: unknown; path?: unknown; url?: unknown; range?: unknown };
      if (typeof a?.name !== "string" || typeof a?.mime !== "string") continue;
      const range = Array.isArray(a.range) && a.range.length === 2
        && Number.isSafeInteger(a.range[0]) && Number.isSafeInteger(a.range[1])
        ? [Number(a.range[0]), Number(a.range[1])] as [number, number]
        : undefined;
      last.parts.push({
        type: "file",
        name: a.name,
        mime: a.mime,
        ...(typeof a.path === "string" ? { path: a.path } : {}),
        ...(typeof a.url === "string" ? { url: a.url } : {}),
        ...(range ? { range } : {}),
      });
    }
  };

  const pushReasoning = (text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      last.parts.push({ type: "reasoning", text });
    } else {
      out.push({ role: "assistant", parts: [{ type: "reasoning", text }] });
    }
  };

  const pushToolCall = (
    callId: string,
    tool: string,
    input: JsonObject,
  ) => {
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      last.parts.push({ type: "tool-call", callId, tool, input });
    } else {
      out.push({ role: "assistant", parts: [{ type: "tool-call", callId, tool, input }] });
    }
  };

  const pushToolResult = (
    callId: string,
    tool: string,
    output: string,
    isError: boolean,
  ) => {
    const last = out[out.length - 1];
    if (last && last.role === "tool") {
      last.parts.push({ type: "tool-result", callId, tool, output, isError });
    } else {
      out.push({ role: "tool", parts: [{ type: "tool-result", callId, tool, output, isError }] });
    }
  };

  for (const ev of visibleEvents) {
    if (!MODEL_VISIBLE_TYPES.includes(ev.type as (typeof MODEL_VISIBLE_TYPES)[number])) {
      continue;
    }
    if (ev.ignorable) continue;

    const d = ev.data as Record<string, JsonObject>;
    switch (ev.type) {
      case "user/message":
        pushText(
          "user",
          recoveredUserText(
            String(d.text ?? ""),
            typeof d.recoveryContext === "string" ? d.recoveryContext : undefined,
          ),
        );
        pushUserFiles(d.attachments);
        break;
      case "assistant/message": {
        const text = String(d.text ?? "");
        const reasoning = d.reasoning === undefined ? undefined : String(d.reasoning);
        if (reasoning) pushReasoning(reasoning);
        // Reasoning-only final records carry text:"" — an empty text part must
        // not become an ordinary answer bubble in model history.
        if (text !== "") pushText("assistant", text);
        break;
      }
      case "tool/call":
        pushToolCall(String(d.callId ?? ""), String(d.tool ?? ""), (d.input as JsonObject) ?? {});
        break;
      case "tool/result":
        pushToolResult(
          String(d.callId ?? ""),
          String(d.tool ?? ""),
          String(d.output ?? ""),
          false,
        );
        break;
      case "tool/error":
        pushToolResult(
          String(d.callId ?? ""),
          String(d.tool ?? ""),
          String(d.error ?? ""),
          true,
        );
        break;
      case "question/asked": {
        const questions = Array.isArray(d.questions) ? (d.questions as JsonObject[]) : [];
        const summary = questions.map((q) => String(q.text ?? q.question ?? "")).filter(Boolean).join("; ");
        if (summary) pushText("assistant", summary);
        break;
      }
      case "question/answered": {
        const answers = d.answers as JsonObject | undefined;
        const text = answers !== undefined ? JSON.stringify(answers) : "";
        if (text) pushText("user", text);
        break;
      }
    }
  }

  return out;
}
