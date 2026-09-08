// Polyth session log: append-only event store on node:sqlite (WAL).
// Erasable TS only. Local imports use explicit .ts.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { MODEL_VISIBLE_TYPES, formatBrowserContextForModel, clampPromptHistoryLimit } from "@polyth/contracts";
import { withImmediateTransaction, type SyncOnly } from "./syncTransaction.ts";
import type {
  AgentProfile,
  AttachmentRef,
  BrowserContext,
  CanonicalEventInput,
  ChildSnapshotInput,
  ChildSnapshotResult,
  DeletionTombstone,
  DeletionTombstoneBinding,
  DeliveryMode,
  DurableOperation,
  DurableReconciliation,
  DurableResponseIntent,
  EventPage,
  JsonObject,
  ModelMessage,
  MutationOutcome,
  ObservationCheckpoint,
  ObservationEntityKey,
  ObservationIngestionInput,
  ObservationIngestionResult,
  ObservationCursorKey,
  OperationClaimResult,
  OperationSettlement,
  PersistedRuntimeBinding,
  PrepareDeletionTombstoneInput,
  PreparedDeletionTombstoneResult,
  PrepareOperationInput,
  PreparedOperationResult,
  PrepareSessionCreateInput,
  PreparedSessionCreateResult,
  PromptHistoryEntryDto,
  QueueItemDto,
  QueueReservation,
  QueueReservationInput,
  QueueReservationResult,
  ReplayPolicy,
  ResponseIntentChoice,
  ResponseIntentInput,
  ResponseIntentSettlement,
  RuntimeEpochTransitionInput,
  RuntimeEpochTransitionResult,
  RuntimeMutationKind,
  RuntimeRestartRecoveryInput,
  RuntimeRestartRecoveryResult,
  SessionEvent,
  SessionFolderDto,
  SessionPersistence,
  SessionProjection,
  SnapshotIngestionInput,
  SnapshotIngestionResult,
  WorkspaceLabel,
} from "@polyth/contracts";
import {
  activeObjectiveFromEvents,
  attachedKnowledge,
  buildRuntimeEpochRecoveryContext,
  compactionSummariesFromEvents,
  dialogueFromMessages,
} from "./recovery.ts";
import { effectiveHistory, recoveredUserText } from "./history.ts";
import {
  parsePromptHistoryCandidate,
  rewindVisibility,
  type PromptHistoryCandidateRow,
  type RewindMarkerRow,
} from "./promptHistory.ts";

const PROMPT_HISTORY_CHUNK = 32;

export { redactContinuity } from "./continuity.ts";
export type { ContinuityWorkspace } from "./continuity.ts";
export { sessionRetentionSummary } from "./retention.ts";
export type { SessionRetentionSummary } from "./retention.ts";

/** Unresolved-request counters derived from durable events (never cached). */
export interface AttentionCounts { questions: number; permissions: number; unread: number }

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

export { effectiveHistory, recoveredUserText } from "./history.ts";
export { latestCompletedExchange, type CompletedExchange } from "./nextAction.ts";

export {
  EPOCH_RECOVERY_BUDGET_SHARE,
  EPOCH_RECOVERY_MAX_CHARS,
  EPOCH_RECOVERY_MAX_MESSAGES,
  EPOCH_RECOVERY_NOTE_LINES,
  activeObjectiveFromEvents,
  attachedKnowledge,
  buildRuntimeEpochRecoveryContext,
  compactionSummariesFromEvents,
  dialogueFromMessages,
  escapeRecoveryText,
  formatRecoveryDialogueLine,
} from "./recovery.ts";
export type {
  RuntimeEpochRecoveryAttachment,
  RuntimeEpochRecoveryBuild,
  RuntimeEpochRecoveryDialogueLine,
  RuntimeEpochRecoveryInput,
  RuntimeEpochRecoveryKnowledge,
  RuntimeEpochRecoveryPin,
  RuntimeEpochRecoverySectionChars,
} from "./recovery.ts";
export {
  sessionDebugObservability,
  snapshotDebugEndpoint,
  snapshotDebugRuntimeBinding,
} from "./sessionDebug.ts";
export type { SessionDebugObservabilityInput } from "./sessionDebug.ts";

export interface Store extends SessionPersistence {
  exportJsonl(sessionId: string): Promise<string>;
  /** Owning Space of one session (undefined when unknown / pre-tenancy). */
  spaceOfSession(sessionId: string): string | undefined;
  /** Boot migration: adopt ownerless projections into the default Space. */
  adoptSessionsIntoSpace(spaceId: string): Promise<number>;
  /** Boot migration: adopt ownerless workspace labels into the default Space. */
  adoptLabelsIntoSpace(spaceId: string): Promise<number>;
  // -- durable runtime operations --
  prepareOperation(input: PrepareOperationInput): Promise<PreparedOperationResult>;
  prepareSessionCreate(input: PrepareSessionCreateInput): Promise<PreparedSessionCreateResult>;
  operation(operationId: string): Promise<DurableOperation | undefined>;
  operations(sessionId: string): Promise<DurableOperation[]>;
  claimOperation(operationId: string): Promise<OperationClaimResult>;
  /** The only unknown -> executing path. The exact pinned contract must match
   * the replay contract captured at preparation. */
  replayUnknownOperation(operationId: string, contract: string): Promise<OperationClaimResult>;
  settleOperation(operationId: string, settlement: OperationSettlement): Promise<DurableOperation>;
  /** Append the epoch marker, swap the binding, interrupt pre-reset prepared
   *  and executing operations, and optionally fence the destroyed authority's
   *  prior unknowns in one SQLite transaction. */
  transitionRuntimeEpoch(input: RuntimeEpochTransitionInput): Promise<RuntimeEpochTransitionResult>;
  /** Startup runs this automatically; the explicit API is useful before
   * handing an already-open database to a recovered scheduler. */
  recoverExecutingOperations(sessionId?: string): Promise<DurableOperation[]>;
  /** Warm-restart recovery: after reconciliation re-verifies the SAME owned
   *  backend session, lift restart-stranded (`code = 'process-restarted'`)
   *  `turn-submit` / `turn-steer` unknowns out of the send-admission barrier
   *  by writing an ignorable `runtime/restart-recovered` marker, and hold any
   *  reserved queue draft for review. The operations stay `unknown`. Returns
   *  `undefined` when there is nothing to recover. */
  recoverRestartInterruptedTurns(
    input: RuntimeRestartRecoveryInput,
  ): Promise<RuntimeRestartRecoveryResult | undefined>;
  // -- durable delivery queue (WP3) --
  enqueue(sessionId: string, text: string, delivery: DeliveryMode, attachments?: AttachmentRef[]): Promise<QueueItemDto>;
  queueList(sessionId: string): Promise<QueueItemDto[]>;
  /** Updates only the queued text; delivery, attachments, position, and timestamps stay unchanged. */
  queueEdit(sessionId: string, queueId: string, text: string): Promise<QueueItemDto | undefined>;
  /** Validates ids are an exact permutation for the session; positions update transactionally. */
  queueReorder(sessionId: string, ids: string[]): Promise<QueueItemDto[]>;
  queueRemove(sessionId: string, queueId: string): Promise<boolean>;
  /** @deprecated Compatibility-only destructive pop. Runtime dispatch must
   * use reserveQueueHead/confirmQueueReservation/releaseQueueReservation. */
  queueShift(sessionId: string): Promise<QueueItemDto | undefined>;
  /** Reserve the FIFO head and create its prepared operation atomically. */
  reserveQueueHead(input: QueueReservationInput): Promise<QueueReservationResult>;
  queueReservation(operationId: string): Promise<QueueReservation | undefined>;
  /** Confirmed admission removes the row and records queue/dispatched in the
   * same transaction as the operation confirmation. */
  confirmQueueReservation(operationId: string, receipt?: string): Promise<QueueItemDto>;
  /** Only a proven rejection-before-admission or not-applied resolution can
   * clear a reservation for a future fresh operation. */
  releaseQueueReservation(
    operationId: string,
    settlement:
      | { kind: "rejected"; code: string; message: string }
      | { kind: "not-applied"; code?: string; message: string },
  ): Promise<QueueItemDto>;
  // -- attention response compare-and-set --
  chooseResponseIntent(input: ResponseIntentInput, replay?: ReplayPolicy): Promise<ResponseIntentChoice>;
  responseIntent(sessionId: string, kind: ResponseIntentInput["kind"], requestId: string): Promise<DurableResponseIntent | undefined>;
  settleResponseIntent(operationId: string, settlement: ResponseIntentSettlement): Promise<DurableOperation>;
  // -- atomic observation ingestion --
  ingestObservation(input: ObservationIngestionInput): Promise<ObservationIngestionResult>;
  ingestSnapshot(input: SnapshotIngestionInput): Promise<SnapshotIngestionResult>;
  observationCheckpoint(key: ObservationEntityKey): Promise<ObservationCheckpoint | undefined>;
  observationCursor(key: ObservationCursorKey): Promise<string | undefined>;
  // -- durable admission barrier --
  startReconciliation(sessionId: string): Promise<DurableReconciliation>;
  reconciliation(sessionId: string): Promise<DurableReconciliation | undefined>;
  settleReconciliation(
    sessionId: string,
    ordinal: number,
    state: "ready" | "blocked" | "unknown",
    reason?: string,
  ): Promise<
    | { kind: "accepted"; reconciliation: DurableReconciliation }
    | { kind: "superseded"; reconciliation: DurableReconciliation }
  >;
  // -- deletion negative state, stored outside session-scoped rows --
  prepareSessionDeletion(input: PrepareDeletionTombstoneInput): Promise<PreparedDeletionTombstoneResult>;
  deletionTombstone(canonicalSessionId: string): Promise<DeletionTombstone | undefined>;
  hasDeletionTombstone(binding: DeletionTombstoneBinding): Promise<boolean>;
  retireDeletionTombstone(
    canonicalSessionId: string,
    retirement: { kind: "confirmed" } | { kind: "purged"; policy: string },
  ): Promise<DeletionTombstone>;
  /** Hard delete: events + projection + queued messages, one transaction. */
  deleteSession(sessionId: string): Promise<void>;
  deleteProjection(sessionId: string): Promise<void>;
  // -- organization: folders + labels (WP5) --
  folderList(projectId: string): Promise<SessionFolderDto[]>;
  /** Owning project of a folder — the tenancy guard's join point for folder
   *  ids, which carry no Space of their own. */
  folderProject(id: string): string | undefined;
  folderCreate(projectId: string, name: string, parentId?: string): Promise<SessionFolderDto>;
  /** Stale expectedRevision → conflict; parent move validates same-project + acyclic. */
  folderUpdate(id: string, patch: { name?: string; parentId?: string | null; position?: number }, expectedRevision: number): Promise<SessionFolderDto>;
  /** Children reparent to the removed folder's parent. Returns false when absent. */
  folderRemove(id: string): Promise<boolean>;
  /** `spaceId` scopes the listing to one tenant; callers holding a
   *  SpaceContext must always pass it. */
  labelList(spaceId?: string): Promise<WorkspaceLabel[]>;
  labelCreate(name: string, color: string, spaceId?: string): Promise<WorkspaceLabel>;
  labelUpdate(id: string, patch: { name?: string; color?: string; position?: number }, expectedRevision: number, spaceId?: string): Promise<WorkspaceLabel>;
  labelRemove(id: string, spaceId?: string): Promise<boolean>;
  // -- derived counters + search (WP5) --
  attentionFor(sessionIds: string[]): Promise<Record<string, AttentionCounts>>;
  /** Advance the user's read cursor (highest event seq actually seen).
   *  Returns whether the cursor moved; unread bold derives from it. */
  setReadCursor(sessionId: string, seq: number): Promise<boolean>;
  /** Bounded LIKE search over message text; snippets are trimmed around the hit. */
  searchEventText(q: string, limit?: number): Promise<SearchHit[]>;
  /** Newest eligible `user/message` composer payloads in one Space, oldest-first. */
  listPromptHistory(opts: {
    spaceId: string;
    sessionId?: string;
    limit: number;
  }): Promise<PromptHistoryEntryDto[]>;
  // -- server-owned agent profiles (WP8) --
  profileList(): Promise<AgentProfile[]>;
  profileGet(id: string): Promise<AgentProfile | undefined>;
  profileCreate(input: Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">): Promise<AgentProfile>;
  /** Stale expectedRevision → conflict. providerID/modelID stay immutable per profile. */
  profileUpdate(id: string, patch: Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">>, expectedRevision: number): Promise<AgentProfile>;
  profileRemove(id: string): Promise<boolean>;
}

export type RuntimeMutationStore = Pick<
  Store,
  "prepareOperation" | "operations" | "claimOperation" | "settleOperation"
>;

export interface ExecuteDurableRuntimeMutationInput<T> {
  store: RuntimeMutationStore;
  sessionId: string;
  mutationKind: RuntimeMutationKind;
  intentEvent: CanonicalEventInput;
  call(operationId: string): Promise<MutationOutcome<T>>;
  receipt?(value: T): string | undefined;
  recoverConfirmed?(operation: DurableOperation): T | undefined;
}

/**
 * Durable prepare/claim/settle for non-canonical background runtime work.
 * A stable synthetic session id lets a retried worker observe the original
 * unknown operation instead of issuing the mutation again.
 */
const executeDurableRuntimeMutationCore = async <T,>(
  input: ExecuteDurableRuntimeMutationInput<T>,
): Promise<MutationOutcome<T>> => {
  const matches = (await input.store.operations(input.sessionId))
    .filter((operation) => operation.mutationKind === input.mutationKind);
  if (matches.length > 1) {
    return {
      kind: "rejected",
      code: "durable-operation-conflict",
      message: `multiple ${input.mutationKind} operations exist for ${input.sessionId}`,
    };
  }

  let operation = matches[0];
  if (!operation) {
    operation = (await input.store.prepareOperation({
      sessionId: input.sessionId,
      mutationKind: input.mutationKind,
      intentEvent: input.intentEvent,
    })).operation;
  }

  if (operation.state === "confirmed") {
    const recovered = input.recoverConfirmed?.(operation);
    return recovered === undefined
      ? {
          kind: "rejected",
          code: "already-confirmed",
          message: `${input.mutationKind} was already confirmed`,
        }
      : {
          kind: "confirmed",
          value: recovered,
          ...(operation.receipt ? { receipt: operation.receipt } : {}),
        };
  }
  if (operation.state === "unknown" || operation.state === "executing") {
    return {
      kind: "unknown",
      operationId: operation.operationId,
      message: operation.message
        ?? `${input.mutationKind} is already ${operation.state}; it will not be replayed`,
    };
  }
  if (operation.state === "rejected" || operation.state === "not-applied") {
    return {
      kind: "rejected",
      code: operation.code ?? operation.state,
      message: operation.message ?? `${input.mutationKind} is ${operation.state}`,
    };
  }

  const claim = await input.store.claimOperation(operation.operationId);
  if (claim.kind !== "claimed") {
    const current = claim.operation;
    return {
      kind: "unknown",
      operationId: operation.operationId,
      message: current?.message
        ?? `${input.mutationKind} is owned by another executor`,
    };
  }

  let outcome: MutationOutcome<T>;
  try {
    outcome = await input.call(operation.operationId);
  } catch (error) {
    outcome = {
      kind: "unknown",
      operationId: operation.operationId,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (outcome.kind === "confirmed") {
    const receipt = outcome.receipt ?? input.receipt?.(outcome.value);
    await input.store.settleOperation(operation.operationId, {
      kind: "confirmed",
      ...(receipt ? { receipt } : {}),
    });
  } else if (outcome.kind === "rejected") {
    await input.store.settleOperation(operation.operationId, {
      kind: "rejected",
      code: outcome.code,
      message: outcome.message,
    });
  } else {
    await input.store.settleOperation(operation.operationId, {
      kind: "unknown",
      message: outcome.message,
    });
    outcome = { ...outcome, operationId: operation.operationId };
  }
  return outcome;
};

const runtimeMutationTails = new WeakMap<
  RuntimeMutationStore,
  Map<string, Promise<void>>
>();

export async function executeDurableRuntimeMutation<T>(
  input: ExecuteDurableRuntimeMutationInput<T>,
): Promise<MutationOutcome<T>> {
  let tails = runtimeMutationTails.get(input.store);
  if (!tails) {
    tails = new Map();
    runtimeMutationTails.set(input.store, tails);
  }
  const key = `${input.sessionId}\0${input.mutationKind}`;
  const prior = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = prior.catch(() => {}).then(() => gate);
  tails.set(key, current);
  await prior.catch(() => {});
  try {
    return await executeDurableRuntimeMutationCore(input);
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
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
  const raw = new DatabaseSync(dbPath);
  // Closed-store fence: teardown may begin while a service operation is still
  // inside itself. Getting a live service reference does not cancel that work,
  // so every sqlite boundary must refuse after close() rather than touch a
  // disposed DatabaseSync.
  let closed = false;
  const assertOpen = (): void => {
    if (closed) {
      throw Object.assign(new Error("session store is closed"), { code: "unavailable" });
    }
  };
  const sqlitePrepare = (sql: string): StatementSync => {
    assertOpen();
    return raw.prepare(sql);
  };
  const sqliteExec = (sql: string): void => {
    assertOpen();
    raw.exec(sql);
  };
  sqliteExec("PRAGMA journal_mode = WAL");
  sqliteExec("PRAGMA synchronous = NORMAL");
  sqliteExec(`
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
  sqliteExec(`
    CREATE TABLE IF NOT EXISTS projections (
      session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);

  // Forward-only, transactional schema migrations. Reopening an old DB runs
  // only the missing steps; reopening a new DB is a no-op.
  sqliteExec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const getVersion = (): number => {
    const row = sqlitePrepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  };
  const setVersion = (v: number): void => {
    sqlitePrepare(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(v));
  };
  const MIGRATIONS: Array<() => void> = [
    // v1: durable per-session delivery queue (WP3)
    () => {
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS session_queue (
          queue_id   TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          position   INTEGER NOT NULL,
          text       TEXT NOT NULL,
          delivery   TEXT NOT NULL DEFAULT 'queue',
          created_at INTEGER NOT NULL
        )
      `);
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_queue_session ON session_queue (session_id, position)");
    },
    // v2: session folders + workspace labels (WP5)
    () => {
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS folders (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_id  TEXT,
          name       TEXT NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          revision   INTEGER NOT NULL DEFAULT 1
        )
      `);
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_folders_project ON folders (project_id, position)");
      sqliteExec(`
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
      sqliteExec(`
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
      sqliteExec("ALTER TABLE session_queue ADD COLUMN attachments TEXT");
    },
    // v5: index for the message-search read path (searchEventText filters on
    // type and orders by time; the primary key only covers session_id+seq)
    () => {
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_events_type_time ON events (type, time)");
    },
    // v6: instant-load read paths — project-scoped projection listing via an
    // indexed generated column, indexed per-session type lookups, and
    // append-maintained open-attention counters replacing full log scans.
    () => {
      sqliteExec(
        "ALTER TABLE projections ADD COLUMN project_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.projectId')) VIRTUAL",
      );
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_projections_project ON projections (project_id)");
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_events_session_type ON events (session_id, type)");
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS attention_open (
          session_id TEXT NOT NULL,
          kind       TEXT NOT NULL,
          request_id TEXT NOT NULL,
          PRIMARY KEY (session_id, kind, request_id)
        )
      `);
      // Backfill from the durable log so counters on old databases stay honest.
      sqliteExec(`
        INSERT OR IGNORE INTO attention_open (session_id, kind, request_id)
        SELECT e.session_id,
               CASE WHEN e.type = 'permission/requested' THEN 'permission' ELSE 'question' END,
               json_extract(e.data, '$.requestId')
        FROM events e
        WHERE e.type IN ('permission/requested','question/asked')
          AND json_extract(e.data, '$.requestId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM events r
            WHERE r.session_id = e.session_id
              AND r.type = CASE WHEN e.type = 'permission/requested' THEN 'permission/resolved' ELSE 'question/answered' END
              AND json_extract(r.data, '$.requestId') = json_extract(e.data, '$.requestId')
          )
      `);
    },
    // v7: OpenCode reliability hardening. Operation state is authoritative;
    // queue leases, semantic observation identity, response CAS, restart
    // barriers, and deletion negative state are durable across process restart.
    () => {
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS runtime_operations (
          operation_id    TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL,
          ordinal         INTEGER NOT NULL,
          mutation_kind   TEXT NOT NULL,
          state           TEXT NOT NULL CHECK (
            state IN ('prepared','executing','confirmed','rejected','unknown','not-applied')
          ),
          replay_kind     TEXT NOT NULL CHECK (replay_kind IN ('never','same-operation-id')),
          replay_contract TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          code            TEXT,
          message         TEXT,
          receipt         TEXT,
          owner_event_seq INTEGER,
          UNIQUE (session_id, ordinal)
        )
      `);
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_runtime_operations_session ON runtime_operations (session_id, ordinal)");
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_runtime_operations_state ON runtime_operations (state)");

      sqliteExec("ALTER TABLE session_queue ADD COLUMN reservation_operation_id TEXT");
      sqliteExec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_reservation_operation ON session_queue (reservation_operation_id) WHERE reservation_operation_id IS NOT NULL",
      );

      sqliteExec(`
        CREATE TABLE IF NOT EXISTS response_intents (
          session_id   TEXT NOT NULL,
          kind         TEXT NOT NULL CHECK (kind IN ('permission','question','secret')),
          request_id   TEXT NOT NULL,
          operation_id TEXT NOT NULL UNIQUE,
          payload      TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (session_id, kind, request_id)
        )
      `);

      sqliteExec(`
        CREATE TABLE IF NOT EXISTS observations (
          authority_id          TEXT NOT NULL,
          directory             TEXT NOT NULL,
          workspace             TEXT NOT NULL,
          backend_session_id    TEXT NOT NULL,
          artifact_kind         TEXT NOT NULL,
          entity_id             TEXT NOT NULL,
          revision              TEXT NOT NULL,
          session_id            TEXT NOT NULL,
          observed_generation   INTEGER NOT NULL,
          reconciliation_ordinal INTEGER NOT NULL,
          canonical_seqs        TEXT NOT NULL,
          observed_at           INTEGER NOT NULL,
          PRIMARY KEY (
            authority_id, directory, workspace, backend_session_id,
            artifact_kind, entity_id, revision
          )
        )
      `);
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_observations_session ON observations (session_id)");
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS observation_checkpoints (
          authority_id       TEXT NOT NULL,
          directory          TEXT NOT NULL,
          workspace          TEXT NOT NULL,
          backend_session_id TEXT NOT NULL,
          artifact_kind      TEXT NOT NULL,
          entity_id          TEXT NOT NULL,
          revision           TEXT NOT NULL,
          state_rank         INTEGER,
          value              TEXT NOT NULL,
          updated_at         INTEGER NOT NULL,
          PRIMARY KEY (
            authority_id, directory, workspace, backend_session_id,
            artifact_kind, entity_id
          )
        )
      `);
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS observation_cursors (
          authority_id       TEXT NOT NULL,
          directory          TEXT NOT NULL,
          workspace          TEXT NOT NULL,
          backend_session_id TEXT NOT NULL,
          channel            TEXT NOT NULL,
          cursor_after       TEXT NOT NULL,
          updated_at         INTEGER NOT NULL,
          PRIMARY KEY (authority_id, directory, workspace, backend_session_id, channel)
        )
      `);

      sqliteExec(`
        CREATE TABLE IF NOT EXISTS session_reconciliations (
          session_id TEXT PRIMARY KEY,
          ordinal    INTEGER NOT NULL,
          state      TEXT NOT NULL CHECK (state IN ('reconciling','ready','blocked','unknown')),
          reason     TEXT,
          updated_at INTEGER NOT NULL
        )
      `);

      sqliteExec(`
        CREATE TABLE IF NOT EXISTS deletion_tombstones (
          canonical_session_id TEXT PRIMARY KEY,
          authority_id         TEXT NOT NULL,
          endpoint_generation  INTEGER NOT NULL,
          directory            TEXT NOT NULL,
          workspace            TEXT NOT NULL,
          backend_session_id   TEXT NOT NULL,
          operation_id         TEXT NOT NULL UNIQUE,
          created_at           INTEGER NOT NULL,
          retired_at           INTEGER,
          retirement_kind      TEXT CHECK (retirement_kind IN ('confirmed','purged')),
          retirement_policy    TEXT
        )
      `);
      sqliteExec(
        `CREATE INDEX IF NOT EXISTS idx_deletion_tombstone_binding
         ON deletion_tombstones (
           authority_id, directory, workspace, backend_session_id, retired_at
         )`,
      );
    },
    // v8: runtime epochs. Fenced is a terminal unknown-outcome disposition,
    // and queue admissions fenced by an epoch become durable held drafts.
    () => {
      sqliteExec(`
        CREATE TABLE runtime_operations_v8 (
          operation_id    TEXT PRIMARY KEY,
          session_id      TEXT NOT NULL,
          ordinal         INTEGER NOT NULL,
          mutation_kind   TEXT NOT NULL,
          state           TEXT NOT NULL CHECK (
            state IN ('prepared','executing','confirmed','rejected','unknown','not-applied','fenced')
          ),
          replay_kind     TEXT NOT NULL CHECK (replay_kind IN ('never','same-operation-id')),
          replay_contract TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          code            TEXT,
          message         TEXT,
          receipt         TEXT,
          owner_event_seq INTEGER,
          UNIQUE (session_id, ordinal)
        );
        INSERT INTO runtime_operations_v8
          SELECT * FROM runtime_operations;
        DROP TABLE runtime_operations;
        ALTER TABLE runtime_operations_v8 RENAME TO runtime_operations;
        CREATE INDEX idx_runtime_operations_session
          ON runtime_operations (session_id, ordinal);
        CREATE INDEX idx_runtime_operations_state
          ON runtime_operations (state);
        ALTER TABLE session_queue
          ADD COLUMN held_for_review INTEGER NOT NULL DEFAULT 0
          CHECK (held_for_review IN (0, 1));
      `);
    },
    // v9: per-session read cursors. The cursor is the highest event seq the
    // user has actually seen; navigator unread bold counts assistant messages
    // past it. Sessions without a cursor (legacy, never opened since the
    // feature shipped) count as read — bold only appears for messages that
    // arrived after the user last looked.
    () => {
      sqliteExec(`
        CREATE TABLE IF NOT EXISTS session_read (
          session_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL
        )
      `);
    },
    // v10: Spaces. Sessions are tenant-owned; listing and event fan-out filter
    // on the owning Space, so it is a generated column (like project_id)
    // rather than a join through the project registry on every read. Rows
    // written before tenancy have no spaceId — the server's boot migration
    // adopts them into the default Space via adoptSessionsIntoSpace().
    () => {
      sqliteExec(
        "ALTER TABLE projections ADD COLUMN space_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.spaceId')) VIRTUAL",
      );
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_projections_space ON projections (space_id)");
      sqliteExec(
        "CREATE INDEX IF NOT EXISTS idx_projections_space_project ON projections (space_id, project_id)",
      );
    },
    // v11: workspace labels are Space-owned. Folders already scope through
    // their project; labels were global, so their NAMES were visible to every
    // tenant. Rows written before tenancy are adopted by the boot migration.
    () => {
      sqliteExec("ALTER TABLE labels ADD COLUMN space_id TEXT");
      sqliteExec("CREATE INDEX IF NOT EXISTS idx_labels_space ON labels (space_id, position)");
    },
    // v12: authoritative profile routes are harness-qualified. Existing rows
    // remain NULL because their origin cannot be proven from provider/model
    // strings alone; new exact profiles always write a harness id.
    () => {
      sqliteExec("ALTER TABLE agent_profiles ADD COLUMN harness_id TEXT");
    },
  ];
  for (let v = getVersion(); v < MIGRATIONS.length; v++) {
    transaction(() => {
      MIGRATIONS[v]!();
      setVersion(v + 1);
    });
  }

  // Prepared-statement cache for the fixed queries below (compiled once, then
  // reused). Created only after migrations so no statement predates an ALTER.
  // Queries with a variable placeholder count (attentionFor) stay uncached.
  const stmts = new Map<string, StatementSync>();
  const prep = (sql: string): StatementSync => {
    assertOpen();
    let s = stmts.get(sql);
    if (!s) { s = sqlitePrepare(sql); stmts.set(sql, s); }
    return s;
  };

  // ------------------------------------------------------------- attention bookkeeping

  // attention_open mirrors unresolved permission/question requests so list
  // views never scan whole event logs. Rows are maintained inside the same
  // transaction as every event write (append/copy/child-snapshot/delete).
  const ATTENTION_OPS: Record<string, { kind: "permission" | "question"; op: "open" | "close" }> = {
    "permission/requested": { kind: "permission", op: "open" },
    "permission/resolved": { kind: "permission", op: "close" },
    "permission/expired": { kind: "permission", op: "close" },
    "question/asked": { kind: "question", op: "open" },
    "question/answered": { kind: "question", op: "close" },
    "question/expired": { kind: "question", op: "close" },
  };

  function applyAttention(sessionId: string, type: string, data: JsonObject): void {
    const spec = ATTENTION_OPS[type];
    if (!spec) return;
    const requestId = (data as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || !requestId) return;
    if (spec.op === "open") {
      prep("INSERT OR IGNORE INTO attention_open (session_id, kind, request_id) VALUES (?, ?, ?)")
        .run(sessionId, spec.kind, requestId);
    } else {
      prep("DELETE FROM attention_open WHERE session_id = ? AND kind = ? AND request_id = ?")
        .run(sessionId, spec.kind, requestId);
    }
  }

  /** Raw-row variant: parses data only for attention event types. */
  function applyAttentionRaw(sessionId: string, type: string, dataRaw: string): void {
    if (!ATTENTION_OPS[type]) return;
    try {
      applyAttention(sessionId, type, JSON.parse(dataRaw) as JsonObject);
    } catch {
      // Malformed payloads never break a copy transaction.
    }
  }

  // ------------------------------------------------------------- transaction helpers

  function transaction<T>(run: () => SyncOnly<T>): SyncOnly<T> {
    assertOpen();
    return withImmediateTransaction((sql) => sqliteExec(sql), run);
  }

  function appendInTransaction(
    sessionId: string,
    type: string,
    data: JsonObject,
    opts: Partial<
      Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
    > = {},
  ): SessionEvent {
    const row = prep("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?")
      .get(sessionId) as { next: number };
    const event: SessionEvent = {
      id: randomUUID(),
      sessionId,
      seq: Number(row.next),
      time: Date.now(),
      type,
      data,
      ...(opts.ignorable ? { ignorable: true } : {}),
      ...(opts.surfaceOp ? { surfaceOp: opts.surfaceOp } : {}),
      ...(opts.sourceEventSeqs ? { sourceEventSeqs: opts.sourceEventSeqs } : {}),
      ...(opts.producerPlugin ? { producerPlugin: opts.producerPlugin } : {}),
      v: 1,
    };
    prep(
      `INSERT INTO events (session_id, seq, id, time, type, data, ignorable, surface_op, source_seqs, producer, v)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      sessionId,
      event.seq,
      event.id,
      event.time,
      type,
      JSON.stringify(data),
      opts.ignorable ? 1 : 0,
      opts.surfaceOp ?? null,
      opts.sourceEventSeqs ? JSON.stringify(opts.sourceEventSeqs) : null,
      opts.producerPlugin ?? null,
    );
    applyAttention(sessionId, type, data);
    return event;
  }

  function appendInputInTransaction(sessionId: string, event: CanonicalEventInput): SessionEvent {
    return appendInTransaction(sessionId, event.type, event.data, {
      ignorable: event.ignorable,
      surfaceOp: event.surfaceOp,
      sourceEventSeqs: event.sourceEventSeqs,
      producerPlugin: event.producerPlugin,
    });
  }

  // ------------------------------------------------------------- durable operations

  interface OperationRow {
    operation_id: string;
    session_id: string;
    ordinal: number;
    mutation_kind: string;
    state: string;
    replay_kind: string;
    replay_contract: string | null;
    created_at: number;
    updated_at: number;
    code: string | null;
    message: string | null;
    receipt: string | null;
    owner_event_seq: number | null;
  }

  const rowToOperation = (row: OperationRow): DurableOperation => ({
    operationId: row.operation_id,
    sessionId: row.session_id,
    ordinal: Number(row.ordinal),
    mutationKind: row.mutation_kind as RuntimeMutationKind,
    state: row.state as DurableOperation["state"],
    replay: row.replay_kind === "same-operation-id"
      ? { kind: "same-operation-id", contract: row.replay_contract ?? "" }
      : { kind: "never" },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.code !== null ? { code: row.code } : {}),
    ...(row.message !== null ? { message: row.message } : {}),
    ...(row.receipt !== null ? { receipt: row.receipt } : {}),
    ...(row.owner_event_seq !== null ? { ownerEventSeq: Number(row.owner_event_seq) } : {}),
  });

  const operationRow = (operationId: string): OperationRow | undefined =>
    prep("SELECT * FROM runtime_operations WHERE operation_id = ?")
      .get(operationId) as unknown as OperationRow | undefined;

  function assertReplayPolicy(replay: ReplayPolicy): void {
    if (replay.kind === "same-operation-id" && replay.contract.trim() === "") {
      throw Object.assign(new Error("same-operation-id replay requires a pinned contract"), {
        code: "invalid-input",
      });
    }
  }

  function insertPreparedOperation(
    sessionId: string,
    mutationKind: RuntimeMutationKind,
    replay: ReplayPolicy = { kind: "never" },
  ): DurableOperation {
    assertReplayPolicy(replay);
    const next = prep(
      "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM runtime_operations WHERE session_id = ?",
    ).get(sessionId) as { next: number };
    const operationId = randomUUID();
    const now = Date.now();
    prep(
      `INSERT INTO runtime_operations (
         operation_id, session_id, ordinal, mutation_kind, state,
         replay_kind, replay_contract, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?)`,
    ).run(
      operationId,
      sessionId,
      Number(next.next),
      mutationKind,
      replay.kind,
      replay.kind === "same-operation-id" ? replay.contract : null,
      now,
      now,
    );
    return rowToOperation(operationRow(operationId)!);
  }

  const mutationStateData = (
    operation: DurableOperation,
    extra: { code?: string; message?: string } = {},
  ): JsonObject => ({
    operationId: operation.operationId,
    ordinal: operation.ordinal,
    mutationKind: operation.mutationKind,
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.message ? { message: extra.message } : {}),
  });

  function appendMutationState(
    operation: DurableOperation,
    type:
      | "mutation/prepared"
      | "mutation/claimed"
      | "mutation/confirmed"
      | "mutation/rejected"
      | "mutation/uncertainty-recorded"
      | "mutation/nonapplication-confirmed"
      | "mutation/fenced",
    extra: { code?: string; message?: string } = {},
  ): SessionEvent | undefined {
    const tombstoned = prep(
      `SELECT 1 AS one FROM deletion_tombstones
       WHERE canonical_session_id = ? AND retired_at IS NULL`,
    ).get(operation.sessionId);
    if (tombstoned) return undefined;
    return appendInTransaction(
      operation.sessionId,
      type,
      mutationStateData(operation, extra),
      { ignorable: true },
    );
  }

  async function prepareOperation(input: PrepareOperationInput): Promise<PreparedOperationResult> {
    return transaction(() => {
      const operation = insertPreparedOperation(
        input.sessionId,
        input.mutationKind,
        input.replay ?? { kind: "never" },
      );
      const intentEvent = appendInputInTransaction(input.sessionId, input.intentEvent);
      prep("UPDATE runtime_operations SET owner_event_seq = ? WHERE operation_id = ?")
        .run(intentEvent.seq, operation.operationId);
      const updated = rowToOperation(operationRow(operation.operationId)!);
      const stateEvent = appendMutationState(updated, "mutation/prepared");
      if (!stateEvent) {
        throw Object.assign(new Error("session is deletion-tombstoned"), {
          code: "tombstoned",
        });
      }
      return { operation: updated, intentEvent, stateEvent };
    });
  }

  async function prepareSessionCreate(
    input: PrepareSessionCreateInput,
  ): Promise<PreparedSessionCreateResult> {
    if (input.createdEvent.type !== "session/created") {
      throw Object.assign(
        new Error("prepared session create requires a session/created owner event"),
        { code: "invalid-input" },
      );
    }
    return transaction(() => {
      const sessionId = input.projection.id;
      if (prep("SELECT 1 AS one FROM projections WHERE session_id = ?").get(sessionId)) {
        throw Object.assign(new Error("session already exists"), { code: "conflict" });
      }
      const operation = insertPreparedOperation(
        sessionId,
        "session-create",
        input.replay ?? { kind: "never" },
      );
      prep("INSERT INTO projections (session_id, data) VALUES (?, ?)")
        .run(sessionId, JSON.stringify(input.projection));
      const createdEvent = appendInputInTransaction(sessionId, input.createdEvent);
      prep("UPDATE runtime_operations SET owner_event_seq = ? WHERE operation_id = ?")
        .run(createdEvent.seq, operation.operationId);
      const updated = rowToOperation(operationRow(operation.operationId)!);
      const stateEvent = appendMutationState(updated, "mutation/prepared");
      if (!stateEvent) {
        throw Object.assign(new Error("session is deletion-tombstoned"), {
          code: "tombstoned",
        });
      }
      return {
        operation: updated,
        createdEvent,
        stateEvent,
        projection: input.projection,
      };
    });
  }

  function operation(operationId: string): Promise<DurableOperation | undefined> {
    const row = operationRow(operationId);
    return Promise.resolve(row ? rowToOperation(row) : undefined);
  }

  function operations(sessionId: string): Promise<DurableOperation[]> {
    const rows = prep(
      "SELECT * FROM runtime_operations WHERE session_id = ? ORDER BY ordinal",
    ).all(sessionId) as unknown as OperationRow[];
    return Promise.resolve(rows.map(rowToOperation));
  }

  async function claimOperation(operationId: string): Promise<OperationClaimResult> {
    return transaction(() => {
      const before = operationRow(operationId);
      if (!before || before.state !== "prepared") {
        return {
          kind: "not-claimed",
          ...(before ? { operation: rowToOperation(before) } : {}),
        };
      }
      const now = Date.now();
      const changed = prep(
        `UPDATE runtime_operations SET state = 'executing', updated_at = ?
         WHERE operation_id = ? AND state = 'prepared'`,
      ).run(now, operationId);
      if (Number(changed.changes) !== 1) {
        const current = operationRow(operationId);
        return {
          kind: "not-claimed",
          ...(current ? { operation: rowToOperation(current) } : {}),
        };
      }
      const claimed = rowToOperation(operationRow(operationId)!);
      return {
        kind: "claimed",
        operation: claimed,
        event: appendMutationState(claimed, "mutation/claimed"),
      };
    });
  }

  async function replayUnknownOperation(
    operationId: string,
    contract: string,
  ): Promise<OperationClaimResult> {
    return transaction(() => {
      const before = operationRow(operationId);
      if (
        !before
        || before.state !== "unknown"
        || before.replay_kind !== "same-operation-id"
        || before.replay_contract !== contract
      ) {
        return {
          kind: "not-claimed",
          ...(before ? { operation: rowToOperation(before) } : {}),
        };
      }
      const changed = prep(
        `UPDATE runtime_operations SET state = 'executing', updated_at = ?
         WHERE operation_id = ? AND state = 'unknown'
           AND replay_kind = 'same-operation-id' AND replay_contract = ?`,
      ).run(Date.now(), operationId, contract);
      if (Number(changed.changes) !== 1) {
        const current = operationRow(operationId);
        return {
          kind: "not-claimed",
          ...(current ? { operation: rowToOperation(current) } : {}),
        };
      }
      const claimed = rowToOperation(operationRow(operationId)!);
      return {
        kind: "claimed",
        operation: claimed,
        event: appendMutationState(claimed, "mutation/claimed"),
      };
    });
  }

  function transitionOperation(
    operationId: string,
    settlement: OperationSettlement,
  ): { operation: DurableOperation; event?: SessionEvent } {
    const before = operationRow(operationId);
    if (!before) throw Object.assign(new Error("operation not found"), { code: "not-found" });
    const allowed =
      (settlement.kind === "confirmed" && ["executing", "unknown"].includes(before.state))
      || (settlement.kind === "rejected" && ["prepared", "executing"].includes(before.state))
      || (settlement.kind === "unknown" && before.state === "executing")
      || (settlement.kind === "not-applied" && before.state === "unknown");
    if (!allowed) {
      throw Object.assign(
        new Error(`invalid operation transition ${before.state} -> ${settlement.kind}`),
        { code: "invalid-transition" },
      );
    }
    const code = "code" in settlement ? settlement.code ?? null : null;
    const message = "message" in settlement ? settlement.message : null;
    const receipt = settlement.kind === "confirmed" ? settlement.receipt ?? null : null;
    prep(
      `UPDATE runtime_operations
       SET state = ?, updated_at = ?, code = ?, message = ?, receipt = ?
       WHERE operation_id = ?`,
    ).run(settlement.kind, Date.now(), code, message, receipt, operationId);
    const updated = rowToOperation(operationRow(operationId)!);
    const type = settlement.kind === "confirmed"
      ? "mutation/confirmed"
      : settlement.kind === "rejected"
        ? "mutation/rejected"
        : settlement.kind === "unknown"
          ? "mutation/uncertainty-recorded"
          : "mutation/nonapplication-confirmed";
    return {
      operation: updated,
      event: appendMutationState(updated, type, {
        ...(code ? { code } : {}),
        ...(message ? { message } : {}),
      }),
    };
  }

  async function settleOperation(
    operationId: string,
    settlement: OperationSettlement,
  ): Promise<DurableOperation> {
    return transaction(() => {
      if (settlement.kind !== "unknown") {
        const queued = prep(
          "SELECT 1 AS one FROM session_queue WHERE reservation_operation_id = ?",
        ).get(operationId);
        if (queued) {
          throw Object.assign(
            new Error("settle queue reservations with confirmQueueReservation or releaseQueueReservation"),
            { code: "specialized-settlement-required" },
          );
        }
        const response = prep(
          "SELECT 1 AS one FROM response_intents WHERE operation_id = ?",
        ).get(operationId);
        if (response) {
          throw Object.assign(
            new Error("settle response intents with settleResponseIntent"),
            { code: "specialized-settlement-required" },
          );
        }
      }
      return transitionOperation(operationId, settlement).operation;
    });
  }

  const bindingEpoch = (binding: PersistedRuntimeBinding): number => binding.epoch ?? 0;

  const priorEpochEvents = (sessionId: string): SessionEvent[] =>
    (prep("SELECT * FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as unknown as Row[]).map(rowToEvent);

  const appendEpochRequestExpirations = (
    sessionId: string,
    epoch: number,
    events: readonly SessionEvent[],
  ): SessionEvent[] => {
    const open = new Map<string, { requestId: string; type: "permission/expired" | "question/expired" | "secret/expired" }>();
    for (const event of events) {
      const requestId = (event.data as { requestId?: unknown }).requestId;
      if (typeof requestId !== "string" || !requestId) continue;
      if (event.type === "permission/requested") {
        open.set(`permission:${requestId}`, { requestId, type: "permission/expired" });
      } else if (event.type === "question/asked") {
        open.set(`question:${requestId}`, { requestId, type: "question/expired" });
      } else if (event.type === "secret/requested") {
        open.set(`secret:${requestId}`, { requestId, type: "secret/expired" });
      } else if (event.type === "permission/resolved" || event.type === "permission/expired") {
        open.delete(`permission:${requestId}`);
      } else if (event.type === "question/answered" || event.type === "question/expired") {
        open.delete(`question:${requestId}`);
      } else if (event.type === "secret/resolved" || event.type === "secret/expired") {
        open.delete(`secret:${requestId}`);
      }
    }
    return [...open.values()].map(({ requestId, type }) =>
      appendInTransaction(sessionId, type, {
        requestId,
        epoch,
        reason: "runtime-epoch-replaced",
      }, { ignorable: true }));
  };

  const nextSnapshotRevision = (
    events: readonly SessionEvent[],
    type: "task/snapshot" | "subagent/snapshot",
  ): number => {
    let revision = 0;
    for (const event of events) {
      if (event.type !== type) continue;
      const value = Number((event.data as { revision?: unknown }).revision);
      if (Number.isSafeInteger(value) && value >= 0) revision = Math.max(revision, value);
    }
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new Error(`${type} revision is exhausted`), { code: "integrity-error" });
    }
    return revision + 1;
  };

  const appendEpochStateSnapshots = (
    sessionId: string,
    events: readonly SessionEvent[],
  ): SessionEvent[] => {
    const appended: SessionEvent[] = [];
    const task = events.findLast((event) => event.type === "task/snapshot");
    if (task) {
      const data = task.data as { listId?: unknown; items?: unknown };
      appended.push(appendInTransaction(sessionId, "task/snapshot", {
        listId: typeof data.listId === "string" ? data.listId : "todo",
        revision: nextSnapshotRevision(events, "task/snapshot"),
        items: Array.isArray(data.items) ? data.items as JsonObject[] : [],
      }));
    }
    const subagents = events.findLast((event) => event.type === "subagent/snapshot");
    if (subagents) {
      const rawAgents = (subagents.data as { agents?: unknown }).agents;
      const terminal = new Set(["done", "completed", "failed", "cancelled", "canceled"]);
      const agents = Array.isArray(rawAgents)
        ? rawAgents.map((raw) => {
            const agent = raw && typeof raw === "object" && !Array.isArray(raw)
              ? raw as Record<string, unknown>
              : {};
            const status = typeof agent.status === "string" ? agent.status : "";
            return {
              sessionId: typeof agent.sessionId === "string" ? agent.sessionId : "",
              label: typeof agent.label === "string" ? agent.label : "",
              status: terminal.has(status.toLowerCase()) ? status : "unknown",
              ...(typeof agent.currentTask === "string" ? { currentTask: agent.currentTask } : {}),
            };
          })
        : [];
      appended.push(appendInTransaction(sessionId, "subagent/snapshot", {
        revision: nextSnapshotRevision(events, "subagent/snapshot"),
        agents,
      }));
    }
    return appended;
  };

  const samePersistedBinding = (
    left: PersistedRuntimeBinding,
    right: PersistedRuntimeBinding,
  ): boolean =>
    left.backendSessionId === right.backendSessionId
    && left.authorityId === right.authorityId
    && left.generation === right.generation
    && bindingEpoch(left) === bindingEpoch(right)
    && left.continuity === right.continuity
    && left.protocol === right.protocol
    && left.location.directory === right.location.directory
    && (left.location.workspace ?? "") === (right.location.workspace ?? "");

  async function transitionRuntimeEpoch(
    input: RuntimeEpochTransitionInput,
  ): Promise<RuntimeEpochTransitionResult> {
    return transaction(() => {
      const reason = input.reason.trim();
      if (!reason) {
        throw Object.assign(new Error("runtime epoch transition requires a reason"), {
          code: "invalid-input",
        });
      }
      const projectionRow = prep("SELECT data FROM projections WHERE session_id = ?")
        .get(input.sessionId) as { data: string } | undefined;
      if (!projectionRow) {
        throw Object.assign(new Error("session projection not found"), { code: "not-found" });
      }
      const projection = JSON.parse(projectionRow.data) as SessionProjection;
      const currentBinding = projection.runtimeBinding;
      if (
        !currentBinding
        || projection.backendSessionId !== currentBinding.backendSessionId
        || !samePersistedBinding(currentBinding, input.expectedBinding)
      ) {
        throw Object.assign(
          new Error("runtime epoch transition raced a binding change"),
          { code: "binding-mismatch" },
        );
      }
      const oldEpoch = bindingEpoch(currentBinding);
      const replacement = input.replacementBinding;
      const priorEvents = priorEpochEvents(input.sessionId);
      if (
        !Number.isSafeInteger(replacement.epoch)
        || replacement.epoch !== oldEpoch + 1
        || replacement.epoch <= 0
        || !replacement.backendSessionId
        || replacement.backendSessionId === currentBinding.backendSessionId
        || !replacement.authorityId
      ) {
        throw Object.assign(
          new Error("replacement binding must name a fresh backend session at the next epoch"),
          { code: "invalid-input" },
        );
      }
      const reset = operationRow(input.resetOperationId);
      if (
        !reset
        || reset.session_id !== input.sessionId
        || reset.mutation_kind !== "session-reset"
        || reset.state !== "confirmed"
        || reset.receipt !== replacement.backendSessionId
      ) {
        throw Object.assign(
          new Error("runtime epoch transition requires a confirmed session-reset receipt"),
          { code: "epoch-reset-unconfirmed" },
        );
      }
      if (
        input.fence
        && (
          input.fence.authorityId !== currentBinding.authorityId
          || input.fence.generation !== currentBinding.generation
          || (
            input.fence.mode !== "session-released"
            && replacement.authorityId === currentBinding.authorityId
          )
          || (
            input.fence.mode === "session-released"
            && input.fence.backendSessionId !== currentBinding.backendSessionId
          )
        )
      ) {
        throw Object.assign(
          new Error(input.fence.mode === "session-released"
            ? "runtime epoch fence does not name the released binding"
            : "runtime epoch fence does not name the destroyed binding"),
          { code: "epoch-proof-mismatch" },
        );
      }

      const marker = appendInTransaction(
        input.sessionId,
        "runtime/epoch-replaced",
        {
          old: {
            authorityId: currentBinding.authorityId,
            generation: currentBinding.generation,
            epoch: oldEpoch,
          },
          new: {
            authorityId: replacement.authorityId,
            generation: replacement.generation,
            epoch: replacement.epoch,
          },
          reason,
          resetOperationId: input.resetOperationId,
        },
        { ignorable: true },
      );

      const fencedOperations: DurableOperation[] = [];
      const heldQueueItems: QueueItemDto[] = [];
      // Prepared work never crossed the claim boundary, so the runtime could
      // not have observed it. Retire it on every epoch — owned or borrowed —
      // otherwise it blocks recovery or a later generic claim resends it.
      const neverAdmitted = prep(
        `SELECT * FROM runtime_operations
         WHERE session_id = ? AND state = 'prepared' AND ordinal < ?
         ORDER BY ordinal`,
      ).all(input.sessionId, reset.ordinal) as unknown as OperationRow[];
      for (const pending of neverAdmitted) {
        const changed = prep(
          `UPDATE runtime_operations
           SET state = 'rejected', updated_at = ?, code = ?, message = ?, receipt = NULL
           WHERE operation_id = ? AND state = 'prepared'`,
        ).run(
          Date.now(),
          "runtime-epoch-replaced-before-execution",
          "operation was never admitted before the runtime was replaced",
          pending.operation_id,
        );
        if (Number(changed.changes) !== 1) {
          throw Object.assign(new Error("prepared operation changed during epoch replacement"), {
            code: "conflict",
          });
        }
        const rejected = rowToOperation(operationRow(pending.operation_id)!);
        appendMutationState(rejected, "mutation/rejected", {
          code: "runtime-epoch-replaced-before-execution",
          ...(rejected.message ? { message: rejected.message } : {}),
        });
        if (input.fence && rejected.mutationKind === "turn-submit") {
          const held = holdEpochTurnForReview(rejected);
          if (held) heldQueueItems.push(held);
        }
      }
      // An in-flight claim is the same honesty class as a process crash:
      // the outcome is not durably recorded. Convert executing → unknown
      // before optional owned fencing so a late confirm cannot land on the
      // replacement binding.
      const interrupted = prep(
        `SELECT * FROM runtime_operations
         WHERE session_id = ? AND state = 'executing' AND ordinal < ?
         ORDER BY ordinal`,
      ).all(input.sessionId, reset.ordinal) as unknown as OperationRow[];
      for (const executing of interrupted) {
        const changed = prep(
          `UPDATE runtime_operations
           SET state = 'unknown', updated_at = ?, code = ?, message = ?, receipt = NULL
           WHERE operation_id = ? AND state = 'executing'`,
        ).run(
          Date.now(),
          "runtime-epoch-replaced",
          "execution was interrupted before its outcome was durably recorded; the runtime was replaced",
          executing.operation_id,
        );
        if (Number(changed.changes) !== 1) {
          throw Object.assign(new Error("executing operation changed during epoch replacement"), {
            code: "conflict",
          });
        }
        const recovered = rowToOperation(operationRow(executing.operation_id)!);
        appendMutationState(recovered, "mutation/uncertainty-recorded", {
          code: "runtime-epoch-replaced",
          ...(recovered.message ? { message: recovered.message } : {}),
        });
      }
      if (input.fence) {
        const unknowns = prep(
          `SELECT * FROM runtime_operations
           WHERE session_id = ? AND state = 'unknown' AND ordinal < ?
           ORDER BY ordinal`,
        ).all(input.sessionId, reset.ordinal) as unknown as OperationRow[];
        for (const unknown of unknowns) {
          const changed = prep(
            `UPDATE runtime_operations
             SET state = 'fenced', updated_at = ?, code = ?, message = ?, receipt = NULL
             WHERE operation_id = ? AND state = 'unknown'`,
          ).run(
            Date.now(),
            "runtime-epoch-replaced",
            "outcome unknown — runtime was replaced; the request was not re-sent",
            unknown.operation_id,
          );
          if (Number(changed.changes) !== 1) {
            throw Object.assign(new Error("unknown operation changed during epoch fencing"), {
              code: "conflict",
            });
          }
          const fenced = rowToOperation(operationRow(unknown.operation_id)!);
          fencedOperations.push(fenced);
          appendMutationState(fenced, "mutation/fenced", {
            code: "runtime-epoch-replaced",
            ...(fenced.message ? { message: fenced.message } : {}),
          });
          if (fenced.mutationKind === "turn-submit") {
            const held = holdEpochTurnForReview(fenced);
            if (held) heldQueueItems.push(held);
          }
        }
      }
      appendEpochRequestExpirations(input.sessionId, oldEpoch, priorEvents);
      appendEpochStateSnapshots(input.sessionId, priorEvents);

      if (input.harness && projection.harnessTransition?.id !== input.harness.transitionId) {
        throw Object.assign(new Error("harness switch intent changed"), { code: "conflict" });
      }
      if (input.harness) appendInTransaction(input.sessionId, "harness/switched", {
        transitionId: input.harness.transitionId,
        from: projection.resolvedHarnessId ?? "",
        to: input.harness.leg.harnessId,
        ...(projection.runtimeLeg ? { closedLeg: { ...projection.runtimeLeg, endedAt: Date.now() } } : {}),
        leg: { ...input.harness.leg },
      }, { ignorable: true });
      const nextProjection: SessionProjection = {
        ...projection,
        ...(input.harness ? {
          harness: input.harness.selection,
          resolvedHarnessId: input.harness.leg.harnessId,
          runtimeLeg: input.harness.leg,
          harnessTransition: undefined,
          model: undefined,
          agent: undefined,
          agentProfileId: undefined,
          contextWindow: undefined,
        } : projection.runtimeLeg ? { runtimeLeg: { ...projection.runtimeLeg, id: randomUUID(), nativeSessionId: replacement.backendSessionId, startedAt: Date.now(), canonicalThroughSeq: 0, bootstrap: "continuity" as const } } : {}),
        backendSessionId: replacement.backendSessionId,
        runtimeBinding: replacement,
        status: "epoch-pending",
        updatedAt: Date.now(),
      };
      prep("UPDATE projections SET data = ? WHERE session_id = ?")
        .run(JSON.stringify(nextProjection), input.sessionId);
      return { marker, projection: nextProjection, fencedOperations, heldQueueItems };
    });
  }

  function recoverExecutingInTransaction(sessionId?: string): DurableOperation[] {
    const rows = (sessionId === undefined
      ? prep("SELECT * FROM runtime_operations WHERE state = 'executing' ORDER BY session_id, ordinal")
          .all()
      : prep(
          "SELECT * FROM runtime_operations WHERE state = 'executing' AND session_id = ? ORDER BY ordinal",
        ).all(sessionId)) as unknown as OperationRow[];
    const recovered: DurableOperation[] = [];
    for (const row of rows) {
      prep(
        `UPDATE runtime_operations
         SET state = 'unknown', updated_at = ?, code = ?, message = ?
         WHERE operation_id = ? AND state = 'executing'`,
      ).run(
        Date.now(),
        "process-restarted",
        "execution was interrupted before its outcome was durably recorded",
        row.operation_id,
      );
      const updated = rowToOperation(operationRow(row.operation_id)!);
      recovered.push(updated);
      appendMutationState(updated, "mutation/uncertainty-recorded", {
        code: "process-restarted",
        message: "execution was interrupted before its outcome was durably recorded",
      });
    }
    return recovered;
  }

  async function recoverExecutingOperations(sessionId?: string): Promise<DurableOperation[]> {
    return transaction(() => recoverExecutingInTransaction(sessionId));
  }

  function recoverRestartInterruptedTurns(
    input: RuntimeRestartRecoveryInput,
  ): Promise<RuntimeRestartRecoveryResult | undefined> {
    return Promise.resolve(transaction(() => {
      const projectionRow = prep("SELECT data FROM projections WHERE session_id = ?")
        .get(input.sessionId) as { data: string } | undefined;
      if (!projectionRow) {
        throw Object.assign(new Error("session projection not found"), { code: "not-found" });
      }
      // Idempotency: a marker may already name some stranded turns from an
      // earlier reconciliation pass. Only newly discovered ones are recovered.
      const alreadyRecovered = new Set<string>();
      for (const row of prep(
        "SELECT data FROM events WHERE session_id = ? AND type = 'runtime/restart-recovered'",
      ).all(input.sessionId) as Array<{ data: string }>) {
        try {
          const ids = (JSON.parse(row.data) as { recoveredOperationIds?: unknown })
            .recoveredOperationIds;
          if (Array.isArray(ids)) {
            for (const id of ids) if (typeof id === "string") alreadyRecovered.add(id);
          }
        } catch { /* a malformed marker never blocks recovery */ }
      }
      // Only turns interrupted by a Polyth restart (`process-restarted`, set by
      // recoverExecutingInTransaction) qualify. A runtime-outcome-unknown from
      // normal operation stays blocking — the live runtime can still prove it.
      const stranded = (prep(
        `SELECT * FROM runtime_operations
         WHERE session_id = ?
           AND state = 'unknown'
           AND code = 'process-restarted'
           AND mutation_kind IN ('turn-submit', 'turn-steer')
         ORDER BY ordinal`,
      ).all(input.sessionId) as unknown as OperationRow[])
        .filter((row) => !alreadyRecovered.has(row.operation_id));
      if (stranded.length === 0) return undefined;

      const recoveredOperationIds = stranded.map((row) => row.operation_id);
      const marker = appendInTransaction(
        input.sessionId,
        "runtime/restart-recovered",
        {
          authorityId: input.authorityId,
          generation: input.generation,
          reconciliationOrdinal: input.reconciliationOrdinal,
          recoveredOperationIds,
        },
        { ignorable: true },
      );
      // The operation stays `unknown` — never auto-resolved without protocol
      // proof. A reserved queue draft is held for review, never re-dispatched.
      const heldQueueItems: QueueItemDto[] = [];
      for (const row of stranded) {
        const held = holdEpochTurnForReview(
          rowToOperation(operationRow(row.operation_id)!),
          { synthesizeDraft: false },
        );
        if (held) heldQueueItems.push(held);
      }
      return { marker, recoveredOperationIds, heldQueueItems };
    }));
  }

  // ------------------------------------------------------------- append

  function append(
    sessionId: string,
    type: string,
    data: JsonObject,
    opts: Partial<
      Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
    > = {},
  ): Promise<SessionEvent> {
    return Promise.resolve(transaction(() =>
      appendInTransaction(sessionId, type, data, opts)));
  }

  async function appendBatch(
    sessionId: string,
    inputs: Array<CanonicalEventInput & { time?: number }>,
    opts: { projection?: SessionProjection; expectedSeq?: number; markRead?: boolean } = {},
  ): Promise<SessionEvent[]> {
    if (inputs.length > 2_000 || (opts.projection && opts.projection.id !== sessionId)) {
      throw Object.assign(new Error("invalid event batch"), { code: "invalid-input" });
    }
    return Promise.resolve(transaction(() => {
      const row = prep("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?")
        .get(sessionId) as { seq: number };
      if (opts.expectedSeq !== undefined && Number(row.seq) !== opts.expectedSeq) {
        throw Object.assign(new Error("session changed during publication"), { code: "conflict" });
      }
      const events = inputs.map((input) => {
        const event = appendInputInTransaction(sessionId, input);
        if (input.time !== undefined && Number.isFinite(input.time)) {
          event.time = input.time;
          prep("UPDATE events SET time = ? WHERE session_id = ? AND seq = ?")
            .run(event.time, sessionId, event.seq);
        }
        return event;
      });
      if (opts.projection) {
        prep("INSERT INTO projections (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data")
          .run(sessionId, JSON.stringify(opts.projection));
      }
      if (opts.markRead) {
        prep("INSERT INTO session_read (session_id, seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seq = MAX(session_read.seq, excluded.seq)")
          .run(sessionId, events.at(-1)?.seq ?? row.seq);
      }
      return events;
    }));
  }

  // ------------------------------------------------------------- reads

  function events(sessionId: string, afterSeq = 0, page?: EventPage): Promise<SessionEvent[]> {
    const beforeSeq = page?.beforeSeq;
    const limit = page?.limit;
    if (limit !== undefined && Number.isSafeInteger(limit) && limit >= 0) {
      // Keyset page: the NEWEST `limit` events in the window, returned in
      // ascending order. The (session_id, seq) primary key drives both scans.
      const rows = (beforeSeq !== undefined
        ? prep("SELECT * FROM events WHERE session_id = ? AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ?")
            .all(sessionId, afterSeq, beforeSeq, limit)
        : prep("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
            .all(sessionId, afterSeq, limit)) as unknown as Row[];
      rows.reverse();
      return Promise.resolve(rows.map(rowToEvent));
    }
    const rows = (beforeSeq !== undefined
      ? prep("SELECT * FROM events WHERE session_id = ? AND seq > ? AND seq < ? ORDER BY seq")
          .all(sessionId, afterSeq, beforeSeq)
      : prep("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq")
          .all(sessionId, afterSeq)) as unknown as Row[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  function hasEventOfType(sessionId: string, type: string): Promise<boolean> {
    const row = prep("SELECT 1 AS one FROM events WHERE session_id = ? AND type = ? LIMIT 1")
      .get(sessionId, type) as { one: number } | undefined;
    return Promise.resolve(row !== undefined);
  }

  function latestSeq(sessionId: string): Promise<number> {
    const row = prep("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE session_id = ?")
      .get(sessionId) as { s: number };
    return Promise.resolve(Number(row.s));
  }

  // ------------------------------------------------------------- fork copy

  function copyTo(srcSessionId: string, dstSessionId: string, upToSeq?: number): Promise<void> {
    transaction(() => {
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
        applyAttentionRaw(dstSessionId, r.type, r.data);
      }
    });
    return Promise.resolve();
  }

  // ------------------------------------------------------------- atomic child snapshot (UX-MSG-ACTIONS)

  // Per-message fork publication: prefix events + projection + one lineage
  // marker commit together or not at all. Copied events keep their exact
  // source times/payloads, get fresh child ids, and record source-sequence
  // provenance in source_seqs.
  function publishChildSession(input: ChildSnapshotInput): Promise<ChildSnapshotResult> {
    const childId = input.childSessionId;
    return Promise.resolve(transaction(() => {
      const out: SessionEvent[] = [];
      const existing = prep("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?")
        .get(childId) as { m: number };
      if (Number(existing.m) > 0) {
        throw Object.assign(new Error("child session already has events"), { code: "conflict" });
      }
      const ins = prep(
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
        applyAttention(childId, e.type, e.data);
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
      const marker: SessionEvent = {
        id: markerId, sessionId: childId, seq, time: markerTime,
        type: input.marker.type, data: input.marker.data,
        ...(input.marker.ignorable ? { ignorable: true } : {}),
        v: 1,
      };
      upsertProjectionRow(input.projection);
      return { events: out, marker };
    }));
  }

  // ------------------------------------------------------------- projections

  function upsertProjectionRow(p: SessionProjection): void {
    prep(
      `INSERT INTO projections (session_id, data) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET data = excluded.data`,
    ).run(p.id, JSON.stringify(p));
  }

  function upsertProjection(p: SessionProjection): Promise<void> {
    upsertProjectionRow(p);
    return Promise.resolve();
  }

  // Atomic read-modify-write: increments (token totals) and status patches
  // always apply to the latest committed row, so an awaited callback can never
  // overwrite fields a later callback already changed.
  function patchProjection(
    sessionId: string,
    patch: (current: SessionProjection) => SessionProjection,
  ): Promise<SessionProjection | undefined> {
    return Promise.resolve(transaction(() => {
      const row = prep("SELECT data FROM projections WHERE session_id = ?")
        .get(sessionId) as { data: string } | undefined;
      if (!row) return undefined;
      const next = patch(JSON.parse(row.data) as SessionProjection);
      prep("UPDATE projections SET data = ? WHERE session_id = ?")
        .run(JSON.stringify(next), sessionId);
      return next;
    }));
  }

  function projection(sessionId: string): Promise<SessionProjection | undefined> {
    const row = prep("SELECT data FROM projections WHERE session_id = ?")
      .get(sessionId) as { data: string } | undefined;
    return Promise.resolve(row ? (JSON.parse(row.data) as SessionProjection) : undefined);
  }

  function projections(
    projectId?: string,
    opts?: { spaceId?: string },
  ): Promise<SessionProjection[]> {
    // project_id and space_id are generated columns backed by their own
    // indexes, so scoped listing never json_extracts every row.
    const spaceId = opts?.spaceId;
    const rows = spaceId === undefined
      ? (projectId === undefined
          ? (prep("SELECT data FROM projections").all() as { data: string }[])
          : (prep("SELECT data FROM projections WHERE project_id = ?")
              .all(projectId) as { data: string }[]))
      : (projectId === undefined
          ? (prep("SELECT data FROM projections WHERE space_id = ?")
              .all(spaceId) as { data: string }[])
          : (prep("SELECT data FROM projections WHERE space_id = ? AND project_id = ?")
              .all(spaceId, projectId) as { data: string }[]));
    const list = rows.map((r) => JSON.parse(r.data) as SessionProjection);
    // Defence in depth: the SQL filter and the row contents must agree. A row
    // whose stored spaceId disagrees with the index is dropped rather than
    // returned to the wrong tenant.
    return Promise.resolve(
      spaceId === undefined ? list : list.filter((p) => p.spaceId === spaceId),
    );
  }

  function exportJsonl(sessionId: string): Promise<string> {
    const rows = prep("SELECT data FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { data: string }[];
    return Promise.resolve(rows.map((r) => r.data).join("\n"));
  }

  /** Owning Space of one session, or undefined when the session is unknown or
   *  predates tenancy. Used by event fan-out, which must not ship a session
   *  event to a socket attached to another Space. */
  function spaceOfSession(sessionId: string): string | undefined {
    const row = prep("SELECT space_id AS spaceId FROM projections WHERE session_id = ?")
      .get(sessionId) as { spaceId: string | null } | undefined;
    return row?.spaceId ?? undefined;
  }

  /** Boot migration half: adopt ownerless workspace labels. Idempotent. */
  function adoptLabelsIntoSpace(spaceId: string): Promise<number> {
    const res = sqlitePrepare("UPDATE labels SET space_id = ? WHERE space_id IS NULL").run(spaceId);
    return Promise.resolve(Number(res.changes));
  }

  /** Boot migration half: stamp every projection that still has no owner with
   *  `spaceId`. Returns how many rows were adopted. Idempotent. */
  function adoptSessionsIntoSpace(spaceId: string): Promise<number> {
    return Promise.resolve(transaction(() => {
      const rows = prep(
        "SELECT session_id AS sessionId, data FROM projections WHERE space_id IS NULL",
      ).all() as { sessionId: string; data: string }[];
      const update = prep("UPDATE projections SET data = ? WHERE session_id = ?");
      for (const row of rows) {
        const parsed = JSON.parse(row.data) as SessionProjection;
        if (parsed.spaceId) continue;
        update.run(JSON.stringify({ ...parsed, spaceId }), row.sessionId);
      }
      return rows.length;
    }));
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
    reservation_operation_id: string | null;
    held_for_review: number;
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
      ...(r.held_for_review === 1 ? { heldForReview: true } : {}),
    };
  };

  async function enqueue(sessionId: string, text: string, delivery: DeliveryMode, attachments?: AttachmentRef[]): Promise<QueueItemDto> {
    const queueId = randomUUID();
    const createdAt = Date.now();
    const position = transaction(() => {
      const row = prep("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM session_queue WHERE session_id = ?")
        .get(sessionId) as { next: number };
      prep(
        "INSERT INTO session_queue (queue_id, session_id, position, text, delivery, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(queueId, sessionId, Number(row.next), text, delivery, createdAt, attachments?.length ? JSON.stringify(attachments) : null);
      return Number(row.next);
    });
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
    const result = prep(
      `UPDATE session_queue SET text = ?, held_for_review = 0
       WHERE session_id = ? AND queue_id = ? AND reservation_operation_id IS NULL`,
    )
      .run(text, sessionId, queueId);
    if (Number(result.changes) === 0) return Promise.resolve(undefined);
    const row = prep("SELECT * FROM session_queue WHERE session_id = ? AND queue_id = ?")
      .get(sessionId, queueId) as unknown as QueueRow;
    return Promise.resolve(rowToQueueItem(row));
  }

  async function queueReorder(sessionId: string, ids: string[]): Promise<QueueItemDto[]> {
    transaction(() => {
      const rows = prep("SELECT queue_id FROM session_queue WHERE session_id = ?")
        .all(sessionId) as Array<{ queue_id: string }>;
      const reserved = prep(
        "SELECT 1 AS one FROM session_queue WHERE session_id = ? AND reservation_operation_id IS NOT NULL LIMIT 1",
      ).get(sessionId);
      if (reserved) {
        throw Object.assign(new Error("a reserved queue cannot be reordered"), {
          code: "queue-reserved",
        });
      }
      const existing = new Set(rows.map((r) => r.queue_id));
      const submitted = new Set(ids);
      if (existing.size !== submitted.size || ids.length !== submitted.size || [...existing].some((id) => !submitted.has(id))) {
        throw Object.assign(new Error("ids must be an exact permutation of the session queue"), { code: "invalid-input" });
      }
      const upd = prep("UPDATE session_queue SET position = ? WHERE queue_id = ? AND session_id = ?");
      ids.forEach((id, i) => upd.run(i, id, sessionId));
    });
    return queueList(sessionId);
  }

  function queueRemove(sessionId: string, queueId: string): Promise<boolean> {
    const res = prep(
      `DELETE FROM session_queue
       WHERE session_id = ? AND queue_id = ? AND reservation_operation_id IS NULL`,
    )
      .run(sessionId, queueId);
    return Promise.resolve(Number(res.changes) > 0);
  }

  function queueShift(sessionId: string): Promise<QueueItemDto | undefined> {
    return Promise.resolve(transaction(() => {
      const row = prep("SELECT * FROM session_queue WHERE session_id = ? ORDER BY position LIMIT 1")
        .get(sessionId) as QueueRow | undefined;
      if (!row || row.reservation_operation_id !== null || row.held_for_review !== 0) return undefined;
      prep("DELETE FROM session_queue WHERE queue_id = ?").run(row.queue_id);
      return rowToQueueItem(row);
    }));
  }

  const queueReservationInDatabase = (operationId: string): QueueReservation | undefined => {
    const row = prep(
      "SELECT * FROM session_queue WHERE reservation_operation_id = ?",
    ).get(operationId) as unknown as QueueRow | undefined;
    const op = operationRow(operationId);
    if (!row || !op) return undefined;
    const operation = rowToOperation(op);
    return {
      queueItem: rowToQueueItem(row),
      operation,
      reservedAt: operation.createdAt,
    };
  };

  function queueReservation(operationId: string): Promise<QueueReservation | undefined> {
    return Promise.resolve(queueReservationInDatabase(operationId));
  }

  function holdEpochTurnForReview(
    operation: DurableOperation,
    { synthesizeDraft = true }: { synthesizeDraft?: boolean } = {},
  ): QueueItemDto | undefined {
    const row = prep(
      "SELECT * FROM session_queue WHERE reservation_operation_id = ?",
    ).get(operation.operationId) as unknown as QueueRow | undefined;
    if (row) {
      const changed = prep(
        `UPDATE session_queue
         SET reservation_operation_id = NULL, held_for_review = 1
         WHERE queue_id = ? AND reservation_operation_id = ?`,
      ).run(row.queue_id, operation.operationId);
      if (Number(changed.changes) !== 1) {
        throw Object.assign(new Error("queue reservation changed during epoch replacement"), {
          code: "conflict",
        });
      }
      const held = prep("SELECT * FROM session_queue WHERE queue_id = ?")
        .get(row.queue_id) as unknown as QueueRow;
      return rowToQueueItem(held);
    }
    // A warm restart keeps the backend session (and its copy of the prompt),
    // so the timeline bubble + uncertainty caption is the surface — no
    // synthetic draft. An epoch discards that history, so it synthesizes one.
    if (!synthesizeDraft) return undefined;
    if (operation.ownerEventSeq === undefined) return undefined;
    const ownerRow = prep(
      "SELECT * FROM events WHERE session_id = ? AND seq = ?",
    ).get(operation.sessionId, operation.ownerEventSeq) as unknown as Row | undefined;
    if (!ownerRow) return undefined;
    const owner = rowToEvent(ownerRow);
    if (owner.type !== "user/message") return undefined;
    const data = owner.data as {
      text?: unknown;
      raw?: unknown;
      delivery?: unknown;
      attachments?: unknown;
    };
    const text = typeof data.raw === "string"
      ? data.raw
      : typeof data.text === "string" ? data.text : "";
    if (!text) return undefined;
    const next = prep(
      "SELECT COALESCE(MIN(position), 0) - 1 AS position FROM session_queue WHERE session_id = ?",
    ).get(operation.sessionId) as { position: number };
    const queueId = randomUUID();
    prep(
      `INSERT INTO session_queue (
        queue_id, session_id, position, text, delivery, created_at,
        attachments, reservation_operation_id, held_for_review
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
    ).run(
      queueId,
      operation.sessionId,
      Number(next.position),
      text,
      ["normal", "steer", "queue", "interrupt"].includes(String(data.delivery))
        ? String(data.delivery)
        : "queue",
      Date.now(),
      Array.isArray(data.attachments) && data.attachments.length > 0
        ? JSON.stringify(data.attachments)
        : null,
    );
    const held = prep("SELECT * FROM session_queue WHERE queue_id = ?")
      .get(queueId) as unknown as QueueRow;
    return rowToQueueItem(held);
  }

  async function reserveQueueHead(input: QueueReservationInput): Promise<QueueReservationResult> {
    return transaction(() => {
      const row = prep(
        "SELECT * FROM session_queue WHERE session_id = ? ORDER BY position LIMIT 1",
      ).get(input.sessionId) as unknown as QueueRow | undefined;
      if (!row) return { kind: "empty" };
      if (row.held_for_review === 1) {
        return { kind: "held", queueItem: rowToQueueItem(row) };
      }
      if (row.reservation_operation_id !== null) {
        const reservation = queueReservationInDatabase(row.reservation_operation_id);
        if (!reservation) {
          throw Object.assign(new Error("queue reservation references a missing operation"), {
            code: "integrity-error",
          });
        }
        return { kind: "blocked", reservation };
      }
      const operation = insertPreparedOperation(
        input.sessionId,
        input.mutationKind ?? "turn-submit",
        input.replay ?? { kind: "never" },
      );
      const changed = prep(
        `UPDATE session_queue SET reservation_operation_id = ?
         WHERE queue_id = ? AND session_id = ?
           AND reservation_operation_id IS NULL AND held_for_review = 0`,
      ).run(operation.operationId, row.queue_id, input.sessionId);
      if (Number(changed.changes) !== 1) {
        throw Object.assign(new Error("queue head was reserved concurrently"), {
          code: "conflict",
        });
      }
      appendMutationState(operation, "mutation/prepared");
      return {
        kind: "reserved",
        reservation: {
          queueItem: rowToQueueItem(row),
          operation,
          reservedAt: operation.createdAt,
        },
      };
    });
  }

  async function confirmQueueReservation(
    operationId: string,
    receipt?: string,
  ): Promise<QueueItemDto> {
    return transaction(() => {
      const reservation = queueReservationInDatabase(operationId);
      if (!reservation) {
        throw Object.assign(new Error("queue reservation not found"), { code: "not-found" });
      }
      transitionOperation(operationId, {
        kind: "confirmed",
        ...(receipt ? { receipt } : {}),
      });
      appendInTransaction(
        reservation.queueItem.sessionId,
        "queue/dispatched",
        { queueId: reservation.queueItem.id },
        { ignorable: true },
      );
      prep(
        "DELETE FROM session_queue WHERE queue_id = ? AND reservation_operation_id = ?",
      ).run(reservation.queueItem.id, operationId);
      return reservation.queueItem;
    });
  }

  async function releaseQueueReservation(
    operationId: string,
    settlement:
      | { kind: "rejected"; code: string; message: string }
      | { kind: "not-applied"; code?: string; message: string },
  ): Promise<QueueItemDto> {
    return transaction(() => {
      const reservation = queueReservationInDatabase(operationId);
      if (!reservation) {
        throw Object.assign(new Error("queue reservation not found"), { code: "not-found" });
      }
      transitionOperation(operationId, settlement);
      const changed = prep(
        `UPDATE session_queue SET reservation_operation_id = NULL
         WHERE queue_id = ? AND reservation_operation_id = ?`,
      ).run(reservation.queueItem.id, operationId);
      if (Number(changed.changes) !== 1) {
        throw Object.assign(new Error("queue reservation changed concurrently"), {
          code: "conflict",
        });
      }
      return reservation.queueItem;
    });
  }

  // ------------------------------------------------------------- attention response CAS

  interface ResponseIntentRow {
    session_id: string;
    kind: "permission" | "question" | "secret";
    request_id: string;
    operation_id: string;
    payload: string;
    created_at: number;
  }

  const rowToResponseIntent = (row: ResponseIntentRow): DurableResponseIntent => ({
    kind: row.kind,
    sessionId: row.session_id,
    requestId: row.request_id,
    operationId: row.operation_id,
    payload: JSON.parse(row.payload) as JsonObject,
    createdAt: Number(row.created_at),
  });

  const responseIntentRow = (
    sessionId: string,
    kind: ResponseIntentInput["kind"],
    requestId: string,
  ): ResponseIntentRow | undefined => prep(
    `SELECT * FROM response_intents
     WHERE session_id = ? AND kind = ? AND request_id = ?`,
  ).get(sessionId, kind, requestId) as unknown as ResponseIntentRow | undefined;

  function responseIntent(
    sessionId: string,
    kind: ResponseIntentInput["kind"],
    requestId: string,
  ): Promise<DurableResponseIntent | undefined> {
    const row = responseIntentRow(sessionId, kind, requestId);
    return Promise.resolve(row ? rowToResponseIntent(row) : undefined);
  }

  async function chooseResponseIntent(
    input: ResponseIntentInput,
    replay: ReplayPolicy = { kind: "never" },
  ): Promise<ResponseIntentChoice> {
    return transaction(() => {
      const existing = responseIntentRow(input.sessionId, input.kind, input.requestId);
      if (existing) {
        const operation = operationRow(existing.operation_id);
        if (!operation) {
          throw Object.assign(new Error("response intent references a missing operation"), {
            code: "integrity-error",
          });
        }
        return {
          kind: "existing",
          intent: rowToResponseIntent(existing),
          operation: rowToOperation(operation),
        };
      }
      if (input.kind !== "secret") {
        const attentionKind = input.kind === "permission" ? "permission" : "question";
        const open = prep(
          `SELECT 1 AS one FROM attention_open
           WHERE session_id = ? AND kind = ? AND request_id = ?`,
        ).get(input.sessionId, attentionKind, input.requestId);
        if (!open) {
          throw Object.assign(new Error("request is not actionable"), { code: "not-found" });
        }
      }
      const mutationKind: RuntimeMutationKind = input.kind === "permission"
        ? "permission-reply"
        : input.kind === "secret"
          ? "secret-reply"
          : input.reject
            ? "question-reject"
            : "question-reply";
      const operation = insertPreparedOperation(input.sessionId, mutationKind, replay);
      const payload: JsonObject = input.kind === "permission"
        ? {
            reply: input.reply,
            ...(input.scope ? { scope: input.scope } : {}),
          }
        : input.kind === "question"
          ? {
              answers: input.answers,
              ...(input.reject ? { reject: true } : {}),
            }
          : {
              action: input.action,
              ...(input.handle ? { handle: input.handle } : {}),
            };
      const createdAt = Date.now();
      prep(
        `INSERT INTO response_intents (
           session_id, kind, request_id, operation_id, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        input.kind,
        input.requestId,
        operation.operationId,
        JSON.stringify(payload),
        createdAt,
      );
      const type = input.kind === "permission"
        ? "permission/response-intended"
        : input.kind === "question"
          ? "question/response-intended"
          : "secret/response-intended";
      const intended = appendInTransaction(input.sessionId, type, {
        requestId: input.requestId,
        ...payload,
      }, { ignorable: true });
      prep("UPDATE runtime_operations SET owner_event_seq = ? WHERE operation_id = ?")
        .run(intended.seq, operation.operationId);
      const updated = rowToOperation(operationRow(operation.operationId)!);
      appendMutationState(updated, "mutation/prepared");
      return {
        kind: "chosen",
        intent: {
          kind: input.kind,
          sessionId: input.sessionId,
          requestId: input.requestId,
          operationId: operation.operationId,
          payload,
          createdAt,
        },
        operation: updated,
      };
    });
  }

  async function settleResponseIntent(
    operationId: string,
    settlement: ResponseIntentSettlement,
  ): Promise<DurableOperation> {
    return transaction(() => {
      const row = prep(
        "SELECT * FROM response_intents WHERE operation_id = ?",
      ).get(operationId) as unknown as ResponseIntentRow | undefined;
      if (!row) {
        throw Object.assign(new Error("response intent not found"), { code: "not-found" });
      }
      let result: DurableOperation;
      if (settlement.kind === "confirmed") {
        const expectedType = row.kind === "permission"
          ? "permission/resolved"
          : row.kind === "question"
            ? "question/answered"
            : "secret/resolved";
        if (settlement.completionEvent.type !== expectedType) {
          throw Object.assign(
            new Error(`confirmed ${row.kind} response requires ${expectedType}`),
            { code: "invalid-input" },
          );
        }
        result = transitionOperation(operationId, {
          kind: "confirmed",
          ...(settlement.receipt ? { receipt: settlement.receipt } : {}),
        }).operation;
        appendInputInTransaction(row.session_id, settlement.completionEvent);
      } else if (settlement.kind === "unknown") {
        result = transitionOperation(operationId, settlement).operation;
      } else {
        result = transitionOperation(operationId, settlement).operation;
        appendInTransaction(
          row.session_id,
          `${row.kind}/response-failed`,
          {
            requestId: row.request_id,
            operationId,
            ...(settlement.code ? { code: settlement.code } : {}),
            message: settlement.message,
          },
          { ignorable: true },
        );
        prep("DELETE FROM response_intents WHERE operation_id = ?").run(operationId);
      }
      return result;
    });
  }

  // ------------------------------------------------------------- semantic observation ingestion

  interface CheckpointRow {
    authority_id: string;
    directory: string;
    workspace: string;
    backend_session_id: string;
    artifact_kind: string;
    entity_id: string;
    revision: string;
    state_rank: number | null;
    value: string;
    updated_at: number;
  }

  const entityKeyArgs = (key: ObservationEntityKey): [
    string,
    string,
    string,
    string,
    string,
    string,
  ] => [
    key.authorityId,
    key.location.directory,
    key.location.workspace ?? "",
    key.backendSessionId,
    key.artifactKind,
    key.entityId,
  ];

  const checkpointRow = (key: ObservationEntityKey): CheckpointRow | undefined =>
    prep(
      `SELECT * FROM observation_checkpoints
       WHERE authority_id = ? AND directory = ? AND workspace = ?
         AND backend_session_id = ? AND artifact_kind = ? AND entity_id = ?`,
    ).get(...entityKeyArgs(key)) as unknown as CheckpointRow | undefined;

  const rowToCheckpoint = (row: CheckpointRow): ObservationCheckpoint => ({
    key: {
      authorityId: row.authority_id,
      location: {
        directory: row.directory,
        ...(row.workspace ? { workspace: row.workspace } : {}),
      },
      backendSessionId: row.backend_session_id,
      artifactKind: row.artifact_kind as ObservationEntityKey["artifactKind"],
      entityId: row.entity_id,
    },
    revision: row.revision,
    ...(row.state_rank !== null ? { stateRank: Number(row.state_rank) } : {}),
    value: JSON.parse(row.value) as JsonObject,
    updatedAt: Number(row.updated_at),
  });

  function observationCheckpoint(
    key: ObservationEntityKey,
  ): Promise<ObservationCheckpoint | undefined> {
    const row = checkpointRow(key);
    return Promise.resolve(row ? rowToCheckpoint(row) : undefined);
  }

  const cursorKeyArgs = (key: ObservationCursorKey): [
    string,
    string,
    string,
    string,
    string,
  ] => [
    key.authorityId,
    key.location.directory,
    key.location.workspace ?? "",
    key.backendSessionId,
    key.channel,
  ];

  function observationCursor(key: ObservationCursorKey): Promise<string | undefined> {
    const row = prep(
      `SELECT cursor_after FROM observation_cursors
       WHERE authority_id = ? AND directory = ? AND workspace = ?
         AND backend_session_id = ? AND channel = ?`,
    ).get(...cursorKeyArgs(key)) as { cursor_after: string } | undefined;
    return Promise.resolve(row?.cursor_after);
  }

  function upsertObservationCursor(key: ObservationCursorKey, after: string): void {
    prep(
      `INSERT INTO observation_cursors (
         authority_id, directory, workspace, backend_session_id,
         channel, cursor_after, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(authority_id, directory, workspace, backend_session_id, channel)
       DO UPDATE SET cursor_after = excluded.cursor_after, updated_at = excluded.updated_at`,
    ).run(...cursorKeyArgs(key), after, Date.now());
  }

  const eventsAtSeqs = (sessionId: string, seqs: readonly number[]): SessionEvent[] => {
    if (seqs.length === 0) return [];
    const placeholders = seqs.map(() => "?").join(",");
    const rows = sqlitePrepare(
      `SELECT * FROM events
       WHERE session_id = ? AND seq IN (${placeholders}) ORDER BY seq`,
    ).all(sessionId, ...seqs) as unknown as Row[];
    return rows.map(rowToEvent);
  };

  const validateObservationInput = (input: ObservationIngestionInput): void => {
    if (!Number.isSafeInteger(input.reconciliationOrdinal) || input.reconciliationOrdinal <= 0) {
      throw Object.assign(
        new Error("reconciliation ordinal must be a positive safe integer"),
        { code: "invalid-input" },
      );
    }
    if (!Number.isSafeInteger(input.identity.generation) || input.identity.generation < 0) {
      throw Object.assign(new Error("endpoint generation must be a non-negative safe integer"), {
        code: "invalid-input",
      });
    }
  };

  const assertObservationFence = (input: ObservationIngestionInput): void => {
    const projectionRow = prep("SELECT data FROM projections WHERE session_id = ?")
      .get(input.sessionId) as { data: string } | undefined;
    const projection = projectionRow
      ? JSON.parse(projectionRow.data) as SessionProjection
      : undefined;
    const binding = projection?.runtimeBinding;
    if (
      !binding
      || projection.backendSessionId !== binding.backendSessionId
      || binding.authorityId !== input.identity.authorityId
      || binding.generation !== input.identity.generation
      || binding.location.directory !== input.identity.location.directory
      || (binding.location.workspace ?? "") !== (input.identity.location.workspace ?? "")
      || binding.backendSessionId !== input.identity.backendSessionId
    ) {
      throw Object.assign(
        new Error("observation does not match the durable current runtime binding"),
        { code: "stale-evidence" },
      );
    }
    const active = reconciliationRow(input.sessionId);
    if (!active || Number(active.ordinal) !== input.reconciliationOrdinal) {
      throw Object.assign(
        new Error("observation belongs to a superseded reconciliation request"),
        { code: "stale-evidence" },
      );
    }
  };

  const ingestObservationInTransaction = (
    input: ObservationIngestionInput,
  ): ObservationIngestionResult => {
    const key: ObservationEntityKey = {
      authorityId: input.identity.authorityId,
      location: input.identity.location,
      backendSessionId: input.identity.backendSessionId,
      artifactKind: input.identity.artifactKind,
      entityId: input.identity.entityId,
    };
      const tombstone = prep(
        `SELECT 1 AS one FROM deletion_tombstones
         WHERE authority_id = ? AND directory = ? AND workspace = ?
           AND backend_session_id = ? AND retired_at IS NULL`,
      ).get(
        input.identity.authorityId,
        input.identity.location.directory,
        input.identity.location.workspace ?? "",
        input.identity.backendSessionId,
      );
      if (tombstone) {
        throw Object.assign(new Error("backend binding is deletion-tombstoned"), {
          code: "tombstoned",
        });
      }
      assertObservationFence(input);

      const identityArgs = [
        ...entityKeyArgs(key),
        input.identity.revision,
      ] as const;
      const existing = prep(
        `SELECT session_id, canonical_seqs FROM observations
         WHERE authority_id = ? AND directory = ? AND workspace = ?
           AND backend_session_id = ? AND artifact_kind = ? AND entity_id = ?
           AND revision = ?`,
      ).get(...identityArgs) as { session_id: string; canonical_seqs: string } | undefined;
      if (existing) {
        if (input.cursor) upsertObservationCursor(input.cursor.key, input.cursor.after);
        const seqs = JSON.parse(existing.canonical_seqs) as number[];
        const checkpoint = checkpointRow(key);
        return {
          kind: "duplicate",
          events: eventsAtSeqs(existing.session_id, seqs),
          ...(checkpoint ? { checkpoint: rowToCheckpoint(checkpoint) } : {}),
        };
      }

      const priorCheckpoint = checkpointRow(key);
      if (
        input.checkpoint?.stateRank !== undefined
        && priorCheckpoint?.state_rank !== null
        && priorCheckpoint !== undefined
      ) {
        if (input.checkpoint.stateRank < Number(priorCheckpoint.state_rank)) {
          throw Object.assign(new Error("observation state rank regressed"), {
            code: "observation-regressive",
          });
        }
        if (input.checkpoint.stateRank === Number(priorCheckpoint.state_rank)) {
          const same = JSON.stringify(input.checkpoint.value) === priorCheckpoint.value;
          if (!same) {
            throw Object.assign(
              new Error("observation payload changed at an already-emitted state rank"),
              { code: "observation-uncertain" },
            );
          }
          const latest = prep(
            `SELECT session_id, canonical_seqs FROM observations
             WHERE authority_id = ? AND directory = ? AND workspace = ?
               AND backend_session_id = ? AND artifact_kind = ? AND entity_id = ?
             ORDER BY observed_at DESC LIMIT 1`,
          ).get(...entityKeyArgs(key)) as {
            session_id: string;
            canonical_seqs: string;
          } | undefined;
          const seqs = latest ? JSON.parse(latest.canonical_seqs) as number[] : [];
          prep(
            `INSERT INTO observations (
               authority_id, directory, workspace, backend_session_id,
               artifact_kind, entity_id, revision, session_id,
               observed_generation, reconciliation_ordinal, canonical_seqs, observed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            ...identityArgs,
            input.sessionId,
            input.identity.generation,
            input.reconciliationOrdinal,
            JSON.stringify(seqs),
            Date.now(),
          );
          if (input.cursor) upsertObservationCursor(input.cursor.key, input.cursor.after);
          return {
            kind: "duplicate",
            events: latest ? eventsAtSeqs(latest.session_id, seqs) : [],
            checkpoint: rowToCheckpoint(priorCheckpoint),
          };
        }
      }

      prep(
        `INSERT INTO observations (
           authority_id, directory, workspace, backend_session_id,
           artifact_kind, entity_id, revision, session_id,
           observed_generation, reconciliation_ordinal, canonical_seqs, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
      ).run(
        ...identityArgs,
        input.sessionId,
        input.identity.generation,
        input.reconciliationOrdinal,
        Date.now(),
      );
      const appended = input.events.map((event) =>
        appendInputInTransaction(input.sessionId, event));
      if (input.checkpoint) {
        prep(
          `INSERT INTO observation_checkpoints (
             authority_id, directory, workspace, backend_session_id,
             artifact_kind, entity_id, revision, state_rank, value, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(
             authority_id, directory, workspace, backend_session_id, artifact_kind, entity_id
           ) DO UPDATE SET
             revision = excluded.revision,
             state_rank = excluded.state_rank,
             value = excluded.value,
             updated_at = excluded.updated_at`,
        ).run(
          ...entityKeyArgs(key),
          input.identity.revision,
          input.checkpoint.stateRank ?? null,
          JSON.stringify(input.checkpoint.value),
          Date.now(),
        );
      }
      if (input.cursor) upsertObservationCursor(input.cursor.key, input.cursor.after);
      prep(
        `UPDATE observations SET canonical_seqs = ?
         WHERE authority_id = ? AND directory = ? AND workspace = ?
           AND backend_session_id = ? AND artifact_kind = ? AND entity_id = ?
           AND revision = ?`,
      ).run(JSON.stringify(appended.map((event) => event.seq)), ...identityArgs);
      const checkpoint = checkpointRow(key);
      return {
        kind: "applied",
        events: appended,
        ...(checkpoint ? { checkpoint: rowToCheckpoint(checkpoint) } : {}),
      };
  };

  async function ingestObservation(
    input: ObservationIngestionInput,
  ): Promise<ObservationIngestionResult> {
    validateObservationInput(input);
    return transaction(() => ingestObservationInTransaction(input));
  }

  async function ingestSnapshot(
    input: SnapshotIngestionInput,
  ): Promise<SnapshotIngestionResult> {
    if (input.observations.some((observation) => observation.sessionId !== input.sessionId)) {
      throw Object.assign(new Error("snapshot observations must belong to one session"), {
        code: "invalid-input",
      });
    }
    for (const observation of input.observations) validateObservationInput(observation);
    return transaction(() => ({
      observations: input.observations.map(ingestObservationInTransaction),
    }));
  }

  // ------------------------------------------------------------- reconciliation barrier

  interface ReconciliationRow {
    session_id: string;
    ordinal: number;
    state: string;
    reason: string | null;
    updated_at: number;
  }

  const rowToReconciliation = (row: ReconciliationRow): DurableReconciliation => ({
    sessionId: row.session_id,
    ordinal: Number(row.ordinal),
    state: row.state as DurableReconciliation["state"],
    ...(row.reason !== null ? { reason: row.reason } : {}),
    updatedAt: Number(row.updated_at),
  });

  const reconciliationRow = (sessionId: string): ReconciliationRow | undefined =>
    prep("SELECT * FROM session_reconciliations WHERE session_id = ?")
      .get(sessionId) as unknown as ReconciliationRow | undefined;

  function reconciliation(sessionId: string): Promise<DurableReconciliation | undefined> {
    const row = reconciliationRow(sessionId);
    return Promise.resolve(row ? rowToReconciliation(row) : undefined);
  }

  async function startReconciliation(sessionId: string): Promise<DurableReconciliation> {
    return transaction(() => {
      const prior = reconciliationRow(sessionId);
      const ordinal = prior ? Number(prior.ordinal) + 1 : 1;
      const now = Date.now();
      prep(
        `INSERT INTO session_reconciliations (session_id, ordinal, state, reason, updated_at)
         VALUES (?, ?, 'reconciling', NULL, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           ordinal = excluded.ordinal,
           state = excluded.state,
           reason = NULL,
           updated_at = excluded.updated_at`,
      ).run(sessionId, ordinal, now);
      appendInTransaction(
        sessionId,
        "reconciliation/started",
        { ordinal },
        { ignorable: true },
      );
      return rowToReconciliation(reconciliationRow(sessionId)!);
    });
  }

  async function settleReconciliation(
    sessionId: string,
    ordinal: number,
    state: "ready" | "blocked" | "unknown",
    reason?: string,
  ): Promise<
    | { kind: "accepted"; reconciliation: DurableReconciliation }
    | { kind: "superseded"; reconciliation: DurableReconciliation }
  > {
    return transaction(() => {
      const current = reconciliationRow(sessionId);
      if (!current) {
        throw Object.assign(new Error("reconciliation not started"), { code: "not-found" });
      }
      if (Number(current.ordinal) !== ordinal) {
        return {
          kind: "superseded",
          reconciliation: rowToReconciliation(current),
        };
      }
      prep(
        `UPDATE session_reconciliations
         SET state = ?, reason = ?, updated_at = ?
         WHERE session_id = ? AND ordinal = ?`,
      ).run(state, reason ?? null, Date.now(), sessionId, ordinal);
      appendInTransaction(
        sessionId,
        state === "ready" ? "reconciliation/completed" : "reconciliation/blocked",
        {
          ordinal,
          state,
          ...(reason ? { reason } : {}),
        },
        { ignorable: true },
      );
      return {
        kind: "accepted",
        reconciliation: rowToReconciliation(reconciliationRow(sessionId)!),
      };
    });
  }

  // ------------------------------------------------------------- deletion tombstones

  interface TombstoneRow {
    canonical_session_id: string;
    authority_id: string;
    endpoint_generation: number;
    directory: string;
    workspace: string;
    backend_session_id: string;
    operation_id: string;
    created_at: number;
    retired_at: number | null;
    retirement_kind: "confirmed" | "purged" | null;
    retirement_policy: string | null;
  }

  const rowToTombstone = (row: TombstoneRow): DeletionTombstone => ({
    binding: {
      canonicalSessionId: row.canonical_session_id,
      authorityId: row.authority_id,
      generation: Number(row.endpoint_generation),
      location: {
        directory: row.directory,
        ...(row.workspace ? { workspace: row.workspace } : {}),
      },
      backendSessionId: row.backend_session_id,
    },
    operationId: row.operation_id,
    createdAt: Number(row.created_at),
    ...(row.retired_at !== null ? { retiredAt: Number(row.retired_at) } : {}),
    ...(row.retirement_kind === "confirmed"
      ? { retirement: { kind: "confirmed" as const } }
      : row.retirement_kind === "purged"
        ? {
            retirement: {
              kind: "purged" as const,
              policy: row.retirement_policy ?? "",
            },
          }
        : {}),
  });

  const tombstoneRow = (canonicalSessionId: string): TombstoneRow | undefined =>
    prep("SELECT * FROM deletion_tombstones WHERE canonical_session_id = ?")
      .get(canonicalSessionId) as unknown as TombstoneRow | undefined;

  function deletionTombstone(
    canonicalSessionId: string,
  ): Promise<DeletionTombstone | undefined> {
    const row = tombstoneRow(canonicalSessionId);
    return Promise.resolve(row ? rowToTombstone(row) : undefined);
  }

  function hasDeletionTombstone(binding: DeletionTombstoneBinding): Promise<boolean> {
    const row = prep(
      `SELECT 1 AS one FROM deletion_tombstones
       WHERE authority_id = ? AND directory = ? AND workspace = ?
         AND backend_session_id = ? AND retired_at IS NULL
       LIMIT 1`,
    ).get(
      binding.authorityId,
      binding.location.directory,
      binding.location.workspace ?? "",
      binding.backendSessionId,
    );
    return Promise.resolve(row !== undefined);
  }

  async function prepareSessionDeletion(
    input: PrepareDeletionTombstoneInput,
  ): Promise<PreparedDeletionTombstoneResult> {
    return transaction(() => {
      if (tombstoneRow(input.binding.canonicalSessionId)) {
        throw Object.assign(new Error("deletion tombstone already exists"), {
          code: "conflict",
        });
      }
      const operation = insertPreparedOperation(
        input.binding.canonicalSessionId,
        "session-delete",
        input.replay ?? { kind: "never" },
      );
      const createdAt = Date.now();
      prep(
        `INSERT INTO deletion_tombstones (
           canonical_session_id, authority_id, endpoint_generation,
           directory, workspace, backend_session_id, operation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.binding.canonicalSessionId,
        input.binding.authorityId,
        input.binding.generation,
        input.binding.location.directory,
        input.binding.location.workspace ?? "",
        input.binding.backendSessionId,
        operation.operationId,
        createdAt,
      );

      deleteSessionRows(input.binding.canonicalSessionId);
      prep(
        `DELETE FROM observation_checkpoints
         WHERE authority_id = ? AND directory = ? AND workspace = ?
           AND backend_session_id = ?`,
      ).run(
        input.binding.authorityId,
        input.binding.location.directory,
        input.binding.location.workspace ?? "",
        input.binding.backendSessionId,
      );
      prep(
        `DELETE FROM observation_cursors
         WHERE authority_id = ? AND directory = ? AND workspace = ?
           AND backend_session_id = ?`,
      ).run(
        input.binding.authorityId,
        input.binding.location.directory,
        input.binding.location.workspace ?? "",
        input.binding.backendSessionId,
      );
      const tombstone = rowToTombstone(tombstoneRow(input.binding.canonicalSessionId)!);
      return { tombstone, operation };
    });
  }

  async function retireDeletionTombstone(
    canonicalSessionId: string,
    retirement: { kind: "confirmed" } | { kind: "purged"; policy: string },
  ): Promise<DeletionTombstone> {
    return transaction(() => {
      const row = tombstoneRow(canonicalSessionId);
      if (!row) throw Object.assign(new Error("deletion tombstone not found"), { code: "not-found" });
      if (row.retired_at !== null) return rowToTombstone(row);
      if (retirement.kind === "confirmed") {
        const operation = operationRow(row.operation_id);
        if (!operation || operation.state !== "confirmed") {
          throw Object.assign(
            new Error("upstream deletion is not durably confirmed"),
            { code: "invalid-transition" },
          );
        }
      } else if (retirement.policy.trim() === "") {
        throw Object.assign(new Error("explicit purge policy is required"), {
          code: "invalid-input",
        });
      }
      prep(
        `UPDATE deletion_tombstones
         SET retired_at = ?, retirement_kind = ?, retirement_policy = ?
         WHERE canonical_session_id = ? AND retired_at IS NULL`,
      ).run(
        Date.now(),
        retirement.kind,
        retirement.kind === "purged" ? retirement.policy : null,
        canonicalSessionId,
      );
      return rowToTombstone(tombstoneRow(canonicalSessionId)!);
    });
  }

  /** Delete every row keyed by Polyth `session_id` except `runtime_operations`.
   *  The session-delete tombstone's own operation lives there and must survive
   *  the purge. `observation_checkpoints` / `observation_cursors` are keyed by
   *  backend session identity, not `session_id`. `deletion_tombstones`, folders,
   *  labels, and agent_profiles are not session-owned rows. */
  function deleteSessionRows(sessionId: string): void {
    for (const table of [
      "events", "projections", "session_queue", "attention_open",
      "response_intents", "session_read", "observations", "session_reconciliations",
    ]) {
      prep(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
  }

  /** Hard delete: events + projection + queued messages, one transaction. */
  function deleteSession(sessionId: string): Promise<void> {
    transaction(() => deleteSessionRows(sessionId));
    return Promise.resolve();
  }

  function deleteProjection(sessionId: string): Promise<void> {
    prep("DELETE FROM projections WHERE session_id = ?").run(sessionId);
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
    const siblings = sqlitePrepare("SELECT * FROM folders WHERE project_id = ?").all(projectId) as unknown as FolderRow[];
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

  function folderProject(id: string): string | undefined {
    const row = prep("SELECT project_id AS projectId FROM folders WHERE id = ?")
      .get(id) as { projectId: string } | undefined;
    return row?.projectId;
  }

  async function folderList(projectId: string): Promise<SessionFolderDto[]> {
    const rows = sqlitePrepare("SELECT * FROM folders WHERE project_id = ? ORDER BY position, name")
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
    const pos = sqlitePrepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM folders WHERE project_id = ?").get(projectId) as { next: number };
    sqlitePrepare("INSERT INTO folders (id, project_id, parent_id, name, position, revision) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, projectId, parentId ?? null, trimmed, Number(pos.next));
    return rowToFolder(folderRow(id)!);
  }

  async function folderUpdate(
    id: string,
    patch: { name?: string; parentId?: string | null; position?: number },
    expectedRevision: number,
  ): Promise<SessionFolderDto> {
    return transaction(() => {
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
      sqlitePrepare("UPDATE folders SET name = ?, parent_id = ?, position = ?, revision = revision + 1 WHERE id = ?")
        .run(name, parentId, position, id);
      return rowToFolder(folderRow(id)!);
    });
  }

  async function folderRemove(id: string): Promise<boolean> {
    return transaction(() => {
      const row = folderRow(id);
      if (!row) return false;
      const children = sqlitePrepare("SELECT * FROM folders WHERE parent_id = ?").all(id) as unknown as FolderRow[];
      for (const child of children) {
        assertUniqueFolderName(row.project_id, row.parent_id, child.name, [id, child.id]);
      }
      sqlitePrepare("UPDATE folders SET parent_id = ?, revision = revision + 1 WHERE parent_id = ?").run(row.parent_id, id);
      sqlitePrepare("DELETE FROM folders WHERE id = ?").run(id);
      return true;
    });
  }

  interface LabelRow { id: string; name: string; color: string; position: number; revision: number; space_id: string | null }
  const rowToLabel = (r: LabelRow): WorkspaceLabel => ({
    id: r.id, name: r.name, color: r.color, position: Number(r.position), revision: Number(r.revision),
  });

  async function labelList(spaceId?: string): Promise<WorkspaceLabel[]> {
    const rows = (spaceId === undefined
      ? sqlitePrepare("SELECT * FROM labels ORDER BY position, name").all()
      : sqlitePrepare("SELECT * FROM labels WHERE space_id = ? ORDER BY position, name").all(spaceId)
    ) as unknown as LabelRow[];
    return rows.map(rowToLabel);
  }

  async function labelCreate(name: string, color: string, spaceId?: string): Promise<WorkspaceLabel> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) throw Object.assign(new Error("label name required (≤60 chars)"), { code: "invalid-input" });
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) throw Object.assign(new Error("label color must be a hex value"), { code: "invalid-input" });
    const id = randomUUID();
    const pos = sqlitePrepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM labels").get() as { next: number };
    sqlitePrepare("INSERT INTO labels (id, name, color, position, revision, space_id) VALUES (?, ?, ?, ?, 1, ?)")
      .run(id, trimmed, color, Number(pos.next), spaceId ?? null);
    const row = sqlitePrepare("SELECT * FROM labels WHERE id = ?").get(id) as unknown as LabelRow;
    return rowToLabel(row);
  }

  async function labelUpdate(
    id: string,
    patch: { name?: string; color?: string; position?: number },
    expectedRevision: number,
    spaceId?: string,
  ): Promise<WorkspaceLabel> {
    return transaction(() => {
      const row = sqlitePrepare("SELECT * FROM labels WHERE id = ?").get(id) as LabelRow | undefined;
      // A label owned by another Space is reported as missing, never as
      // forbidden — the id must not become an existence oracle.
      if (!row || (spaceId !== undefined && row.space_id !== spaceId)) {
        throw Object.assign(new Error("label not found"), { code: "not-found" });
      }
      if (Number(row.revision) !== expectedRevision) throw Object.assign(new Error("stale label revision"), { code: "conflict" });
      const name = patch.name !== undefined ? patch.name.trim() : row.name;
      if (!name || name.length > 60) throw Object.assign(new Error("label name required (≤60 chars)"), { code: "invalid-input" });
      const color = patch.color ?? row.color;
      if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) throw Object.assign(new Error("label color must be a hex value"), { code: "invalid-input" });
      const position = patch.position ?? Number(row.position);
      sqlitePrepare("UPDATE labels SET name = ?, color = ?, position = ?, revision = revision + 1 WHERE id = ?")
        .run(name, color, position, id);
      return rowToLabel(sqlitePrepare("SELECT * FROM labels WHERE id = ?").get(id) as unknown as LabelRow);
    });
  }

  async function labelRemove(id: string, spaceId?: string): Promise<boolean> {
    const res = spaceId === undefined
      ? sqlitePrepare("DELETE FROM labels WHERE id = ?").run(id)
      : sqlitePrepare("DELETE FROM labels WHERE id = ? AND space_id = ?").run(id, spaceId);
    return Number(res.changes) > 0;
  }

  // ------------------------------------------------------------- agent profiles (WP8)

  interface ProfileRow {
    id: string; name: string; provider_id: string; model_id: string;
    harness_id: string | null;
    agent: string | null; mode: string | null; thinking: string | null;
    features: string; notes: string | null; icon: string | null; color: string | null;
    revision: number; created_at: number; updated_at: number;
  }
  const rowToProfile = (r: ProfileRow): AgentProfile => ({
    id: r.id,
    name: r.name,
    ...(r.harness_id ? { harnessId: r.harness_id } : {}),
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
    sqlitePrepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as unknown as ProfileRow | undefined;

  async function profileList(): Promise<AgentProfile[]> {
    const rows = sqlitePrepare("SELECT * FROM agent_profiles ORDER BY name").all() as unknown as ProfileRow[];
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
    sqlitePrepare(
      `INSERT INTO agent_profiles (id, name, harness_id, provider_id, model_id, agent, mode, thinking, features, notes, icon, color, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id, name, input.harnessId ?? "opencode", input.providerID, input.modelID,
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
    return transaction(() => {
      const row = profileRow(id);
      if (!row) throw Object.assign(new Error("profile not found"), { code: "not-found" });
      if (Number(row.revision) !== expectedRevision) throw Object.assign(new Error("stale profile revision"), { code: "conflict" });
      const name = patch.name !== undefined ? patch.name.trim() : row.name;
      if (!name || name.length > 80) throw Object.assign(new Error("profile name required (≤80 chars)"), { code: "invalid-input" });
      sqlitePrepare(
        `UPDATE agent_profiles SET name = ?, harness_id = ?, provider_id = ?, model_id = ?, agent = ?, mode = ?, thinking = ?,
         features = ?, notes = ?, icon = ?, color = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      ).run(
        name,
        patch.harnessId ?? row.harness_id,
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
      return rowToProfile(profileRow(id)!);
    });
  }

  async function profileRemove(id: string): Promise<boolean> {
    const res = sqlitePrepare("DELETE FROM agent_profiles WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  // ------------------------------------------------------------- attention + search (WP5)

  async function attentionFor(sessionIds: string[]): Promise<Record<string, AttentionCounts>> {
    const out: Record<string, AttentionCounts> = {};
    if (sessionIds.length === 0) return out;
    for (const id of sessionIds) out[id] = { questions: 0, permissions: 0, unread: 0 };
    // Counters come from the append-maintained attention_open table — a
    // primary-key range count per session instead of replaying event logs.
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = sqlitePrepare(
        `SELECT session_id, kind, COUNT(*) AS n FROM attention_open
         WHERE session_id IN (${placeholders}) GROUP BY session_id, kind`,
      )
      .all(...sessionIds) as Array<{ session_id: string; kind: string; n: number }>;
    for (const r of rows) {
      const slot = out[r.session_id];
      if (!slot) continue;
      if (r.kind === "question") slot.questions = Number(r.n);
      else if (r.kind === "permission") slot.permissions = Number(r.n);
    }
    // Unread assistant messages past the read cursor (session_read). The
    // (session_id, seq) primary key keeps this a per-session range scan.
    const unreadRows = sqlitePrepare(
        `SELECT e.session_id, COUNT(*) AS n FROM events e
         JOIN session_read r ON r.session_id = e.session_id
         WHERE e.session_id IN (${placeholders})
           AND e.type = 'assistant/message'
           AND e.seq > r.seq
         GROUP BY e.session_id`,
      )
      .all(...sessionIds) as Array<{ session_id: string; n: number }>;
    for (const r of unreadRows) {
      const slot = out[r.session_id];
      if (slot) slot.unread = Number(r.n);
    }
    return out;
  }

  function setReadCursor(sessionId: string, seq: number): Promise<boolean> {
    if (!Number.isSafeInteger(seq) || seq <= 0) return Promise.resolve(false);
    const advanced = transaction(() => {
      const row = sqlitePrepare("SELECT seq FROM session_read WHERE session_id = ?")
        .get(sessionId) as { seq: number } | undefined;
      if (row !== undefined && row.seq >= seq) return false;
      prep(
        "INSERT INTO session_read (session_id, seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq",
      ).run(sessionId, seq);
      return true;
    });
    return Promise.resolve(advanced);
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

  function listPromptHistory(opts: {
    spaceId: string;
    sessionId?: string;
    limit: number;
  }): Promise<PromptHistoryEntryDto[]> {
    const limit = clampPromptHistoryLimit(opts.limit);
    const sessionId = opts.sessionId;
    const hiders = new Map<string, (seq: number) => boolean>();
    const hidden = (sid: string, seq: number) => hiders.get(sid)?.(seq) ?? false;
    const ensureRewindHiders = (sessionIds: readonly string[]) => {
      const missing = [...new Set(sessionIds)].filter((id) => id && !hiders.has(id));
      if (missing.length === 0) return;
      const placeholders = missing.map(() => "?").join(",");
      const rows = prep(
        `SELECT e.session_id AS sessionId, e.seq, e.type, e.data
         FROM events e
         INNER JOIN projections p ON p.session_id = e.session_id
         WHERE p.space_id = ?
           AND e.session_id IN (${placeholders})
           AND e.type IN ('session/rewound', 'session/rewind-cleared')
         ORDER BY e.session_id, e.seq ASC`,
      ).all(opts.spaceId, ...missing) as unknown as RewindMarkerRow[];
      const grouped = new Map<string, RewindMarkerRow[]>();
      for (const id of missing) grouped.set(id, []);
      for (const row of rows) grouped.get(row.sessionId)!.push(row);
      for (const id of missing) hiders.set(id, rewindVisibility(grouped.get(id)!));
    };
    if (sessionId) ensureRewindHiders([sessionId]);
    // Do not json_extract() candidate payloads: SQLite JSON functions abort
    // the statement on malformed JSON, which would 500 the whole endpoint.
    const candidateSql = `
      e.type = 'user/message'
      OR (e.type = 'tool/call' AND e.producer = 'composer-shell')`;
    const selectSql = `SELECT e.session_id AS sessionId, e.seq, e.id, e.time, e.type, e.data,
              e.rowid AS rowid, p.project_id AS projectId,
              json_extract(p.data, '$.worktreePath') AS worktreePath
       FROM events e
       INNER JOIN projections p ON p.session_id = e.session_id`;
    const chunk = Math.min(200, Math.max(PROMPT_HISTORY_CHUNK, limit));
    const newestFirst: PromptHistoryEntryDto[] = [];
    let cursor: { seq: number } | { time: number; rowid: number } | null = null;
    while (newestFirst.length < limit) {
      const rows = (sessionId
        ? (cursor && "seq" in cursor
            ? prep(
                `${selectSql}
                 WHERE p.space_id = ? AND e.session_id = ? AND (${candidateSql}) AND e.seq < ?
                 ORDER BY e.seq DESC LIMIT ?`,
              ).all(opts.spaceId, sessionId, cursor.seq, chunk)
            : prep(
                `${selectSql}
                 WHERE p.space_id = ? AND e.session_id = ? AND (${candidateSql})
                 ORDER BY e.seq DESC LIMIT ?`,
              ).all(opts.spaceId, sessionId, chunk))
        : (cursor && "time" in cursor
            ? prep(
                `${selectSql}
                 WHERE p.space_id = ? AND (${candidateSql})
                   AND (e.time < ? OR (e.time = ? AND e.rowid < ?))
                 ORDER BY e.time DESC, e.rowid DESC LIMIT ?`,
              ).all(opts.spaceId, cursor.time, cursor.time, cursor.rowid, chunk)
            : prep(
                `${selectSql}
                 WHERE p.space_id = ? AND (${candidateSql})
                 ORDER BY e.time DESC, e.rowid DESC LIMIT ?`,
              ).all(opts.spaceId, chunk))) as unknown as Array<PromptHistoryCandidateRow & { rowid: number }>;
      if (rows.length === 0) break;
      ensureRewindHiders(rows.map((row) => row.sessionId));
      for (const row of rows) {
        if (hidden(row.sessionId, row.seq)) continue;
        const entry = parsePromptHistoryCandidate(row);
        if (!entry) continue;
        newestFirst.push(entry);
        if (newestFirst.length >= limit) break;
      }
      const last = rows[rows.length - 1]!;
      cursor = sessionId
        ? { seq: last.seq }
        : { time: last.time, rowid: last.rowid };
      if (rows.length < chunk) break;
    }
    newestFirst.reverse();
    return Promise.resolve(newestFirst);
  }

  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    closed = true;
    stmts.clear();
    raw.close();
    return Promise.resolve();
  }

  // A process cannot know whether a previously executing operation reached
  // the network. Recover every stranded claim to durable uncertainty before
  // exposing the store to callers.
  transaction(() => recoverExecutingInTransaction());

  return {
    append,
    appendBatch,
    events,
    hasEventOfType,
    latestSeq,
    copyTo,
    publishChildSession,
    upsertProjection,
    spaceOfSession,
    adoptSessionsIntoSpace,
    adoptLabelsIntoSpace,
    patchProjection,
    projection,
    projections,
    exportJsonl,
    prepareOperation,
    prepareSessionCreate,
    operation,
    operations,
    claimOperation,
    replayUnknownOperation,
    settleOperation,
    transitionRuntimeEpoch,
    recoverExecutingOperations,
    recoverRestartInterruptedTurns,
    enqueue,
    queueList,
    queueEdit,
    queueReorder,
    queueRemove,
    queueShift,
    reserveQueueHead,
    queueReservation,
    confirmQueueReservation,
    releaseQueueReservation,
    chooseResponseIntent,
    responseIntent,
    settleResponseIntent,
    ingestObservation,
    ingestSnapshot,
    observationCheckpoint,
    observationCursor,
    startReconciliation,
    reconciliation,
    settleReconciliation,
    prepareSessionDeletion,
    deletionTombstone,
    hasDeletionTombstone,
    retireDeletionTombstone,
    deleteSession,
    deleteProjection,
    folderList,
    folderProject,
    folderCreate,
    folderUpdate,
    folderRemove,
    labelList,
    labelCreate,
    labelUpdate,
    labelRemove,
    attentionFor,
    setReadCursor,
    searchEventText,
    listPromptHistory,
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
  const emittedAssistantParts = new Set<string>();
  const visibleEvents = effectiveHistory(events).events;

  // Consecutive parts from the same role merge into one message.
  const push = (role: ModelMessage["role"], part: ModelMessage["parts"][number]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };
  const pushText = (role: ModelMessage["role"], text: string) => push(role, { type: "text", text });

  // Attachments ride the same user message so replay/fork keeps them adjacent
  // to the text the model saw. Malformed rows are skipped, never thrown.
  const pushUserFiles = (attachments: unknown) => {
    if (!Array.isArray(attachments)) return;
    for (const raw of attachments) {
      const a = raw as {
        name?: unknown;
        mime?: unknown;
        path?: unknown;
        url?: unknown;
        range?: unknown;
        kind?: unknown;
        browserContext?: unknown;
      };
      if (a.kind === "browser-context") {
        const ctx = a.browserContext as BrowserContext | undefined;
        if (ctx && typeof ctx === "object" && typeof ctx.url === "string") {
          push("user", { type: "text", text: formatBrowserContextForModel(ctx) });
          const shot = ctx.crop ?? ctx.screenshot;
          if (shot?.localPath && shot.mime.startsWith("image/")) {
            push("user", {
              type: "file",
              name: typeof a.name === "string" ? a.name : "browser-capture",
              mime: shot.mime,
              path: shot.localPath,
            });
          }
        }
        continue;
      }
      if (typeof a?.name !== "string" || typeof a?.mime !== "string") continue;
      const range = Array.isArray(a.range) && a.range.length === 2
        && Number.isSafeInteger(a.range[0]) && Number.isSafeInteger(a.range[1])
        ? [Number(a.range[0]), Number(a.range[1])] as [number, number]
        : undefined;
      push("user", {
        type: "file",
        name: a.name,
        mime: a.mime,
        ...(typeof a.path === "string" ? { path: a.path } : {}),
        ...(typeof a.url === "string" ? { url: a.url } : {}),
        ...(range ? { range } : {}),
      });
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
        const partId = d.partId;
        if (typeof partId === "string" && partId) {
          if (emittedAssistantParts.has(partId)) break;
          emittedAssistantParts.add(partId);
        }
        const text = String(d.text ?? "");
        const reasoning = d.reasoning === undefined ? undefined : String(d.reasoning);
        if (reasoning) push("assistant", { type: "reasoning", text: reasoning });
        // Reasoning-only final records carry text:"" — an empty text part must
        // not become an ordinary answer bubble in model history.
        if (text !== "") pushText("assistant", text);
        break;
      }
      case "tool/call":
        push("assistant", {
          type: "tool-call",
          callId: String(d.callId ?? ""),
          tool: String(d.tool ?? ""),
          input: (d.input as JsonObject) ?? {},
        });
        break;
      case "tool/result":
      case "tool/error":
        push("tool", {
          type: "tool-result",
          callId: String(d.callId ?? ""),
          tool: String(d.tool ?? ""),
          output: String((ev.type === "tool/error" ? d.error : d.output) ?? ""),
          isError: ev.type === "tool/error",
        });
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
      case "package/attached":
      case "package/context": {
        const titleRaw = String(d.title ?? "").trim();
        const title = titleRaw || "Attached context";
        const text = String(d.text ?? "");
        const subtitleRaw = String(d.subtitle ?? "").trim();
        const subtitle = subtitleRaw ? ` (${subtitleRaw})` : "";
        const body = text.trim() ? `${title}${subtitle}\n${text}` : `${title}${subtitle}`;
        if (body.trim()) pushText("user", body);
        break;
      }
    }
  }

  return out;
}

export interface RuntimeEpochRecoveryPlan {
  epoch: number;
  markerSeq: number;
  recoveryContext: string;
  goalRestored: boolean;
  pinnedSourceSeqs: number[];
  omittedMessages: number;
  omittedPins: number;
  omittedKnowledge: number;
  omittedSummaries: number;
  sectionsCapped: string[];
  sectionChars: {
    intent: number;
    durable: number;
    summaries: number;
    dialogue: number;
  };
}

export interface PlanRuntimeEpochRecoveryInput {
  workspace?: import("./continuity.ts").ContinuityWorkspace;
  events: readonly SessionEvent[];
  operations: readonly DurableOperation[];
  heldQueueIds?: ReadonlySet<string>;
  includeWorkflow?: boolean;
  /** Diagnostics may recompute stats after a confirmed restore. */
  includeRestored?: boolean;
  workflow?: {
    objective?: string;
    pinned?: readonly PinnedMessageContext[];
    behavior?: string;
    agent?: string;
  };
}

const UNSAFE_TURN_STATES = new Set(["prepared", "executing", "unknown", "fenced"]);

/** Confirmed, rewind-effective events that may feed epoch recovery. */
export function selectConfirmedEpochRecoveryEvents(input: {
  events: readonly SessionEvent[];
  operations: readonly DurableOperation[];
  heldQueueIds?: ReadonlySet<string>;
  markerSeq: number;
}): SessionEvent[] {
  const heldQueueIds = input.heldQueueIds ?? new Set<string>();
  const epochMarkers = input.events.filter((event) => event.type === "runtime/epoch-replaced");
  const markerSeqs = epochMarkers.map((event) => event.seq);
  const endingMarkerSeq = (eventSeq: number): number | undefined =>
    markerSeqs.find((markerSeq) => markerSeq > eventSeq);
  const unsafeCutByMarker = new Map<number, number>();
  const markUnsafe = (eventSeq: number): void => {
    const endingMarker = endingMarkerSeq(eventSeq);
    if (endingMarker === undefined) return;
    unsafeCutByMarker.set(
      endingMarker,
      Math.min(unsafeCutByMarker.get(endingMarker) ?? eventSeq, eventSeq),
    );
  };
  const operationByOwnerSeq = new Map(
    input.operations
      .filter((operation) => operation.ownerEventSeq !== undefined)
      .map((operation) => [operation.ownerEventSeq!, operation]),
  );
  const orphanUnsafe = input.operations.some((operation) =>
    operation.mutationKind === "turn-submit"
    && UNSAFE_TURN_STATES.has(operation.state)
    && operation.ownerEventSeq === undefined);
  for (const ownerEventSeq of input.operations
    .filter((operation) =>
      operation.mutationKind === "turn-submit"
      && UNSAFE_TURN_STATES.has(operation.state)
      && operation.ownerEventSeq !== undefined)
    .map((operation) => operation.ownerEventSeq!)) {
    markUnsafe(ownerEventSeq);
  }
  for (const event of input.events) {
    if (
      event.type === "user/message"
      && heldQueueIds.has(String((event.data as { queueId?: unknown }).queueId ?? ""))
    ) {
      markUnsafe(event.seq);
    }
    if (
      orphanUnsafe
      && event.type === "user/message"
      && event.seq < input.markerSeq
      && !operationByOwnerSeq.has(event.seq)
    ) {
      markUnsafe(event.seq);
    }
  }
  const effective = effectiveHistory(input.events.filter((event) => event.seq < input.markerSeq)).events;
  return effective
    .filter((event) => {
      const endingMarker = endingMarkerSeq(event.seq);
      const unsafeCut = endingMarker === undefined
        ? undefined
        : unsafeCutByMarker.get(endingMarker);
      return unsafeCut === undefined || event.seq < unsafeCut;
    })
    .filter((event) => {
      const owner = operationByOwnerSeq.get(event.seq);
      return !owner || owner.state === "confirmed";
    })
    .filter((event) => event.type !== "question/asked" && event.type !== "question/answered")
    .map((event) => {
      if (event.type !== "user/message") return event;
      const {
        recoveryContext: _recoveryContext,
        compactionRecovery: _compactionRecovery,
        runtimeEpochRecovery: _runtimeEpochRecovery,
        ...data
      } = event.data as Record<string, unknown>;
      return { ...event, data: data as JsonObject };
    });
}

export function planRuntimeEpochRecovery(
  input: PlanRuntimeEpochRecoveryInput,
): RuntimeEpochRecoveryPlan | null {
  const epochMarkers = input.events.filter((event) => event.type === "runtime/epoch-replaced" || event.type === "session/snapshot-imported");
  const marker = epochMarkers.at(-1);
  if (!marker) return null;
  const snapshot = marker.type === "session/snapshot-imported";
  const epoch = snapshot ? 0 : Number((marker.data as { new?: { epoch?: unknown } }).new?.epoch);
  if (!Number.isSafeInteger(epoch) || (!snapshot && epoch <= 0)) return null;

  const operationByOwnerSeq = new Map(
    input.operations
      .filter((operation) => operation.ownerEventSeq !== undefined)
      .map((operation) => [operation.ownerEventSeq!, operation]),
  );
  const alreadyRestored = input.events.some((event) => {
    if (event.type !== "user/message") return false;
    const metadata = (event.data as {
      runtimeEpochRecovery?: { markerSeq?: unknown; epoch?: unknown };
    }).runtimeEpochRecovery;
    if (Number(metadata?.markerSeq) !== marker.seq || Number(metadata?.epoch) !== epoch) {
      return false;
    }
    return operationByOwnerSeq.get(event.seq)?.state === "confirmed";
  });
  if (alreadyRestored && !input.includeRestored) return null;

  const includeWorkflow = input.includeWorkflow !== false;
  const safeEvents = selectConfirmedEpochRecoveryEvents({
    events: input.events,
    operations: input.operations,
    heldQueueIds: input.heldQueueIds,
    markerSeq: marker.seq,
  });
  const safeSeqs = new Set(safeEvents.map((event) => event.seq));
  const objective = includeWorkflow
    ? (input.workflow?.objective?.trim() || activeObjectiveFromEvents(safeEvents) || undefined)
    : undefined;
  const pinned = includeWorkflow
    ? (input.workflow?.pinned ?? activePinnedMessages(safeEvents))
      .filter((pin) => safeSeqs.has(pin.sourceEventSeq))
    : [];
  const built = buildRuntimeEpochRecoveryContext({
    epoch,
    markerSeq: marker.seq,
    ...(snapshot ? { reason: "snapshot" as const, workspace: input.workspace } : marker.data.reason === "harness-switch" ? { reason: "harness-switch" as const, workspace: input.workspace } : {}),
    dialogue: dialogueFromMessages(deriveMessages(safeEvents)),
    ...(objective ? { objective } : {}),
    pinned,
    ...(input.workflow?.behavior ? { behavior: input.workflow.behavior } : {}),
    ...(input.workflow?.agent ? { agent: input.workflow.agent } : {}),
    knowledge: attachedKnowledge(safeEvents),
    summaries: compactionSummariesFromEvents(safeEvents),
  });
  return {
    epoch,
    markerSeq: marker.seq,
    recoveryContext: built.recoveryContext,
    goalRestored: built.goalRestored,
    pinnedSourceSeqs: built.pinnedSourceSeqs,
    omittedMessages: built.omittedMessages,
    omittedPins: built.omittedPins,
    omittedKnowledge: built.omittedKnowledge,
    omittedSummaries: built.omittedSummaries,
    sectionsCapped: built.sectionsCapped,
    sectionChars: built.sectionChars,
  };
}
