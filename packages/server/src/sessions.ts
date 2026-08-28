// SessionService: canonical session orchestration.
// Runtime events -> appended to durable session log FIRST -> then broadcast/projections.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  AgentProfile, AgentRuntime, AttachmentRef, AutoAcceptSetting, CanonicalEventInput, ChildSnapshotResult, CreateSessionInput, DeliveryMode,
  Disposable, DurableOperation, ForkDraft, ForkResult, JsonObject, MutationOutcome, NotificationRecord,
  PersistedRuntimeBinding,
  InstalledPluginDto, PackageDescriptorDto, QueueItemDto, RuntimeEvent,
  RuntimeEndpoint, RuntimeLifecycleNotification, RuntimeMutationKind, RuntimeObservation,
  RuntimeSessionBinding, RuntimeSnapshot,
  SecretRequestData, SecretResolvedData, SecureSafeKind, SecureSafeService,
  RuntimeSession, SendResult, SessionDebugDto, SessionEvent, SessionFolderDto, SessionForkedData, SessionOrganizePatch, SessionProjection, SessionRef,
  SessionService, SessionPersistence, UserTurnInput,
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { AutoAcceptStore, PermissionService } from "@polyth/permissions";
import { resolveAutoAccept } from "@polyth/permissions";
import {
  activeRewind,
  deriveMessages,
  effectiveHistory,
  recoveredUserText,
  type Store as DurableSessionStore,
} from "@polyth/session";
import { buildPermissionPreview, PERMISSION_ALLOWED_SCOPES } from "./permissionPreview.ts";
import { sanitizeAttachments } from "./attachments.ts";
import { settleAllOrThrow } from "./settle.ts";

export interface Broadcaster {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
  /** NTF-01: unfiltered notification-centre fan-out. Optional so existing
   *  fakes stay valid; inbox records never pass through appendAndBroadcast
   *  or any session reducer. */
  notification?(record: NotificationRecord): void;
  pluginChanged?(plugin: InstalledPluginDto): void;
  packageChanged?(pkg: PackageDescriptorDto): void;
}

/** Durable FIFO delivery queue (implemented by @polyth/session's Store). */
export interface QueueStore {
  enqueue(sessionId: string, text: string, delivery: DeliveryMode, attachments?: AttachmentRef[]): Promise<QueueItemDto>;
  queueList(sessionId: string): Promise<QueueItemDto[]>;
  queueEdit(sessionId: string, queueId: string, text: string): Promise<QueueItemDto | undefined>;
  queueReorder(sessionId: string, ids: string[]): Promise<QueueItemDto[]>;
  queueRemove(sessionId: string, queueId: string): Promise<boolean>;
  reserveQueueHead(input: {
    sessionId: string;
    mutationKind?: "turn-submit" | "turn-steer";
  }): ReturnType<DurableSessionStore["reserveQueueHead"]>;
  confirmQueueReservation(
    operationId: string,
    receipt?: string,
  ): ReturnType<DurableSessionStore["confirmQueueReservation"]>;
  releaseQueueReservation(
    operationId: string,
    settlement:
      | { kind: "rejected"; code: string; message: string }
      | { kind: "not-applied"; code?: string; message: string },
  ): ReturnType<DurableSessionStore["releaseQueueReservation"]>;
}

export interface RuntimePool {
  /** `cwd` overrides the project root — that is how worktree sessions are isolated. */
  forProject(projectId: string, cwd?: string): Promise<AgentRuntime>;
  /** Restart all currently live runtime facades in place. */
  restartAll?(): Promise<number>;
  /** Generation replacement notification. Resolves only after every wired
   * session listener has finished its admission-barrier reconciliation. */
  onRestart?(listener: (runtime: AgentRuntime) => Promise<void>): Disposable;
}

export interface RuntimeRestartFingerprint {
  authorityId: string;
  generation: number;
}

export type RuntimeRestartSafety =
  | { safe: true }
  | { safe: false; reason: string };

export interface RestartSafetySessionService extends SessionService {
  /** Force fresh authoritative status evidence for one affected binding.
   * Callers hold the global admission barrier for this method's lifetime. */
  reconcileForRuntimeRestart(
    sessionId: string,
    runtime: AgentRuntime,
    expected: RuntimeRestartFingerprint,
  ): Promise<RuntimeRestartSafety>;
}

type RuntimeDurability = Pick<
  DurableSessionStore,
  | "prepareOperation"
  | "prepareSessionCreate"
  | "operation"
  | "operations"
  | "queueReservation"
  | "claimOperation"
  | "settleOperation"
  | "chooseResponseIntent"
  | "responseIntent"
  | "settleResponseIntent"
  | "ingestObservation"
  | "ingestSnapshot"
  | "observationCheckpoint"
  | "observationCursor"
  | "startReconciliation"
  | "reconciliation"
  | "settleReconciliation"
  | "prepareSessionDeletion"
  | "deletionTombstone"
  | "hasDeletionTombstone"
  | "retireDeletionTombstone"
>;

type ReliabilityRuntime = AgentRuntime & {
  endpoint?(): Promise<RuntimeEndpoint>;
  protocol?(): Promise<"legacy" | "v2">;
  reconcile?(
    binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
    after?: string,
  ): Promise<RuntimeSnapshot>;
};

/** Organization seams implemented by @polyth/session's Store (WP5). */
export interface OrgStore {
  folderList(projectId: string): Promise<SessionFolderDto[]>;
  attentionFor(sessionIds: string[]): Promise<Record<string, { questions: number; permissions: number }>>;
}

/** Workflow hooks (goals today, multirun/review later) — plugins observe turns
 *  through this seam instead of reaching into the backend loop. */
export interface TurnHooks {
  onTurnCompleted?(sessionId: string, assistantText: string): void;
  onUsage?(sessionId: string, tokens: { input: number; output: number; reasoning?: number }): void;
  /** Decorate the next admitted turn after compaction. The returned context is
   *  persisted on user/message before it is sent to the runtime. */
  beforeTurn?(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<{
    recoveryContext: string;
    compactionSeq: number;
    goalRestored: boolean;
    pinnedSourceSeqs: number[];
  } | null>;
}

/** Slash-command / snippet expansion seam. The commands plugin owns the syntax;
 *  the session service only knows "text may be rewritten before the model sees it". */
export type ExpandInput = (
  projectId: string,
  text: string,
) => Promise<{ text: string; raw: string; agent?: string; model?: { providerID: string; modelID: string } }>;

export function createSessionService(deps: {
  store: SessionPersistence;
  projects: ProjectService;
  permissions: PermissionService;
  runtimes: RuntimePool;
  broadcast: Broadcaster;
  /** Config/runtime replacement admission gate. `admit` atomically joins the
   * active-admission set or rejects while an exclusive restart is fenced. */
  admission?: {
    fenced(): boolean;
    admit<T>(action: () => Promise<T>): Promise<T>;
  };
  hooks?: TurnHooks;
  expand?: ExpandInput;
  queue?: QueueStore;
  org?: OrgStore;
  /** Authoritative git worktree inventory used to validate session cwd overrides. */
  worktrees?: {
    list(root: string): Promise<Array<{ path: string; branch: string | null }>>;
  };
  /** Agent-profile lookup (WP8) — profiles resolve to explicit model/agent at send time. */
  profiles?: { profileGet(id: string): Promise<AgentProfile | undefined> };
  /** Global behavior instructions (WP9): revision+digest logged before a turn
   *  starts under a newly applied revision, keeping replay reproducible. */
  behavior?: { current(): Promise<{ revision: string; digest: string } | null> };
  /** Server-only credential vault. Values enter through replySecret and never
   *  enter session events, runtime question metadata, or public DTOs. */
  secureSafe?: SecureSafeService;
  /** Bounded composer-shell executor backed by @polyth/terminal. */
  shell?: {
    run(
      input: { projectId: string; cwd: string; cmd: string },
      opts?: { timeoutMs?: number; maxOutputBytes?: number },
    ): Promise<{ output: string; exitCode: number | null; timedOut: boolean; truncated: boolean }>;
  };
  /** Attachment existence/size verification against the session's file root (F2).
   *  `stat` must reject paths escaping the root; `maxBytes` reuses the upload cap. */
  attachments?: {
    stat(root: string, rel: string): Promise<{ kind: "file" | "dir"; size: number }>;
    maxBytes: number;
  };
  /** F18: per-session auto-accept policy store (nearest-parent resolution). */
  autoAccept?: AutoAcceptStore;
  /** F18: human-needed / turn-ended signals for out-of-page delivery (web
   *  push). Fired only when a card actually reaches the UI — auto-accepted
   *  permissions never notify. */
  notify?: {
    attention(sessionId: string, kind: "permission" | "question", requestId?: string, questions?: JsonObject[]): void;
    turnStopped(sessionId: string, reason: "completed" | "aborted" | "error"): void;
  };
}): RestartSafetySessionService {
  const { store, projects, permissions, runtimes, broadcast } = deps;
  const durable = store as SessionPersistence & RuntimeDurability;
  const requiredDurableMethods: Array<keyof RuntimeDurability> = [
    "prepareOperation",
    "prepareSessionCreate",
    "operation",
    "operations",
    "queueReservation",
    "claimOperation",
    "settleOperation",
    "chooseResponseIntent",
    "responseIntent",
    "settleResponseIntent",
    "ingestObservation",
    "ingestSnapshot",
    "observationCheckpoint",
    "observationCursor",
    "startReconciliation",
    "reconciliation",
    "settleReconciliation",
    "prepareSessionDeletion",
    "deletionTombstone",
    "hasDeletionTombstone",
    "retireDeletionTombstone",
  ];
  for (const method of requiredDurableMethods) {
    if (typeof durable[method] !== "function") {
      throw new Error(`session persistence is missing durable runtime API: ${method}`);
    }
  }
  const hooks = deps.hooks ?? {};
  const sessionRuntime = new Map<string, AgentRuntime>(); // sessionId -> runtime
  // One onEvent subscription per runtime (not per session): events dispatch
  // through sessionRuntime, so wiring N sessions to a runtime costs a single
  // listener that unwire() disposes once the last session leaves it.
  const runtimeSubs = new Map<AgentRuntime, Disposable[]>();
  const lastTurnId = new Map<string, string>();           // sessionId -> active turnId
  // sessions whose turn admission is in flight (startTurn sent, turn/started
  // not yet observed) — a concurrent send must treat these as active
  const admitting = new Set<string>();
  // Composer edits are short-lived, server-owned holds. Without this, a turn
  // completing while the user edits the queue head can dispatch and delete the
  // row before the edit is saved. Holds expire so a closed browser never
  // stalls delivery indefinitely.
  const queueEditHolds = new Map<string, Map<string, number>>();
  const QUEUE_EDIT_HOLD_MS = 10 * 60_000;
  const releaseQueueEditHold = (sessionId: string, queueId: string): void => {
    const holds = queueEditHolds.get(sessionId);
    if (!holds) return;
    holds.delete(queueId);
    if (holds.size === 0) queueEditHolds.delete(sessionId);
  };
  const queueEditHeld = (sessionId: string, queueId: string): boolean => {
    const holds = queueEditHolds.get(sessionId);
    const expiresAt = holds?.get(queueId);
    if (!expiresAt) return false;
    if (expiresAt > Date.now()) return true;
    releaseQueueEditHold(sessionId, queueId);
    return false;
  };
  const behaviorLogged = new Map<string, string>(); // sessionId -> behavior revision already in the log
  // sessionId -> parts of the current turn's assistant reply, keyed by partId in
  // arrival order. Models may finalize parts out of order (a reasoning-as-text
  // part can land after the answer), so workflows get the whole turn, not "the
  // last part that happened to close".
  const turnReply = new Map<string, Map<string, string>>();
  const replyText = (sessionId: string): string =>
    [...(turnReply.get(sessionId)?.values() ?? [])].filter((t) => t.trim()).join("\n\n");
  // The web preference arrives with the first prompt. Keep that intent until
  // OpenCode publishes the semantic title it generated from the prompt.
  const autoTitleRequested = new Set<string>();

  const broadcastTail = async <T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    const afterSeq = await store.latestSeq(sessionId);
    const result = await action();
    for (const event of await store.events(sessionId, afterSeq)) broadcast.event(event);
    return result;
  };

  const isMutationOutcome = <T,>(value: unknown): value is MutationOutcome<T> => {
    if (!value || typeof value !== "object") return false;
    const kind = (value as { kind?: unknown }).kind;
    return kind === "confirmed" || kind === "rejected" || kind === "unknown";
  };

  const knownRejection = (error: unknown): { code: string; message: string } | null => {
    const code = typeof error === "object" && error !== null
      && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
    if (!["invalid-input", "unsupported", "not-found", "conflict", "history-mismatch"].includes(code)) {
      return null;
    }
    return {
      code,
      message: error instanceof Error ? error.message : "runtime rejected the mutation",
    };
  };

  const RUNTIME_AWAIT_MS = 30_000;
  const boundedRuntimeAwait = async <T,>(
    promise: Promise<T>,
    operationId: string,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(
              new Error(`runtime operation ${operationId} exceeded ${RUNTIME_AWAIT_MS}ms`),
              { code: "runtime-timeout" },
            ));
          }, RUNTIME_AWAIT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const claimOperation = async (operation: DurableOperation): Promise<void> => {
    const claim = await broadcastTail(
      operation.sessionId,
      () => durable.claimOperation(operation.operationId),
    );
    if (claim.kind !== "claimed") {
      throw Object.assign(new Error(`operation is already ${claim.operation?.state ?? "unavailable"}`), {
        code: "conflict",
        operationId: operation.operationId,
      });
    }
  };

  const settleOperation = async <T,>(
    operation: DurableOperation,
    outcome: MutationOutcome<T>,
  ): Promise<void> => {
    if (outcome.kind === "confirmed") {
      await broadcastTail(operation.sessionId, () => durable.settleOperation(operation.operationId, {
        kind: "confirmed",
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      }));
      return;
    }
    if (outcome.kind === "rejected") {
      await broadcastTail(operation.sessionId, () => durable.settleOperation(operation.operationId, {
        kind: "rejected",
        code: outcome.code,
        message: outcome.message,
      }));
      return;
    }
    await broadcastTail(operation.sessionId, () => durable.settleOperation(operation.operationId, {
      kind: "unknown",
      code: "runtime-outcome-unknown",
      message: outcome.message,
    }));
  };

  /** One claim and exactly one runtime call. Legacy runtime values are
   * confirmed responses; thrown failures are conservative unknowns unless the
   * facade supplies a typed, operation-specific non-application rejection. */
  const runPreparedOperation = async <T, R>(
    operation: DurableOperation,
    call: (operationId: string) => Promise<R | MutationOutcome<T>>,
    confirmed: (value: R) => T,
    settle: (outcome: MutationOutcome<T>) => Promise<void> = (outcome) =>
      settleOperation(operation, outcome),
  ): Promise<MutationOutcome<T>> => {
    await claimOperation(operation);
    let outcome: MutationOutcome<T>;
    try {
      const value = await boundedRuntimeAwait(
        call(operation.operationId),
        operation.operationId,
      );
      outcome = isMutationOutcome<T>(value)
        ? value
        : { kind: "confirmed", value: confirmed(value as R) };
    } catch (error) {
      const rejected = knownRejection(error);
      outcome = rejected
        ? { kind: "rejected", ...rejected }
        : {
            kind: "unknown",
            operationId: operation.operationId,
            message: "the runtime did not provide a definitive mutation outcome",
          };
    }
    await settle(outcome);
    return outcome;
  };

  const outcomeError = <T,>(outcome: Exclude<MutationOutcome<T>, { kind: "confirmed" }>): Error => {
    if (outcome.kind === "rejected") {
      return Object.assign(new Error(outcome.message), {
        code: outcome.code,
      });
    }
    return Object.assign(new Error("upstream outcome is unknown; reconciliation is required"), {
      code: "outcome-unknown",
      operationId: outcome.operationId,
    });
  };

  const blockingOperation = async (
    sessionId: string,
    exceptOperationId?: string,
  ): Promise<DurableOperation | undefined> =>
    (await durable.operations(sessionId)).find((operation) =>
      operation.operationId !== exceptOperationId
      && (operation.state === "prepared" || operation.state === "executing" || operation.state === "unknown"));

  const isPlaceholderTitle = (title: string, sessionId: string): boolean => {
    const value = title.trim().toLowerCase();
    return value === "" || value === "new session" || value === "untitled session"
      || value === "untitled" || value === "(untitled)" || value === "(untitled session)"
      || /^new session - \d{4}-\d{2}-\d{2}t/.test(value)
      || title.trim() === sessionId || title.trim().startsWith("ses_") || /^[0-9a-f-]{8,}$/i.test(title.trim());
  };

  const secureSafeKind = (value: unknown): SecureSafeKind | undefined =>
    value === "env" || value === "token" || value === "password" ? value : undefined;

  const secureRequest = (requestId: string, question: JsonObject): SecretRequestData | null => {
    const raw = question as Record<string, unknown>;
    const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? raw.metadata as Record<string, unknown>
      : {};
    const marked = metadata.secureSafe === true || raw.type === "secure_safe";
    const handle = typeof raw.handle === "string"
      ? raw.handle.trim()
      : typeof metadata.handle === "string" ? metadata.handle.trim() : "";
    const label = typeof raw.label === "string"
      ? raw.label.trim()
      : typeof metadata.label === "string" ? metadata.label.trim() : "";
    if (!marked || !handle || !label) return null;
    const purpose = typeof raw.purpose === "string"
      ? raw.purpose.trim()
      : typeof metadata.purpose === "string" ? metadata.purpose.trim() : "";
    const requestedKind = secureSafeKind(raw.kind) ?? secureSafeKind(metadata.kind);
    return {
      requestId,
      handle,
      label,
      ...(purpose ? { purpose } : {}),
      ...(requestedKind ? { kind: requestedKind } : {}),
      existing: deps.secureSafe?.hasHandle(handle) ?? false,
    };
  };

  // UX-MSG-ACTIONS: one per-canonical-session promise chain. Runtime callbacks
  // are applied in arrival order (never as unobserved parallel calls) and
  // Revert/Fork validation + publication run under the same serialization, so
  // an apparently idle message row can never race a newly admitted turn.
  // A failed link is logged and contained without breaking the chain.
  const chains = new Map<string, Promise<void>>();
  const withSessionLock = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    chains.set(sessionId, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (chains.get(sessionId) === current) chains.delete(sessionId);
    }
  };

  const appendAndBroadcast = async (
    sessionId: string, type: string, data: JsonObject,
    opts?: Parameters<SessionPersistence["append"]>[3],
  ): Promise<SessionEvent> => {
    const ev = await store.append(sessionId, type, data, opts);
    broadcast.event(ev);
    return ev;
  };

  // ---------------------------------------------------------------- log facts
  // Derived per-session facts (open requests, rewind marker, error tail, log
  // shape) folded incrementally from the durable log. Every read first folds
  // the tail appended since the last fold — an indexed, usually-empty query —
  // so hot paths (send, permission replies, debug) never replay whole logs.
  // Correctness holds because the log is append-only per session and other
  // plugins' appends are picked up by the same tail read.
  interface LogFacts {
    seq: number;
    eventCount: number;
    lastEvent?: { seq: number; time: number; type: string };
    requestedPermissions: Set<string>;
    askedQuestions: Set<string>;
    requestedSecrets: Set<string>;
    openPermissions: Map<string, SessionEvent>;
    openQuestions: Map<string, SessionEvent>;
    openSecrets: Map<string, SessionEvent>;
    rewind: { markerSeq: number; atSeq: number } | null;
    recentErrors: SessionDebugDto["recentErrors"];
  }

  const FACTS_CACHE_MAX = 256;
  const factsCache = new Map<string, LogFacts>();

  const emptyFacts = (): LogFacts => ({
    seq: 0,
    eventCount: 0,
    requestedPermissions: new Set(),
    askedQuestions: new Set(),
    requestedSecrets: new Set(),
    openPermissions: new Map(),
    openQuestions: new Map(),
    openSecrets: new Map(),
    rewind: null,
    recentErrors: [],
  });

  const foldFacts = (facts: LogFacts, events: readonly SessionEvent[]): void => {
    for (const ev of events) {
      if (ev.seq <= facts.seq) continue;
      facts.seq = ev.seq;
      facts.eventCount += 1;
      facts.lastEvent = { seq: ev.seq, time: ev.time, type: ev.type };
      const data = ev.data as Record<string, unknown>;
      const rid = typeof data.requestId === "string" && data.requestId ? data.requestId : undefined;
      switch (ev.type) {
        case "permission/requested":
          if (rid) { facts.requestedPermissions.add(rid); facts.openPermissions.set(rid, ev); }
          break;
        case "permission/resolved":
          if (rid) facts.openPermissions.delete(rid);
          break;
        case "question/asked":
          if (rid) { facts.askedQuestions.add(rid); facts.openQuestions.set(rid, ev); }
          break;
        case "question/answered":
          if (rid) facts.openQuestions.delete(rid);
          break;
        case "secret/requested":
          if (rid) { facts.requestedSecrets.add(rid); facts.openSecrets.set(rid, ev); }
          break;
        case "secret/resolved":
          if (rid) facts.openSecrets.delete(rid);
          break;
        case "session/rewound": {
          const atSeq = Number(data.atSeq);
          if (Number.isSafeInteger(atSeq) && atSeq > 0) facts.rewind = { markerSeq: ev.seq, atSeq };
          break;
        }
        case "session/rewind-cleared": {
          if (!facts.rewind) break;
          const rewindSeq = Number(data.rewindSeq);
          if (!Number.isSafeInteger(rewindSeq) || rewindSeq === facts.rewind.markerSeq) facts.rewind = null;
          break;
        }
      }
      const failedStop = ev.type === "turn/stopped" && data.reason === "error";
      const failedType = ev.type === "turn/failed" || ev.type === "tool/error" || ev.type.endsWith("/failed");
      if (failedStop || failedType) {
        const raw = data.error ?? data.message ?? data.reason ?? "unknown error";
        facts.recentErrors.push({
          seq: ev.seq, time: ev.time, type: ev.type,
          message: typeof raw === "string" ? raw : JSON.stringify(raw),
        });
        if (facts.recentErrors.length > 20) facts.recentErrors.splice(0, facts.recentErrors.length - 20);
      }
    }
  };

  const logFacts = async (sessionId: string): Promise<LogFacts> => {
    let facts = factsCache.get(sessionId);
    if (facts) factsCache.delete(sessionId); // re-insert for LRU recency
    else facts = emptyFacts();
    factsCache.set(sessionId, facts);
    if (factsCache.size > FACTS_CACHE_MAX) {
      const oldest = factsCache.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) factsCache.delete(oldest);
    }
    const tail = await store.events(sessionId, facts.seq);
    if (tail.length > 0) foldFacts(facts, tail);
    return facts;
  };

  const openRequestTotal = (facts: LogFacts): number =>
    facts.openPermissions.size + facts.openQuestions.size + facts.openSecrets.size;

  // Projection patches operate on the latest committed row (one store
  // transaction when the store supports it) and broadcast the exact committed
  // projection — a callback can no longer read, await, and then overwrite
  // fields a later callback already changed.
  const applyProjection = async (
    sessionId: string, patch: (current: SessionProjection) => SessionProjection,
  ): Promise<SessionProjection | undefined> => {
    let next: SessionProjection | undefined;
    if (store.patchProjection) {
      next = await store.patchProjection(sessionId, patch);
    } else {
      const current = await store.projection(sessionId);
      if (!current) return undefined;
      next = patch(current);
      await store.upsertProjection(next);
    }
    if (next) broadcast.projection(next);
    return next;
  };

  const updateProjection = async (sessionId: string, patch: Partial<SessionProjection>) => {
    await applyProjection(sessionId, (current) => ({ ...current, ...patch, updatedAt: Date.now() }));
  };

  const applyRuntimeProjection = async (
    sessionId: string,
    runtimeEventSeq: number | undefined,
    patch: (current: SessionProjection) => SessionProjection,
  ): Promise<boolean> => {
    let applied = false;
    await applyProjection(sessionId, (current) => {
      if (
        runtimeEventSeq !== undefined
        && (current.runtimeObservationSeq ?? 0) >= runtimeEventSeq
      ) {
        return current;
      }
      applied = true;
      const next = patch(current);
      return runtimeEventSeq === undefined
        ? next
        : { ...next, runtimeObservationSeq: runtimeEventSeq };
    });
    return applied;
  };

  const newRuntimeBinding = async (
    runtime: AgentRuntime,
    backendSessionId: string,
    cwd: string,
    historyBaseline: PersistedRuntimeBinding["historyBaseline"],
  ): Promise<PersistedRuntimeBinding> => {
    const endpoint = await (runtime as ReliabilityRuntime).endpoint?.();
    if (!endpoint) {
      return {
        backendSessionId,
        authorityId: `legacy:unmanaged:${cwd}`,
        generation: 0,
        continuity: "generation-only",
        protocol: "legacy",
        location: { directory: cwd },
        ...(historyBaseline ? { historyBaseline } : {}),
      };
    }
    return {
      backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      protocol: await (runtime as ReliabilityRuntime).protocol?.() ?? "legacy",
      location: endpoint.location,
      ...(historyBaseline ? { historyBaseline } : {}),
    };
  };

  const runtimeBinding = async (
    rt: AgentRuntime,
    proj: SessionProjection,
    cwd: string,
  ): Promise<RuntimeSessionBinding | undefined> => {
    if (!proj.backendSessionId) return undefined;
    const endpoint = await (rt as ReliabilityRuntime).endpoint?.();
    if (endpoint) {
      const protocol = await (rt as ReliabilityRuntime).protocol?.()
        ?? proj.runtimeBinding?.protocol
        ?? "legacy";
      const persisted = proj.runtimeBinding;
      if (persisted) {
        const sameIdentity =
          persisted.backendSessionId === proj.backendSessionId
          && persisted.authorityId === endpoint.authorityId
          && persisted.protocol === protocol
          && persisted.location.directory === endpoint.location.directory
          && (persisted.location.workspace ?? "") === (endpoint.location.workspace ?? "");
        if (!sameIdentity) {
          throw Object.assign(
            new Error("persisted backend binding does not match the current endpoint"),
            { code: "binding-mismatch" },
          );
        }
        if (
          persisted.generation !== endpoint.generation
          && endpoint.control.kind !== "owned"
          && (persisted.continuity !== "verified" || endpoint.continuity !== "verified")
        ) {
          throw Object.assign(
            new Error("backend session binding cannot cross an unverified endpoint generation"),
            { code: "binding-mismatch" },
          );
        }
        // A durable owned authority identifies one logical runtime across
        // Polyth process lifetimes. Rebind its exact backend session ID to the
        // current generation before ensure/reconcile; generation-only
        // continuity still makes terminal evidence conservative, while the
        // runtime lifecycle continues to fence old callbacks and bindings.
      }
      const currentBinding = {
        backendSessionId: proj.backendSessionId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: endpoint.continuity,
        protocol,
        location: endpoint.location,
        ...(persisted?.historyBaseline
          ? { historyBaseline: persisted.historyBaseline }
          : {}),
      };
      if (
        !persisted
        || persisted.generation !== currentBinding.generation
        || persisted.continuity !== currentBinding.continuity
      ) {
        await applyProjection(proj.id, (current) => ({
          ...current,
          runtimeBinding: currentBinding,
          updatedAt: Date.now(),
        }));
      }
      return {
        canonicalSessionId: proj.id,
        backendSessionId: proj.backendSessionId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: endpoint.continuity,
        location: endpoint.location,
      };
    }
    const compatibilityBinding = proj.runtimeBinding ?? {
      backendSessionId: proj.backendSessionId,
      authorityId: `legacy:${proj.projectId}:${cwd}`,
      generation: 0,
      continuity: "generation-only" as const,
      protocol: "legacy" as const,
      location: { directory: cwd },
    };
    if (!proj.runtimeBinding) {
      await applyProjection(proj.id, (current) => ({
        ...current,
        runtimeBinding: compatibilityBinding,
        updatedAt: Date.now(),
      }));
    }
    return {
      canonicalSessionId: proj.id,
      backendSessionId: proj.backendSessionId,
      authorityId: compatibilityBinding.authorityId,
      generation: compatibilityBinding.generation,
      continuity: compatibilityBinding.continuity,
      location: compatibilityBinding.location,
    };
  };

  const canonicalRuntimeEvent = (event: RuntimeEvent): {
    artifactKind: "message" | "part" | "tool" | "permission" | "question" | "status" | "turn";
    events: Array<{ type: string; data: JsonObject; ignorable?: boolean }>;
  } => {
    const { type, ...data } = event;
    if (event.type === "permission/requested") {
      return {
        artifactKind: "permission",
        events: [{
          type,
          data: {
            ...(data as unknown as JsonObject),
            preview: buildPermissionPreview({
              permission: event.permission,
              patterns: event.patterns,
              ...(event.metadata ? { metadata: event.metadata } : {}),
              ...(event.tool ? { tool: event.tool } : {}),
            }) as unknown as JsonObject,
            allowedScopes: [...PERMISSION_ALLOWED_SCOPES],
          },
          ignorable: true,
        }],
      };
    }
    if (event.type === "question/asked" || event.type === "secret/requested") {
      return {
        artifactKind: "question",
        events: [{ type, data: data as unknown as JsonObject, ignorable: true }],
      };
    }
    if (event.type === "turn/started" || event.type === "turn/stopped") {
      return {
        artifactKind: "turn",
        events: [{ type, data: data as unknown as JsonObject, ignorable: true }],
      };
    }
    if (event.type.startsWith("tool/")) {
      return { artifactKind: "tool", events: [{ type, data: data as unknown as JsonObject }] };
    }
    if (event.type === "assistant/chunk" || event.type === "assistant/reasoning-chunk") {
      return { artifactKind: "part", events: [{ type, data: data as unknown as JsonObject }] };
    }
    return {
      artifactKind: "message",
      events: [{
        type,
        data: data as unknown as JsonObject,
        ...(event.type === "usage/recorded"
          || event.type === "session/title-generated"
          || event.type === "session/compacted"
          || event.type === "compaction/part-recorded"
          ? { ignorable: true }
          : {}),
      }],
    };
  };

  const settleProvenOperationNonapplications = async (
    sessionId: string,
    snapshot: RuntimeSnapshot,
    facts: LogFacts,
  ): Promise<void> => {
    for (const evidence of snapshot.nonAppliedOperations ?? []) {
      if (evidence.backendSessionId && evidence.backendSessionId !== snapshot.backendSessionId) {
        continue;
      }
      const operation = await durable.operation(evidence.operationId);
      if (
        !operation
        || operation.sessionId !== sessionId
        || operation.state !== "unknown"
        || operation.mutationKind !== evidence.mutationKind
      ) {
        continue;
      }
      const settlement = {
        kind: "not-applied" as const,
        code: "protocol-nonapplication-proof",
        message: "the runtime supplied protocol-proven evidence that the operation was not applied",
      };
      const reservation = await durable.queueReservation(operation.operationId);
      if (reservation) {
        await broadcastTail(sessionId, () =>
          deps.queue!.releaseQueueReservation(operation.operationId, settlement));
        continue;
      }

      const response:
        | { kind: "permission" | "question" | "secret"; requestIds: Iterable<string> }
        | undefined =
        operation.mutationKind === "permission-reply"
          ? { kind: "permission", requestIds: facts.openPermissions.keys() }
          : operation.mutationKind === "question-reply"
              || operation.mutationKind === "question-reject"
            ? { kind: "question", requestIds: facts.openQuestions.keys() }
            : operation.mutationKind === "secret-reply"
              ? { kind: "secret", requestIds: facts.openSecrets.keys() }
              : undefined;
      let settledResponse = false;
      if (response) {
        for (const requestId of response.requestIds) {
          if (evidence.requestId && evidence.requestId !== requestId) continue;
          const intent = await durable.responseIntent(
            sessionId,
            response.kind,
            requestId,
          );
          if (intent?.operationId !== operation.operationId) continue;
          await broadcastTail(sessionId, () => durable.settleResponseIntent(
            operation.operationId,
            settlement,
          ));
          settledResponse = true;
          break;
        }
        if (!settledResponse) continue;
      }
      if (!response) {
        await broadcastTail(sessionId, () =>
          durable.settleOperation(operation.operationId, settlement));
      }
    }
  };

  const settleAcceptedOperations = async (
    sessionId: string,
    snapshot: RuntimeSnapshot,
    facts: LogFacts,
  ): Promise<void> => {
    for (const evidence of snapshot.acceptedOperations ?? []) {
      if (evidence.backendSessionId && evidence.backendSessionId !== snapshot.backendSessionId) {
        continue;
      }
      const operation = await durable.operation(evidence.operationId);
      if (
        !operation
        || operation.sessionId !== sessionId
        || operation.state !== "unknown"
        || operation.mutationKind !== evidence.mutationKind
      ) {
        continue;
      }

      const reservation = await durable.queueReservation(operation.operationId);
      if (reservation) {
        await broadcastTail(sessionId, () =>
          deps.queue!.confirmQueueReservation(operation.operationId, evidence.receipt));
        continue;
      }

      let settledResponse = false;
      const responseCandidates: Array<{
        kind: "permission" | "question" | "secret";
        requestIds: Iterable<string>;
      }> = [
        { kind: "permission", requestIds: facts.openPermissions.keys() },
        { kind: "question", requestIds: facts.openQuestions.keys() },
        { kind: "secret", requestIds: facts.openSecrets.keys() },
      ];
      for (const candidate of responseCandidates) {
        for (const requestId of candidate.requestIds) {
          const intent = await durable.responseIntent(sessionId, candidate.kind, requestId);
          if (intent?.operationId !== operation.operationId) continue;
          const completionEvent: CanonicalEventInput = candidate.kind === "permission"
            ? {
                type: "permission/resolved",
                data: {
                  requestId,
                  reply: String(intent.payload.reply ?? "once"),
                  ...(intent.payload.auto === true ? { auto: true } : {}),
                },
                ignorable: true,
              }
            : candidate.kind === "question"
              ? {
                  type: "question/answered",
                  data: {
                    requestId,
                    answers: (intent.payload.answers ?? {}) as JsonObject,
                  },
                  ignorable: true,
                }
              : {
                  type: "secret/resolved",
                  data: {
                    requestId,
                    action: String(intent.payload.action ?? "dismiss"),
                    ...(typeof intent.payload.handle === "string"
                      ? { handle: intent.payload.handle }
                      : {}),
                  },
                  ignorable: true,
                };
          await broadcastTail(sessionId, () => durable.settleResponseIntent(
            operation.operationId,
            {
              kind: "confirmed",
              ...(evidence.receipt ? { receipt: evidence.receipt } : {}),
              completionEvent,
            },
          ));
          settledResponse = true;
          break;
        }
        if (settledResponse) break;
      }
      if (settledResponse) continue;

      await broadcastTail(sessionId, () => durable.settleOperation(
        operation.operationId,
        {
          kind: "confirmed",
          ...(evidence.receipt ? { receipt: evidence.receipt } : {}),
        },
      ));
    }
  };

  const stateComparison = (
    value: unknown,
  ): { domain: string; order: number } | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const comparison = (value as { comparison?: unknown }).comparison;
    if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) {
      return undefined;
    }
    const { domain, order } = comparison as { domain?: unknown; order?: unknown };
    return typeof domain === "string"
      && domain.length > 0
      && typeof order === "number"
      && Number.isFinite(order)
      ? { domain, order }
      : undefined;
  };

  const causalTerminalStateIsAuthoritative = async (
    sessionId: string,
    snapshot: RuntimeSnapshot,
    operationId: string,
  ): Promise<boolean> => {
    const operation = await durable.operation(operationId);
    if (
      !operation
      || operation.state !== "confirmed"
      || operation.receipt !== snapshot.backendSessionId
    ) {
      return false;
    }
    let related = operation.sessionId === sessionId
      && (
        operation.mutationKind === "session-create"
        || operation.mutationKind === "session-reset"
        || operation.mutationKind === "session-revert"
      );
    if (!related && operation.mutationKind === "session-fork" && operation.ownerEventSeq) {
      const owner = (await store.events(operation.sessionId))
        .find((event) => event.seq === operation.ownerEventSeq);
      related = owner?.type === "session/fork-intended"
        && (owner.data as { childSessionId?: unknown }).childSessionId === sessionId;
    }
    if (!related) return false;

    // The receipt proves only the state immediately created by this operation.
    // Fork ordinals belong to the source session and are not comparable with
    // child ordinals, so any child mutation invalidates a fork receipt.
    const targetOperations = await durable.operations(sessionId);
    return operation.sessionId === sessionId
      ? !targetOperations.some((candidate) => candidate.ordinal > operation.ordinal)
      : targetOperations.length === 0;
  };

  const authoritativeSnapshotState = async (
    sessionId: string,
    snapshot: RuntimeSnapshot,
    binding: RuntimeSessionBinding,
    projection: SessionProjection | undefined,
  ): Promise<RuntimeSnapshot["state"]> => {
    const state = snapshot.state;
    if (state.value === "running") return state;
    if (
      state.value === "unknown"
      && projection?.runtimeBinding?.historyBaseline === "empty"
    ) {
      const operations = await durable.operations(sessionId);
      const create = operations.find((operation) =>
        operation.mutationKind === "session-create"
        && operation.state === "confirmed"
        && operation.receipt === snapshot.backendSessionId);
      if (
        create
        && !operations.some((candidate) => candidate.ordinal > create.ordinal)
      ) {
        return { value: "idle", causalOperationId: create.operationId };
      }
    }
    if (state.value === "unknown") return state;
    const prior = await durable.observationCheckpoint({
      authorityId: binding.authorityId,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      artifactKind: "status",
      entityId: binding.backendSessionId!,
    });
    if (state.value === "idle" && state.causalOperationId) {
      const sameDurableCause = !prior
        || (
          prior.value.state === "idle"
          && prior.value.causalOperationId === state.causalOperationId
        );
      if (
        sameDurableCause
        && await causalTerminalStateIsAuthoritative(
          sessionId,
          snapshot,
          state.causalOperationId,
        )
      ) {
        return state;
      }
      return { value: "unknown" };
    }

    const next = state.comparison;
    if (!next) return { value: "unknown" };
    if (!prior) return state;
    const previous = stateComparison(prior.value);
    if (!previous) {
      return prior.value.causalOperationId ? state : { value: "unknown" };
    }
    if (previous.domain !== next.domain || next.order < previous.order) {
      return { value: "unknown" };
    }
    if (
      next.order === previous.order
      && prior.value.state !== state.value
    ) {
      return { value: "unknown" };
    }
    return state;
  };

  const reconcileFlights = new Map<string, Promise<void>>();
  const reconcileSession = (
    sessionId: string,
    proj: SessionProjection,
    rt: AgentRuntime,
    reason: string,
    ignoredOperationId?: string,
  ): Promise<void> => {
    const existing = reconcileFlights.get(sessionId);
    if (existing) return existing;
    const run = (async () => {
      const started = await broadcastTail(sessionId, () => durable.startReconciliation(sessionId));
      await updateProjection(sessionId, { status: "reconciling" });
      try {
        const project = await projects.get(proj.projectId);
        const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
        const binding = await runtimeBinding(rt, proj, cwd);
        const reconcile = (rt as ReliabilityRuntime).reconcile;
        if (!binding || !binding.backendSessionId || !reconcile) {
          await broadcastTail(sessionId, () => durable.settleReconciliation(
            sessionId,
            started.ordinal,
            "unknown",
            !binding ? "backend session binding is unavailable" : "runtime reconciliation is unavailable",
          ));
          await updateProjection(sessionId, { status: "unknown" });
          return;
        }
        const cursor = await durable.observationCursor({
          authorityId: binding.authorityId,
          location: binding.location,
          backendSessionId: binding.backendSessionId,
          channel: "runtime",
        });
        const snapshot = await reconcile.call(
          rt,
          { ...binding, reconciliationOrdinal: started.ordinal },
          cursor,
        );
        const current = await durable.reconciliation(sessionId);
        if (current?.ordinal !== started.ordinal) return;
        if (
          snapshot.authorityId !== binding.authorityId
          || snapshot.generation !== binding.generation
          || snapshot.backendSessionId !== binding.backendSessionId
          || snapshot.location.directory !== binding.location.directory
          || (snapshot.location.workspace ?? "") !== (binding.location.workspace ?? "")
          || snapshot.reconciliationOrdinal !== started.ordinal
        ) {
          throw Object.assign(new Error("runtime reconciliation returned stale or mismatched evidence"), {
            code: "stale-evidence",
          });
        }
        const currentProjection = await store.projection(sessionId);
        const authoritativeState = await authoritativeSnapshotState(
          sessionId,
          snapshot,
          binding,
          currentProjection,
        );

        const historyBaseline = currentProjection?.runtimeBinding?.historyBaseline;
        const observations: Parameters<RuntimeDurability["ingestSnapshot"]>[0]["observations"] = [];
        for (const observed of snapshot.events) {
          const normalized = canonicalRuntimeEvent(observed.event);
          observations.push({
            sessionId,
            identity: {
              authorityId: binding.authorityId,
              generation: binding.generation,
              location: binding.location,
              backendSessionId: binding.backendSessionId,
              artifactKind: normalized.artifactKind,
              entityId: observed.entityKey,
              revision: observed.revision,
            },
            reconciliationOrdinal: started.ordinal,
            // A verified fork already copied this exact backend history into
            // the child log. Claim entity mappings without appending it again.
            events: historyBaseline === "copied" ? [] : normalized.events,
          });
        }
        for (const permission of snapshot.permissions) {
          observations.push({
            sessionId,
            identity: {
              authorityId: binding.authorityId,
              generation: binding.generation,
              location: binding.location,
              backendSessionId: binding.backendSessionId,
              artifactKind: "permission",
              entityId: permission.requestId,
              revision: permission.revision ?? "pending",
            },
            reconciliationOrdinal: started.ordinal,
            events: [{
              type: "permission/requested",
              data: {
                requestId: permission.requestId,
                permission: permission.permission,
                patterns: permission.patterns,
                preview: buildPermissionPreview(permission) as unknown as JsonObject,
                allowedScopes: [...PERMISSION_ALLOWED_SCOPES],
              },
              ignorable: true,
            }],
          });
        }
        for (const question of snapshot.questions) {
          observations.push({
            sessionId,
            identity: {
              authorityId: binding.authorityId,
              generation: binding.generation,
              location: binding.location,
              backendSessionId: binding.backendSessionId,
              artifactKind: "question",
              entityId: question.requestId,
              revision: question.revision ?? "pending",
            },
            reconciliationOrdinal: started.ordinal,
            events: [{
              type: "question/asked",
              data: { requestId: question.requestId, questions: question.questions },
              ignorable: true,
            }],
          });
        }
        observations.push({
          sessionId,
          identity: {
            authorityId: binding.authorityId,
            generation: binding.generation,
            location: binding.location,
            backendSessionId: binding.backendSessionId,
            artifactKind: "status",
            entityId: binding.backendSessionId,
            revision: authoritativeState.comparison
              ? `${authoritativeState.comparison.domain}:${authoritativeState.comparison.order}`
              : authoritativeState.causalOperationId
                ? `causal:${authoritativeState.causalOperationId}`
                : authoritativeState.watermark ?? `unversioned:${authoritativeState.value}`,
          },
          reconciliationOrdinal: started.ordinal,
          events: [{
            type: "runtime/status-observed",
            data: {
              state: authoritativeState.value,
              ...(authoritativeState.watermark ? { watermark: authoritativeState.watermark } : {}),
              ...(authoritativeState.comparison
                ? { comparison: authoritativeState.comparison as unknown as JsonObject }
                : {}),
              ...(authoritativeState.causalOperationId
                ? { causalOperationId: authoritativeState.causalOperationId }
                : {}),
              authorityId: binding.authorityId,
              generation: binding.generation,
              reason,
            },
            ignorable: true,
          }],
          ...(authoritativeState.value !== "unknown"
            ? {
                checkpoint: {
                  value: {
                    state: authoritativeState.value,
                    ...(authoritativeState.watermark
                      ? { watermark: authoritativeState.watermark }
                      : {}),
                    ...(authoritativeState.comparison
                      ? { comparison: authoritativeState.comparison as unknown as JsonObject }
                      : {}),
                    ...(authoritativeState.causalOperationId
                      ? { causalOperationId: authoritativeState.causalOperationId }
                      : {}),
                  },
                },
              }
            : {}),
        });
        if (snapshot.cursorAfter) {
          const finalObservation = observations.at(-1)!;
          finalObservation.cursor = {
            key: {
              authorityId: binding.authorityId,
              location: binding.location,
              backendSessionId: binding.backendSessionId,
              channel: "runtime",
            },
            after: snapshot.cursorAfter,
          };
        }
        const snapshotIngestion = await durable.ingestSnapshot({
          sessionId,
          observations,
        });
        for (const result of snapshotIngestion.observations) {
          if (result.kind !== "applied") continue;
          for (const event of result.events) broadcast.event(event);
        }
        if (historyBaseline) {
          await applyProjection(sessionId, (current) => {
            if (!current.runtimeBinding) return current;
            const runtimeBinding = { ...current.runtimeBinding };
            delete runtimeBinding.historyBaseline;
            return { ...current, runtimeBinding, updatedAt: Date.now() };
          });
          if (historyBaseline === "import") {
            await appendAndBroadcast(
              sessionId,
              "session/history-imported",
              {},
              { ignorable: true },
            );
          }
        }

        let facts = await logFacts(sessionId);
        await settleAcceptedOperations(sessionId, snapshot, facts);
        facts = await logFacts(sessionId);
        await settleProvenOperationNonapplications(sessionId, snapshot, facts);
        facts = await logFacts(sessionId);
        const unresolved = await blockingOperation(sessionId, ignoredOperationId);
        const nextStatus = unresolved
          ? "unknown"
          : authoritativeState.value === "running"
            ? (openRequestTotal(facts) > 0 ? "waiting" : "working")
            : authoritativeState.value === "idle"
              ? (openRequestTotal(facts) > 0 ? "waiting" : "idle")
              : authoritativeState.value === "unknown"
                ? "unknown"
                : "failed";
        const barrierState = unresolved
          ? "blocked"
          : authoritativeState.value === "unknown"
            ? "unknown"
            : "ready";
        await broadcastTail(sessionId, () => durable.settleReconciliation(
          sessionId,
          started.ordinal,
          barrierState,
          unresolved
            ? `operation ${unresolved.operationId} remains ${unresolved.state}`
            : authoritativeState.value === "unknown"
              ? "runtime status evidence is insufficient"
              : undefined,
        ));
        await updateProjection(sessionId, { status: nextStatus });
      } catch (error) {
        const current = await durable.reconciliation(sessionId);
        if (current?.ordinal === started.ordinal) {
          await broadcastTail(sessionId, () => durable.settleReconciliation(
            sessionId,
            started.ordinal,
            "unknown",
            error instanceof Error ? error.message : "runtime reconciliation failed",
          ));
          await updateProjection(sessionId, { status: "unknown" });
        }
      }
    })().finally(() => {
      reconcileFlights.delete(sessionId);
    });
    reconcileFlights.set(sessionId, run);
    return run;
  };
  const reconcileUnderLock = (
    sessionId: string,
    projection: SessionProjection,
    runtime: AgentRuntime,
    reason: string,
  ): Promise<void> =>
    withSessionLock(sessionId, () =>
      reconcileSession(sessionId, projection, runtime, reason));
  const scheduleReconciliation = (
    sessionId: string,
    projection: SessionProjection,
    runtime: AgentRuntime,
    reason: string,
  ): void => {
    queueMicrotask(() => {
      void reconcileUnderLock(sessionId, projection, runtime, reason).catch((error) => {
        console.error(`[polyth] runtime reconciliation failed for ${sessionId}`, error);
      });
    });
  };
  runtimes.onRestart?.(async (runtime) => {
    const reconciliations: Promise<void>[] = [];
    for (const [sessionId, wired] of sessionRuntime) {
      if (wired !== runtime) continue;
      const projection = await store.projection(sessionId);
      if (projection) {
        reconciliations.push(reconcileUnderLock(
          sessionId,
          projection,
          runtime,
          "runtime-generation-replaced",
        ));
      }
    }
    await settleAllOrThrow(reconciliations);
  });

  // UX-COMPOSER-DISC: the projection records the selected profile id or its
  // explicit clear; spread-merge cannot delete a key, so this owns removal.
  const setProjectionProfile = async (sessionId: string, id: string | undefined) => {
    await applyProjection(sessionId, (current) => {
      const next = { ...current, updatedAt: Date.now() };
      if (id) next.agentProfileId = id;
      else delete next.agentProfileId;
      return next;
    });
  };

  // F18: effective auto-accept — own explicit setting, else the nearest
  // ancestor's (subagents/forks carry parentId). The chain is prefetched from
  // projections; resolveAutoAccept is the pure, cycle-guarded core.
  const effectiveAutoAccept = async (sessionId: string): Promise<boolean> => {
    if (!deps.autoAccept) return false;
    const parents = new Map<string, string | undefined>();
    let id: string | undefined = sessionId;
    while (id && !parents.has(id) && parents.size < 64) {
      const proj = await store.projection(id);
      parents.set(id, proj?.parentId);
      id = proj?.parentId;
    }
    return resolveAutoAccept(sessionId, (x) => deps.autoAccept!.get(x), (x) => parents.get(x));
  };

  const onRuntimeEvent = async (
    sessionId: string,
    ev: RuntimeEvent,
    options: {
      persist?: typeof appendAndBroadcast;
      sideEffects?: boolean;
      runtimeEventSeq?: number;
    } = {},
  ) => {
    const persist = options.persist ?? appendAndBroadcast;
    const sideEffects = options.sideEffects ?? true;
    const runtimeEventSeq = options.runtimeEventSeq;
    // invariant: model-visible content hits the log before any UI sees it
    switch (ev.type) {
      case "turn/started":
        await persist(sessionId, "turn/started", { turnId: ev.turnId }, { ignorable: true });
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({
              ...current,
              status: "working",
              lastTurnAt: Date.now(),
              updatedAt: Date.now(),
            }),
          );
          if (applied) {
            lastTurnId.set(sessionId, ev.turnId);
            admitting.delete(sessionId);
            turnReply.set(sessionId, new Map());
          }
        }
        break;
      case "session/title-generated": {
        if (!autoTitleRequested.has(sessionId)) break;
        const current = await store.projection(sessionId);
        if (!current || !isPlaceholderTitle(current.title, sessionId)) {
          if (sideEffects) autoTitleRequested.delete(sessionId);
          break;
        }
        const title = ev.title.trim().slice(0, 200);
        if (!title || isPlaceholderTitle(title, sessionId)) break;
        await persist(
          sessionId,
          "session/metadata-changed",
          { title, source: "opencode" },
          { ignorable: true, producerPlugin: "backend-opencode" },
        );
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({ ...current, title, updatedAt: Date.now() }),
          );
          if (applied) autoTitleRequested.delete(sessionId);
        }
        break;
      }
      case "turn/stopped":
        await persist(sessionId, "turn/stopped", {
          turnId: lastTurnId.get(sessionId) ?? ev.type, reason: ev.reason, ...(ev.error ? { error: ev.error } : {}),
        }, { ignorable: true });
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({
              ...current,
              status: ev.reason === "error" ? "failed" : "idle",
              updatedAt: Date.now(),
            }),
          );
          if (applied) {
            lastTurnId.delete(sessionId);
            admitting.delete(sessionId);
            autoTitleRequested.delete(sessionId);
            deps.notify?.turnStopped(sessionId, ev.reason);
            if (ev.reason === "completed") hooks.onTurnCompleted?.(sessionId, replyText(sessionId));
            // FIFO dispatch of queued follow-ups; never into an error state (a
            // failing session would silently burn the whole queue otherwise).
            if (ev.reason !== "error") void dispatchQueue(sessionId);
          }
        }
        break;
      case "permission/requested": {
        const { type: _t, ...reqData } = ev;
        // Redacted preview + explicit scopes are generated BEFORE the request
        // event is appended (WP15) so the log never sees raw metadata values.
        const enriched: JsonObject = {
          ...(reqData as unknown as JsonObject),
          preview: buildPermissionPreview({
            permission: ev.permission, patterns: ev.patterns,
            ...(ev.metadata ? { metadata: ev.metadata } : {}),
            ...(ev.tool ? { tool: ev.tool } : {}),
          }) as unknown as JsonObject,
          allowedScopes: [...PERMISSION_ALLOWED_SCOPES],
        };
        await persist(sessionId, "permission/requested", enriched, { ignorable: true });
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({ ...current, status: "waiting", updatedAt: Date.now() }),
          );
          if (!applied) break;
          const proj = await store.projection(sessionId);
          const verdict = permissions.evaluate(ev.permission, ev.patterns, proj?.projectId, sessionId);
          if (verdict === "allow" || verdict === "deny") {
            const reply = verdict === "allow" ? "once" : "reject";
            await replyPermissionCore(sessionId, ev.requestId, reply).catch((error) => {
              console.warn(`[polyth] policy permission response remains unresolved for ${sessionId}`, error);
            });
          } else if (await effectiveAutoAccept(sessionId)) {
            await replyPermissionCore(sessionId, ev.requestId, "once", undefined, true).catch((error) => {
              console.warn(`[polyth] auto-accept permission remains unresolved for ${sessionId}`, error);
            });
          } else {
            deps.notify?.attention(sessionId, "permission", ev.requestId);
          }
        }
        break;
      }
      case "question/asked": {
        const request = ev.questions
          .map((question) => secureRequest(ev.requestId, question))
          .find((candidate): candidate is SecretRequestData => candidate !== null);
        if (request) {
          await persist(
            sessionId,
            "secret/requested",
            request as unknown as JsonObject,
            { ignorable: true },
          );
          if (sideEffects) {
            const applied = await applyRuntimeProjection(
              sessionId,
              runtimeEventSeq,
              (current) => ({ ...current, status: "waiting", updatedAt: Date.now() }),
            );
            if (applied) deps.notify?.attention(sessionId, "question");
          }
          break;
        }
        const { type: _t, ...qData } = ev;
        await persist(sessionId, "question/asked", qData as unknown as JsonObject, { ignorable: true });
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({ ...current, status: "waiting", updatedAt: Date.now() }),
          );
          if (applied) {
            deps.notify?.attention(sessionId, "question", ev.requestId, ev.questions);
          }
        }
        break;
      }
      case "secret/requested": {
        const request: SecretRequestData = {
          requestId: ev.requestId,
          handle: ev.handle,
          label: ev.label,
          ...(ev.purpose ? { purpose: ev.purpose } : {}),
          ...(ev.kind ? { kind: ev.kind } : {}),
          existing: deps.secureSafe?.hasHandle(ev.handle) ?? ev.existing ?? false,
        };
        await persist(
          sessionId,
          "secret/requested",
          request as unknown as JsonObject,
          { ignorable: true },
        );
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({ ...current, status: "waiting", updatedAt: Date.now() }),
          );
          if (applied) deps.notify?.attention(sessionId, "question");
        }
        break;
      }
      case "usage/recorded": {
        const { type: _t, ...uData } = ev;
        await persist(sessionId, "usage/recorded", uData as unknown as JsonObject, { ignorable: true });
        // Token/cost increments are read-modify-written inside one projection
        // patch so back-to-back callbacks apply exactly once each.
        if (sideEffects) {
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (proj) => ({
              ...proj,
              tokenTotals: {
                input: (proj.tokenTotals?.input ?? 0) + ev.tokens.input,
                output: (proj.tokenTotals?.output ?? 0) + ev.tokens.output,
                ...(ev.tokens.reasoning ? { reasoning: (proj.tokenTotals?.reasoning ?? 0) + ev.tokens.reasoning } : {}),
              },
              costTotal: (proj.costTotal ?? 0) + (ev.cost ?? 0),
              updatedAt: Date.now(),
            }),
          );
          if (applied) hooks.onUsage?.(sessionId, ev.tokens);
        }
        break;
      }
      case "session/compacted": {
        const { type: _t, ...data } = ev;
        await persist(
          sessionId,
          "session/compacted",
          data as unknown as JsonObject,
          { ignorable: true, producerPlugin: "backend-opencode" },
        );
        break;
      }
      case "compaction/part-recorded": {
        const { type: _t, ...data } = ev;
        await persist(
          sessionId,
          "compaction/part-recorded",
          data as unknown as JsonObject,
          { ignorable: true, producerPlugin: "backend-opencode" },
        );
        break;
      }
      default: {
        // model-visible payloads pass through verbatim (minus the envelope `type`)
        const { type: _t, ...rest } = ev;
        if (sideEffects && ev.type === "assistant/message" && ev.text.trim()) {
          let parts = turnReply.get(sessionId);
          if (!parts) turnReply.set(sessionId, (parts = new Map()));
          parts.set(ev.partId, ev.text);
        }
        await persist(sessionId, ev.type, rest as unknown as JsonObject);
      }
    }
  };

  const captureRuntimeEvent = async (
    sessionId: string,
    event: RuntimeEvent,
  ): Promise<CanonicalEventInput[]> => {
    const captured: CanonicalEventInput[] = [];
    await onRuntimeEvent(sessionId, event, {
      sideEffects: false,
      persist: async (_sessionId, type, data, options) => {
        captured.push({ type, data, ...options });
        return undefined as unknown as SessionEvent;
      },
    });
    return captured;
  };

  const ingestRuntimeObservation = async (
    sessionId: string,
    observation: RuntimeObservation,
  ): Promise<void> => {
    const batches: CanonicalEventInput[][] = [];
    for (const event of observation.events) {
      batches.push(await captureRuntimeEvent(sessionId, event));
    }
    const canonicalEvents = batches.flat();
    if (observation.uncertainty) {
      canonicalEvents.push({
        type: "reconciliation/uncertainty-recorded",
        data: {
          entityKey: observation.entityKey,
          code: observation.uncertainty.code,
          message: observation.uncertainty.message,
        },
        ignorable: true,
        producerPlugin: "backend-opencode",
      });
    }
    const ingested = await durable.ingestObservation({
      sessionId,
      identity: observation.identity,
      reconciliationOrdinal: observation.reconciliationOrdinal,
      events: canonicalEvents,
      ...(observation.checkpoint ? { checkpoint: observation.checkpoint } : {}),
      ...(observation.cursorAfter
        ? {
            cursor: {
              key: {
                authorityId: observation.identity.authorityId,
                location: observation.identity.location,
                backendSessionId: observation.identity.backendSessionId,
                channel: observation.channel,
              },
              after: observation.cursorAfter,
            },
          }
        : {}),
    });
    if (ingested.kind === "duplicate") {
      // The original semantic observation already drove projection effects.
      // Its returned durable events are references to that first application,
      // not a new canonical batch to consume or broadcast again.
      return;
    }

    let persistedIndex = 0;
    for (let index = 0; index < observation.events.length; index += 1) {
      const expectedCount = batches[index]!.length;
      if (expectedCount === 0) continue;
      const runtimeEventSeq = Math.max(
        ...ingested.events
          .slice(persistedIndex, persistedIndex + expectedCount)
          .map((event) => event.seq),
      );
      let used = 0;
      await onRuntimeEvent(sessionId, observation.events[index]!, {
        persist: async (_sessionId, type) => {
          const persisted = ingested.events[persistedIndex++];
          if (!persisted || persisted.type !== type || used >= expectedCount) {
            throw new Error("runtime observation canonical batch did not match its persisted events");
          }
          used += 1;
          if (ingested.kind === "applied") broadcast.event(persisted);
          return persisted;
        },
        runtimeEventSeq,
      });
      if (used !== expectedCount) {
        throw new Error("runtime observation did not consume its complete canonical batch");
      }
    }
    const uncertainty = observation.uncertainty
      ? ingested.events[persistedIndex++]
      : undefined;
    if (
      observation.uncertainty
      && uncertainty?.type !== "reconciliation/uncertainty-recorded"
    ) {
      throw new Error("runtime observation uncertainty did not match its persisted event");
    }
    if (uncertainty && ingested.kind === "applied") broadcast.event(uncertainty);
    if (persistedIndex !== ingested.events.length) {
      throw new Error("runtime observation left persisted events unconsumed");
    }
  };

  const wire = (sessionId: string, rt: AgentRuntime) => {
    if (sessionRuntime.has(sessionId)) return;
    sessionRuntime.set(sessionId, rt);
    if (runtimeSubs.has(rt)) return;
    const subscriptions: Disposable[] = [];
    subscriptions.push(rt.onEvent((sid, ev) => {
      // deliver only to sessions currently wired to this runtime — the same
      // filter the old per-session closures applied, minus the listener pile-up.
      if (sessionRuntime.get(sid) !== rt) return;
      // Serialize each canonical session: a terminal turn/stopped can never be
      // overwritten by an older usage or chunk projection update.
      void withSessionLock(sid, () => onRuntimeEvent(sid, ev)).catch((err) => {
        console.error(`[polyth] runtime event handling failed for ${sid}`, err);
      });
    }));
    if (rt.onObservation) {
      subscriptions.push(rt.onObservation((sid, observation) => {
        if (sessionRuntime.get(sid) !== rt) return;
        void withSessionLock(sid, () => ingestRuntimeObservation(sid, observation)).catch((err) => {
          console.error(`[polyth] runtime observation handling failed for ${sid}`, err);
        });
      }));
    }
    if (rt.onLifecycle) {
      subscriptions.push(rt.onLifecycle((notification: RuntimeLifecycleNotification) => {
        if (notification.type !== "stream-disconnected"
          && notification.type !== "stream-connected"
          && notification.type !== "endpoint-replaced") return;
        for (const [sid, wired] of sessionRuntime) {
          if (wired !== rt) continue;
          void (async () => {
            const projection = await store.projection(sid);
            if (!projection) return;
            await reconcileUnderLock(sid, projection, rt, notification.type);
          })().catch((err) => {
            console.error(`[polyth] runtime lifecycle reconciliation failed for ${sid}`, err);
          });
        }
      }));
    }
    runtimeSubs.set(rt, subscriptions);
  };

  const unwire = (sessionId: string) => {
    const rt = sessionRuntime.get(sessionId);
    if (!rt) return;
    sessionRuntime.delete(sessionId);
    turnReply.delete(sessionId);
    behaviorLogged.delete(sessionId);
    autoTitleRequested.delete(sessionId);
    for (const wired of sessionRuntime.values()) if (wired === rt) return;
    for (const subscription of runtimeSubs.get(rt) ?? []) subscription.dispose();
    runtimeSubs.delete(rt);
  };

  const ensureWired = async (
    sessionId: string,
    proj: SessionProjection,
    admittedPreparedOperationId?: string,
  ): Promise<AgentRuntime> => {
    let rt = sessionRuntime.get(sessionId);
    if (!rt) {
      const project = await projects.get(proj.projectId);
      const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
      rt = await runtimes.forProject(proj.projectId, cwd);
      let attachedProjection = proj;
      // A missing binding after an unknown create is recovered only from an
      // exact protocol receipt. Listing/title similarity is deliberately not
      // enough and this path never issues another create.
      if (!attachedProjection.backendSessionId) {
        const createOperation = (await durable.operations(sessionId)).find((operation) =>
          operation.mutationKind === "session-create"
          && (operation.state === "unknown" || operation.state === "confirmed"));
        const confirmedBackendId =
          createOperation?.state === "confirmed" ? createOperation.receipt : undefined;
        const matches = createOperation?.state === "unknown"
          ? (await boundedRuntimeAwait(rt.sessions(), `recover-create:${sessionId}`))
              .filter((candidate) => candidate.operationId === createOperation.operationId)
          : [];
        const recoveredBackendId = confirmedBackendId
          ?? (matches.length === 1 ? matches[0]!.id : undefined);
        if (createOperation && recoveredBackendId) {
          if (createOperation.state === "unknown") {
            await broadcastTail(sessionId, () => durable.settleOperation(
              createOperation.operationId,
              { kind: "confirmed", receipt: recoveredBackendId },
            ));
          }
          attachedProjection = {
            ...attachedProjection,
            backendSessionId: recoveredBackendId,
            status: "reconciling",
            updatedAt: Date.now(),
          };
          await store.upsertProjection(attachedProjection);
          broadcast.projection(attachedProjection);
        } else {
          await updateProjection(sessionId, { status: "unknown" });
          throw Object.assign(new Error("backend session creation outcome is unknown"), {
            code: "outcome-unknown",
          });
        }
      }
      // Validate/persist the durable endpoint binding before the facade is
      // allowed to register an existing backend ID in its in-memory map.
      await runtimeBinding(rt, attachedProjection, cwd);
      try {
        await boundedRuntimeAwait(
          rt.ensureSession({
            projectId: attachedProjection.projectId,
            title: attachedProjection.title,
            sessionId,
            cwd,
            backendSessionId: attachedProjection.backendSessionId,
            ...(attachedProjection.model ? { model: attachedProjection.model } : {}),
            ...(attachedProjection.agent ? { agent: attachedProjection.agent } : {}),
          }),
          `reattach:${sessionId}`,
        );
      } catch (error) {
        await updateProjection(sessionId, { status: "unknown" });
        throw error;
      }
      wire(sessionId, rt);
      if (typeof (rt as ReliabilityRuntime).reconcile === "function") {
        await reconcileSession(
          sessionId,
          attachedProjection,
          rt,
          "session-reattached",
          admittedPreparedOperationId,
        );
      }
    }
    return rt;
  };

  const turnActive = (sessionId: string): boolean =>
    lastTurnId.has(sessionId) || admitting.has(sessionId);

  /** Unresolved question/permission/secret requests derived from durable events. */
  const openRequestCount = (events: SessionEvent[]): number => {
    const questions = new Set<string>();
    const perms = new Set<string>();
    const secrets = new Set<string>();
    for (const e of events) {
      const rid = (e.data as { requestId?: string }).requestId;
      if (!rid) continue;
      if (e.type === "question/asked") questions.add(rid);
      else if (e.type === "question/answered") questions.delete(rid);
      else if (e.type === "permission/requested") perms.add(rid);
      else if (e.type === "permission/resolved") perms.delete(rid);
      else if (e.type === "secret/requested") secrets.add(rid);
      else if (e.type === "secret/resolved") secrets.delete(rid);
    }
    return questions.size + perms.size + secrets.size;
  };

  /** OpenCode's question endpoint accepts answers by question position
   * (`string[][]`), while the UI keeps an ID-keyed answer map so drafts remain
   * stable when questions are rendered as a stepper. Preserve the latter in
   * the event log, but translate it at the runtime boundary. */
  const openCodeQuestionReply = (questions: JsonObject[], answers: JsonObject): JsonObject => {
    const raw = answers as Record<string, unknown>;
    // Keep compatibility with callers that already use OpenCode's native
    // payload (for example integrations replying outside the React UI).
    if (Array.isArray(raw.answers)) return { answers: raw.answers };
    return {
      answers: questions.map((question, index) => {
        const id = typeof question.id === "string" && question.id
          ? question.id
          : `q${index + 1}`;
        // Numeric keys support logs produced by the earlier single-question
        // surface, whose answer key was the question index.
        const value = raw[id] ?? raw[String(index)];
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
        return typeof value === "string" ? [value] : [];
      }),
    };
  };

  /** Truthful Revert/Fork eligibility, evaluated fresh under the session lock.
   *  Live runtime admission + durable unresolved requests are authoritative; a
   *  stale `working` projection from an interrupted process must not turn the
   *  offered action into a deterministic 409. */
  const assertMutable = async (
    sessionId: string,
  ): Promise<{ proj: SessionProjection; events: SessionEvent[] }> => {
    const proj = await store.projection(sessionId);
    if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
    if (proj.status === "archived") {
      throw Object.assign(new Error("unavailable while the session is archived"), { code: "conflict" });
    }
    if (proj.status === "reconciling" || proj.status === "unknown") {
      throw Object.assign(new Error(`unavailable while the session is ${proj.status}`), { code: "conflict" });
    }
    const reconciliation = await durable.reconciliation(sessionId);
    if (reconciliation?.state === "reconciling"
      || reconciliation?.state === "blocked"
      || reconciliation?.state === "unknown") {
      throw Object.assign(new Error(`unavailable while reconciliation is ${reconciliation.state}`), {
        code: "conflict",
      });
    }
    const unresolvedOperation = await blockingOperation(sessionId);
    if (unresolvedOperation) {
      throw Object.assign(
        new Error(`unavailable while operation ${unresolvedOperation.operationId} is ${unresolvedOperation.state}`),
        { code: "conflict" },
      );
    }
    if (turnActive(sessionId)) {
      throw Object.assign(new Error("unavailable while a turn is running"), { code: "conflict" });
    }
    const events = await store.events(sessionId);
    if (openRequestCount(events) > 0) {
      throw Object.assign(new Error("unavailable while a request is waiting"), { code: "conflict" });
    }
    if (deps.queue && (await deps.queue.queueList(sessionId)).length > 0) {
      throw Object.assign(new Error("unavailable while messages are queued"), { code: "conflict" });
    }
    return { proj, events };
  };

  const finishShell = async (
    sessionId: string,
    proj: SessionProjection,
    command: string,
    callId: string,
    rejected = false,
  ): Promise<void> => {
    await appendAndBroadcast(sessionId, "tool/call", {
      callId,
      tool: "shell",
      input: { command },
    }, { producerPlugin: "composer-shell" });
    if (rejected) {
      await appendAndBroadcast(sessionId, "tool/result", {
        callId,
        tool: "shell",
        output: "Command rejected by the shell permission policy.",
        title: `!${command}`,
        input: { command },
        metadata: { rejected: true },
      }, { producerPlugin: "composer-shell" });
      return;
    }
    if (!deps.shell) throw Object.assign(new Error("composer shell unavailable"), { code: "unsupported" });
    const project = await projects.get(proj.projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    try {
      const result = await deps.shell.run({
        projectId: proj.projectId,
        cwd: proj.worktreePath ?? project.path,
        cmd: command,
      }, { timeoutMs: 30_000, maxOutputBytes: 64 * 1_024 });
      const suffix = result.timedOut
        ? "\n[command timed out]"
        : result.truncated
          ? "\n[earlier output truncated]"
          : "";
      await appendAndBroadcast(sessionId, "tool/result", {
        callId,
        tool: "shell",
        output: `${result.output}${suffix}`,
        title: `!${command}`,
        input: { command },
        metadata: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      }, { producerPlugin: "composer-shell" });
    } catch (err) {
      await appendAndBroadcast(sessionId, "tool/result", {
        callId,
        tool: "shell",
        output: err instanceof Error ? err.message : String(err),
        title: `!${command}`,
        input: { command },
        metadata: { failed: true },
      }, { producerPlugin: "composer-shell" });
      throw err;
    }
  };

  const runResponseOperation = async <T, R>(
    operation: DurableOperation,
    call: (operationId: string) => Promise<R | MutationOutcome<T>>,
    confirmed: (value: R) => T,
    completionEvent: { type: string; data: JsonObject; ignorable?: boolean },
  ): Promise<MutationOutcome<T>> =>
    runPreparedOperation(operation, call, confirmed, async (outcome) => {
      if (outcome.kind === "confirmed") {
        await broadcastTail(operation.sessionId, () => durable.settleResponseIntent(
          operation.operationId,
          {
            kind: "confirmed",
            ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
            completionEvent,
          },
        ));
      } else if (outcome.kind === "rejected") {
        await broadcastTail(operation.sessionId, () => durable.settleResponseIntent(
          operation.operationId,
          { kind: "rejected", code: outcome.code, message: outcome.message },
        ));
      } else {
        await broadcastTail(operation.sessionId, () => durable.settleResponseIntent(
          operation.operationId,
          {
            kind: "unknown",
            code: "runtime-outcome-unknown",
            message: outcome.message,
          },
        ));
      }
    });

  const assertChosenIntent = (
    choice: Awaited<ReturnType<RuntimeDurability["chooseResponseIntent"]>>,
    expected: JsonObject,
  ): DurableOperation => {
    if (choice.kind === "chosen") return choice.operation;
    if (JSON.stringify(choice.intent.payload) !== JSON.stringify(expected)) {
      throw Object.assign(new Error("a different response already won this request"), {
        code: "conflict",
        operationId: choice.operation.operationId,
      });
    }
    if (choice.operation.state !== "prepared") {
      throw Object.assign(new Error(`response is already ${choice.operation.state}`), {
        code: "conflict",
        operationId: choice.operation.operationId,
      });
    }
    // A crash before claim leaves a prepared response intent that is safe to
    // resume with the same durable operation identity.
    return choice.operation;
  };

  /** Atomic send-time arbitration: reject open questions and deny open
   *  permissions of this exact session before the new message is admitted.
   *  Resolution events precede the queue/user events in the durable log. */
  const dismissPendingRequests = async (sessionId: string, rt: AgentRuntime): Promise<void> => {
    const facts = await logFacts(sessionId);
    for (const rid of [...facts.openPermissions.keys()]) {
      const choice = await broadcastTail(sessionId, () => durable.chooseResponseIntent({
        kind: "permission",
        sessionId,
        requestId: rid,
        reply: "reject",
      }));
      const operation = assertChosenIntent(choice, { reply: "reject" });
      const outcome = await runResponseOperation<Record<string, never>, void>(
        operation,
        (operationId) => rt.replyPermissionOperation
          ? rt.replyPermissionOperation(sessionId, rid, "reject", operationId)
          : rt.replyPermission(sessionId, rid, "reject"),
        () => ({}),
        { type: "permission/resolved", data: { requestId: rid, reply: "reject" }, ignorable: true },
      );
      if (outcome.kind !== "confirmed") throw outcomeError(outcome);
    }
    for (const rid of [...facts.openQuestions.keys()]) {
      const choice = await broadcastTail(sessionId, () => durable.chooseResponseIntent({
        kind: "question",
        sessionId,
        requestId: rid,
        answers: {},
        reject: true,
      }));
      const operation = assertChosenIntent(choice, { answers: {}, reject: true });
      const outcome = await runResponseOperation<Record<string, never>, void>(
        operation,
        (operationId) => rt.replyQuestionOperation
          ? rt.replyQuestionOperation(sessionId, rid, { action: "reject" }, operationId)
          : rt.replyQuestion(sessionId, rid, { action: "reject" }),
        () => ({}),
        { type: "question/answered", data: { requestId: rid, rejected: true }, ignorable: true },
      );
      if (outcome.kind !== "confirmed") throw outcomeError(outcome);
    }
    for (const [rid, requested] of [...facts.openSecrets]) {
      const handle = (requested.data as { handle?: string }).handle;
      const result: SecretResolvedData = {
        requestId: rid,
        action: "dismissed",
        ...(handle ? { handle } : {}),
      };
      const choice = await broadcastTail(sessionId, () => durable.chooseResponseIntent({
        kind: "secret",
        sessionId,
        requestId: rid,
        action: "dismiss",
        ...(handle ? { handle } : {}),
      }));
      const operation = assertChosenIntent(choice, {
        action: "dismiss",
        ...(handle ? { handle } : {}),
      });
      const outcome = await runResponseOperation<Record<string, never>, void>(
        operation,
        (operationId) => rt.replySecret
          ? (rt.replySecretOperation
              ? rt.replySecretOperation(sessionId, rid, result, operationId)
              : rt.replySecret(sessionId, rid, result))
          : (rt.replyQuestionOperation
              ? rt.replyQuestionOperation(sessionId, rid, { action: "reject" }, operationId)
              : rt.replyQuestion(sessionId, rid, { action: "reject" })),
        () => ({}),
        { type: "secret/resolved", data: result as unknown as JsonObject, ignorable: true },
      );
      if (outcome.kind !== "confirmed") throw outcomeError(outcome);
    }
  };

  const replyPermissionCore = async (
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    scope?: "session" | "project",
    auto = false,
  ): Promise<void> => {
    if (reply !== "once" && reply !== "always" && reply !== "reject") {
      throw Object.assign(new Error("permission reply must be once, always, or reject"), { code: "invalid-input" });
    }
    const facts = await logFacts(sessionId);
    const original = facts.openPermissions.get(requestId);
    if (!original) {
      if (facts.requestedPermissions.has(requestId)) {
        throw Object.assign(new Error("permission request already resolved"), { code: "conflict" });
      }
      throw Object.assign(new Error("permission request not found"), { code: "not-found" });
    }
    const proj = await store.projection(sessionId);
    if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
    const shellRequest = (original.data as { permission?: string }).permission === "shell"
      ? original
      : undefined;
    const rt = shellRequest ? undefined : await ensureWired(sessionId, proj);
    const expected: JsonObject = { reply, ...(scope ? { scope } : {}) };
    const choice = await broadcastTail(sessionId, () => durable.chooseResponseIntent({
      kind: "permission",
      sessionId,
      requestId,
      reply,
      ...(scope ? { scope } : {}),
    }));
    const operation = assertChosenIntent(choice, expected);
    const completion = {
      type: "permission/resolved",
      data: { requestId, reply, ...(scope ? { scope } : {}), ...(auto ? { auto: true } : {}) },
      ignorable: true,
    };
    const outcome = shellRequest
      ? await runResponseOperation<Record<string, never>, void>(
          operation,
          async () => {
            const data = shellRequest.data as { patterns?: string[]; callId?: string };
            const command = data.patterns?.[0] ?? "";
            const callId = data.callId ?? `shell_${randomUUID()}`;
            await finishShell(sessionId, proj, command, callId, reply === "reject");
          },
          () => ({}),
          completion,
        )
      : await runResponseOperation<Record<string, never>, void>(
          operation,
          (operationId) => rt!.replyPermissionOperation
            ? rt!.replyPermissionOperation(sessionId, requestId, reply, operationId)
            : rt!.replyPermission(sessionId, requestId, reply),
          () => ({}),
          completion,
        );
    if (outcome.kind !== "confirmed") {
      if (outcome.kind === "unknown") {
        await updateProjection(sessionId, { status: "unknown" });
        if (rt) {
          scheduleReconciliation(sessionId, proj, rt, "permission-outcome-unknown");
        }
      }
      throw outcomeError(outcome);
    }
    if (reply === "always") {
      const data = original.data as { permission?: string; patterns?: string[] };
      for (const pattern of data.patterns?.length ? data.patterns : ["*"]) {
        if (scope === "session") {
          permissions.addRule({ permission: data.permission ?? "*", pattern, action: "allow", scope: "session", sessionId });
        } else if (scope === "project") {
          permissions.addRule({ permission: data.permission ?? "*", pattern, action: "allow", scope: "project", projectId: proj.projectId });
        } else {
          permissions.addRule({ permission: data.permission ?? "*", pattern, action: "allow", scope: "user" });
        }
      }
    }
    if (proj.status === "waiting" && openRequestTotal(await logFacts(sessionId)) === 0) {
      await updateProjection(sessionId, { status: shellRequest ? "idle" : "working" });
    }
  };

  const replyQuestionCore = async (
    sessionId: string,
    requestId: string,
    answers: JsonObject,
  ): Promise<void> => {
    const facts = await logFacts(sessionId);
    const original = facts.openQuestions.get(requestId);
    if (!original) {
      if (facts.askedQuestions.has(requestId)) {
        throw Object.assign(new Error("question request already answered"), { code: "conflict" });
      }
      throw Object.assign(new Error("question request not found"), { code: "not-found" });
    }
    const proj = await store.projection(sessionId);
    if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
    const rt = await ensureWired(sessionId, proj);
    const reject = Boolean((answers as { __reject?: boolean }).__reject);
    const expected: JsonObject = { answers, ...(reject ? { reject: true } : {}) };
    const choice = await broadcastTail(sessionId, () => durable.chooseResponseIntent({
      kind: "question",
      sessionId,
      requestId,
      answers,
      ...(reject ? { reject: true } : {}),
    }));
    const operation = assertChosenIntent(choice, expected);
    const questions = Array.isArray((original.data as { questions?: unknown }).questions)
      ? (original.data as { questions: JsonObject[] }).questions
      : [];
    const runtimeAnswer: JsonObject = reject
      ? { action: "reject" }
      : openCodeQuestionReply(questions, answers);
    const outcome = await runResponseOperation<Record<string, never>, void>(
      operation,
      (operationId) => rt.replyQuestionOperation
        ? rt.replyQuestionOperation(sessionId, requestId, runtimeAnswer, operationId)
        : rt.replyQuestion(sessionId, requestId, runtimeAnswer),
      () => ({}),
      {
        type: "question/answered",
        data: { requestId, ...(reject ? { rejected: true } : { answers }) },
        ignorable: true,
      },
    );
    if (outcome.kind !== "confirmed") {
      if (outcome.kind === "unknown") {
        await updateProjection(sessionId, { status: "unknown" });
        scheduleReconciliation(sessionId, proj, rt, "question-outcome-unknown");
      }
      throw outcomeError(outcome);
    }
    if (proj.status === "waiting" && openRequestTotal(await logFacts(sessionId)) === 0) {
      await updateProjection(sessionId, { status: "working" });
    }
  };

  /** F2: shape-check + existence-check attachments before anything is logged
   *  or queued. Deleted files refuse attachment with a typed error. */
  const verifyAttachments = async (
    proj: SessionProjection, raw: unknown,
  ): Promise<AttachmentRef[] | undefined> => {
    const maxBytes = deps.attachments?.maxBytes ?? 20 * 1024 * 1024;
    const refs = sanitizeAttachments(raw, { maxBytes, projectId: proj.projectId });
    if (refs.length === 0) return undefined;
    if (deps.attachments) {
      const project = await projects.get(proj.projectId);
      const root = proj.worktreePath ?? project?.path;
      if (!root) throw Object.assign(new Error("project not found"), { code: "not-found" });
      for (const ref of refs) {
        if (!ref.path) continue; // url attachments have nothing on disk
        let stat: { kind: "file" | "dir"; size: number };
        try {
          stat = await deps.attachments.stat(root, ref.path);
        } catch {
          throw Object.assign(new Error(`attachment file not found: ${ref.path}`), { code: "invalid-input" });
        }
        if (stat.kind !== "file") {
          throw Object.assign(new Error(`attachment must be a file: ${ref.path}`), { code: "invalid-input" });
        }
        if (stat.size > deps.attachments.maxBytes) {
          throw Object.assign(new Error(`attachment too large (max ${deps.attachments.maxBytes} bytes): ${ref.path}`), { code: "invalid-input" });
        }
        ref.size = stat.size; // trust disk, not the client
      }
    }
    return refs;
  };

  const enqueueMessage = async (
    sessionId: string, text: string, delivery: DeliveryMode, fallbackReason?: string,
    attachments?: AttachmentRef[], sourceOperationId?: string,
  ): Promise<SendResult> => {
    if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
    const item = await deps.queue.enqueue(sessionId, text, delivery, attachments);
    if (fallbackReason) {
      await appendAndBroadcast(sessionId, "delivery/fallback-queued", { queueId: item.id, reason: fallbackReason }, { ignorable: true });
    }
    await appendAndBroadcast(sessionId, "queue/enqueued", {
      queueId: item.id, text, delivery,
      ...(attachments?.length ? { attachments: attachments as unknown as JsonObject[] } : {}),
      ...(sourceOperationId ? { sourceOperationId } : {}),
    }, { ignorable: true });
    return { queueId: item.id, queued: true };
  };

  /** Dispatch the next queued message iff the session is idle. Never enters an
   *  active stream: re-checked after every await. */
  const dispatchQueue = async (sessionId: string): Promise<void> => {
    if (!deps.queue) return;
    try {
      await withSessionLock(sessionId, async () => {
        if (turnActive(sessionId)) return;
        const proj = await store.projection(sessionId);
        if (!proj || proj.status !== "idle") return;
        const reconciliation = await durable.reconciliation(sessionId);
        if (reconciliation?.state === "reconciling"
          || reconciliation?.state === "blocked"
          || reconciliation?.state === "unknown") return;
        const queued = await deps.queue!.queueList(sessionId);
        if (queued[0] && queueEditHeld(sessionId, queued[0].id)) return;
        const reserved = await broadcastTail(
          sessionId,
          () => deps.queue!.reserveQueueHead({ sessionId, mutationKind: "turn-submit" }),
        );
        if (reserved.kind === "empty") return;
        if (reserved.kind === "blocked" && reserved.reservation.operation.state !== "prepared") return;
        const rt = await ensureWired(
          sessionId,
          proj,
          reserved.reservation.operation.operationId,
        );
        const current = await store.projection(sessionId);
        if (!current || current.status !== "idle" || turnActive(sessionId)) return;
        await admitTurnCore(sessionId, current, rt, {
          text: reserved.reservation.queueItem.text,
          ...(reserved.reservation.queueItem.attachments?.length
            ? { attachments: reserved.reservation.queueItem.attachments }
            : {}),
        }, {
          operation: reserved.reservation.operation,
          queueId: reserved.reservation.queueItem.id,
        });
      });
    } catch (err) {
      if ((err as { code?: unknown }).code !== "outcome-unknown") {
        console.error(`[polyth] queued dispatch failed for ${sessionId}`, err);
      }
    }
  };

  /** Expansion + user/message append + startTurn. Callers already decided
   *  admission; this is the single place a text enters the model stream. */
  const admitTurnCoreUnfenced = async (
    sessionId: string, proj: SessionProjection, rt: AgentRuntime, input: UserTurnInput,
    reserved?: { operation: DurableOperation; queueId: string },
  ): Promise<SendResult> => {
    // /command and #snippet expansion happens before anything is logged, so the
    // durable log holds exactly what the model saw (plus `raw` for the UI).
    let text = input.text;
    let raw = input.text;
    let cmdAgent: string | undefined;
    let cmdModel: { providerID: string; modelID: string } | undefined;
    if (deps.expand) {
      try {
        const r = await deps.expand(proj.projectId, input.text);
        text = r.text; raw = r.raw; cmdAgent = r.agent; cmdModel = r.model;
      } catch (err) {
        console.error("[polyth] command expansion failed", err);
      }
    }
    if (input.model || input.agent) {
      await updateProjection(sessionId, {
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      });
    }
    const model = input.model ?? cmdModel ?? proj.model;
    const agent = input.agent ?? cmdAgent ?? proj.agent;
    // Model-visible behavior instructions are logged BEFORE the turn that
    // first runs under a new revision (worst case after restart: one benign
    // re-append, which replay tooling dedupes by revision).
    if (deps.behavior) {
      const cur = await deps.behavior.current().catch(() => null);
      if (cur && behaviorLogged.get(sessionId) !== cur.revision) {
        await appendAndBroadcast(sessionId, "behavior/instructions-applied", {
          revision: cur.revision, digest: cur.digest, scope: "global",
        }, { ignorable: true });
        behaviorLogged.set(sessionId, cur.revision);
      }
    }
    const decoration = hooks.beforeTurn
      ? await hooks.beforeTurn(sessionId, await store.events(sessionId))
      : null;
    const messageData: JsonObject = {
      text, ...(raw !== text ? { raw } : {}),
      ...(reserved ? { queueId: reserved.queueId } : {}),
      ...(input.githubConflictResolution === true ? { githubConflictResolution: true } : {}),
      ...(input.attachments ? { attachments: input.attachments as unknown as JsonObject[] } : {}),
      ...(decoration ? {
        recoveryContext: decoration.recoveryContext,
        compactionRecovery: {
          compactionSeq: decoration.compactionSeq,
          ...(decoration.goalRestored ? { goalRestored: true } : {}),
          ...(decoration.pinnedSourceSeqs.length
            ? { pinnedSourceSeqs: decoration.pinnedSourceSeqs }
            : {}),
        },
      } : {}),
      ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.agentProfileId ? {
        ...(model ? { resolvedModel: model as unknown as JsonObject } : {}),
        ...(agent ? { resolvedAgent: agent } : {}),
      } : {}),
    };
    let operation = reserved?.operation;
    const existingEvents = reserved ? await store.events(sessionId) : [];
    let message = reserved
      ? existingEvents.find((event) =>
          event.type === "user/message"
          && (event.data as { queueId?: unknown }).queueId === reserved.queueId)
      : undefined;
    if (reserved && !message) {
      const queued = existingEvents.findLast((event) =>
        event.type === "queue/enqueued"
        && (event.data as { queueId?: unknown }).queueId === reserved.queueId);
      const sourceOperationId = (queued?.data as { sourceOperationId?: unknown } | undefined)
        ?.sourceOperationId;
      if (typeof sourceOperationId === "string") {
        const source = await durable.operation(sourceOperationId);
        message = existingEvents.find((event) =>
          event.type === "user/message" && event.seq === source?.ownerEventSeq);
      }
    }
    if (!operation) {
      const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
        sessionId,
        mutationKind: "turn-submit",
        intentEvent: { type: "user/message", data: messageData },
      }));
      operation = prepared.operation;
      message = prepared.intentEvent;
    } else if (!message) {
      // The queue reservation is the transactionally-owned durable intent.
      // The model-visible message still lands before the claimed network call.
      message = await appendAndBroadcast(sessionId, "user/message", messageData);
    }

    admitting.add(sessionId);
    if (input.autoTitle && isPlaceholderTitle(proj.title, sessionId)) autoTitleRequested.add(sessionId);
    else autoTitleRequested.delete(sessionId);
    const outcome = await runPreparedOperation<{ admissionId?: string }, void>(
      operation,
      (operationId) => {
        const request = {
          sessionId,
          text: recoveredUserText(text, decoration?.recoveryContext),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        };
        return rt.startTurnOperation
          ? rt.startTurnOperation(request, operationId)
          : rt.startTurn(request);
      },
      () => ({}),
      reserved
        ? async (settled) => {
            if (settled.kind === "confirmed") {
              await broadcastTail(sessionId, () => deps.queue!.confirmQueueReservation(
                operation!.operationId,
                settled.receipt,
              ));
            } else if (settled.kind === "rejected") {
              await broadcastTail(sessionId, () => deps.queue!.releaseQueueReservation(
                operation!.operationId,
                { kind: "rejected", code: settled.code, message: settled.message },
              ));
            } else {
              await settleOperation(operation!, settled);
            }
          }
        : undefined,
    );
    if (outcome.kind !== "confirmed") {
      admitting.delete(sessionId);
      autoTitleRequested.delete(sessionId);
      if (outcome.kind === "rejected") {
        await appendAndBroadcast(sessionId, "turn/failed", {
          error: outcome.message,
          operationId: operation.operationId,
        }, { ignorable: true });
        await updateProjection(sessionId, { status: "failed" });
      } else {
        await updateProjection(sessionId, { status: "unknown" });
        scheduleReconciliation(sessionId, proj, rt, "mutation-outcome-unknown");
      }
      throw outcomeError(outcome);
    }
    if (decoration?.goalRestored) {
      await appendAndBroadcast(sessionId, "goal/context-restored", {
        compactionSeq: decoration.compactionSeq,
        sourceMessageSeq: message!.seq,
      }, { ignorable: true });
    }
    if (decoration?.pinnedSourceSeqs.length) {
      await appendAndBroadcast(sessionId, "context/restored", {
        compactionSeq: decoration.compactionSeq,
        sourceMessageSeq: message!.seq,
        pinnedSourceSeqs: decoration.pinnedSourceSeqs,
      }, { ignorable: true });
    }
    return { turnId: randomUUID() };
  };

  const admitTurnCore = (
    sessionId: string, proj: SessionProjection, rt: AgentRuntime, input: UserTurnInput,
    reserved?: { operation: DurableOperation; queueId: string },
  ): Promise<SendResult> => {
    const admit = () => admitTurnCoreUnfenced(sessionId, proj, rt, input, reserved);
    return deps.admission ? deps.admission.admit(admit) : admit();
  };

  /** Admission joins the same per-session serialization as runtime callbacks
   *  and Revert/Fork, closing the idle-row-vs-new-turn activation race. */
  const admitTurn = (
    sessionId: string, proj: SessionProjection, rt: AgentRuntime, input: UserTurnInput,
    reserved?: { operation: DurableOperation; queueId: string },
  ): Promise<SendResult> =>
    withSessionLock(sessionId, async () => {
      const current = (await store.projection(sessionId)) ?? proj;
      const active = turnActive(sessionId);
      const unsafeStatus = current.status === "reconciling"
        || current.status === "unknown";
      const reconciliation = await durable.reconciliation(sessionId);
      const barrier = reconciliation?.state === "reconciling"
        || reconciliation?.state === "blocked"
        || reconciliation?.state === "unknown";
      const unresolved = await blockingOperation(
        sessionId,
        reserved?.operation.operationId,
      );
      const requestsWaiting = openRequestTotal(await logFacts(sessionId)) > 0;
      if (active || unsafeStatus || barrier || unresolved || requestsWaiting) {
        if (!deps.queue || reserved) {
          throw Object.assign(new Error("turn admission changed while the request was waiting"), {
            code: "conflict",
          });
        }
        const delivery = input.delivery === "steer" || input.delivery === "interrupt"
          ? input.delivery
          : "queue";
        const reason = active
          ? "turn-active"
          : barrier
            ? "reconciliation-active"
            : unresolved
              ? "mutation-active"
              : requestsWaiting
                ? "request-waiting"
                : `session-${current.status}`;
        return enqueueMessage(
          sessionId,
          input.text,
          delivery,
          reason,
          input.attachments,
        );
      }
      return admitTurnCore(sessionId, current, rt, input, reserved);
    });

  // F14 import half: one scan shared by browse/import/sync — backend sessions
  // deduped by id, already-adopted ones filtered out, most recent first.
  const backendSessionScan = async (projectId: string) => {
    const project = await projects.get(projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    const runtime = await runtimes.forProject(projectId, project.path);
    const known = await store.projections(projectId);
    const adopted = new Set(known.map((s) => s.backendSessionId).filter(Boolean));
    const seen = new Set<string>();
    const items: RuntimeSession[] = [];
    let total = 0;
    for (const remote of await runtime.sessions()) {
      if (seen.has(remote.id)) continue;
      seen.add(remote.id);
      total += 1;
      if (adopted.has(remote.id)) continue;
      const binding = await runtimeBinding(runtime, {
        id: `candidate:${remote.id}`,
        projectId,
        title: remote.title,
        status: "idle",
        backendSessionId: remote.id,
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
      }, project.path);
      if (binding && await durable.hasDeletionTombstone({
        canonicalSessionId: binding.canonicalSessionId,
        authorityId: binding.authorityId,
        generation: binding.generation,
        location: binding.location,
        backendSessionId: remote.id,
      })) continue;
      items.push(remote);
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { project, runtime, items, total };
  };

  const service: RestartSafetySessionService = {
    async reconcileForRuntimeRestart(sessionId, runtime, expected) {
      const endpointOf = async (): Promise<RuntimeEndpoint | undefined> =>
        await (runtime as ReliabilityRuntime).endpoint?.().catch(() => undefined);
      const matchesExpected = (endpoint: RuntimeEndpoint | undefined): boolean =>
        endpoint?.authorityId === expected.authorityId
        && endpoint.generation === expected.generation;

      if (!matchesExpected(await endpointOf())) {
        return {
          safe: false,
          reason: `session ${sessionId} endpoint generation changed before safe-idle reconciliation`,
        };
      }
      const projection = await store.projection(sessionId);
      if (!projection) {
        return { safe: false, reason: `session ${sessionId} projection is unavailable` };
      }

      await reconcileUnderLock(
        sessionId,
        projection,
        runtime,
        "config-restart-safe-idle",
      );

      if (!matchesExpected(await endpointOf())) {
        return {
          safe: false,
          reason: `session ${sessionId} endpoint generation changed during safe-idle reconciliation`,
        };
      }
      const current = await store.projection(sessionId);
      if (turnActive(sessionId) || current?.status !== "idle") {
        return {
          safe: false,
          reason: `session ${sessionId} is ${current?.status ?? "unknown"} after authoritative reconciliation`,
        };
      }
      const operation = await blockingOperation(sessionId);
      if (operation) {
        return {
          safe: false,
          reason: `session ${sessionId} has ${operation.state} operation ${operation.operationId}`,
        };
      }
      return { safe: true };
    },
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const project = await projects.get(input.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      let worktree: { path: string; branch: string | null } | undefined;
      if (input.worktreePath && deps.worktrees) {
        const requested = resolve(input.worktreePath);
        worktree = (await deps.worktrees.list(project.path))
          .find((candidate) => resolve(candidate.path) === requested);
        if (!worktree) {
          throw Object.assign(new Error("worktree does not belong to this project"), { code: "invalid-input" });
        }
        input = { ...input, worktreePath: worktree.path };
      }
      const sessionId = randomUUID();
      const cwd = input.worktreePath ?? project.path;
      const now = Date.now();
      // F18: a subagent/fork child starts under the nearest parent's policy —
      // the indicator must be honest from the first projection broadcast.
      const inheritedAutoAccept = input.parentId ? await effectiveAutoAccept(input.parentId) : false;
      const projection: SessionProjection = {
        id: sessionId, projectId: project.id,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(inheritedAutoAccept ? { autoAccept: true } : {}),
        title: input.title || "New session",
        ...(input.worktreePath ? {
          worktreePath: input.worktreePath,
          worktreeId: input.worktreePath,
          worktreeState: "ready" as const,
          ...(worktree?.branch ? { branch: worktree.branch } : {}),
        } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        createdAt: now, updatedAt: now,
        status: "reconciling",
      };
      const prepared = await broadcastTail(sessionId, () => durable.prepareSessionCreate({
        projection,
        createdEvent: {
          type: "session/created",
          data: {
            title: projection.title, projectId: project.id,
            ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
            ...(input.model ? { model: input.model as unknown as JsonObject } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
          },
          ignorable: true,
        },
      }));
      broadcast.projection(projection);
      let rt: AgentRuntime;
      try {
        rt = await runtimes.forProject(project.id, cwd);
      } catch (error) {
        await broadcastTail(sessionId, () => durable.settleOperation(prepared.operation.operationId, {
          kind: "rejected",
          code: "runtime-unavailable",
          message: "runtime could not be started before session creation",
        }));
        await updateProjection(sessionId, { status: "failed" });
        throw error;
      }
      const outcome = await runPreparedOperation<{ backendSessionId: string }, string>(
        prepared.operation,
        (operationId) => {
          const request = { ...input, sessionId, cwd };
          return rt.createSessionOperation
            ? rt.createSessionOperation(request, operationId)
            : rt.ensureSession(request);
        },
        (backendSessionId) => ({ backendSessionId }),
      );
      if (outcome.kind !== "confirmed") {
        await updateProjection(sessionId, {
          status: outcome.kind === "unknown" ? "unknown" : "failed",
        });
        throw outcomeError(outcome);
      }
      const completed: SessionProjection = {
        ...projection,
        backendSessionId: outcome.value.backendSessionId,
        runtimeBinding: await newRuntimeBinding(
          rt,
          outcome.value.backendSessionId,
          cwd,
          "empty",
        ),
        status: "reconciling",
        updatedAt: Date.now(),
      };
      await store.upsertProjection(completed);
      wire(sessionId, rt);
      broadcast.projection(completed);
      if (typeof (rt as ReliabilityRuntime).reconcile === "function") {
        await reconcileSession(
          sessionId,
          completed,
          rt,
          "session-created",
          prepared.operation.operationId,
        );
      } else if (typeof (rt as ReliabilityRuntime).endpoint !== "function") {
        // Provider-neutral test/compatibility runtimes predate endpoint
        // evidence. A confirmed create remains their admission boundary;
        // managed OpenCode runtimes always expose endpoint + reconcile and
        // cannot take this compatibility path.
        await updateProjection(sessionId, { status: "idle" });
      } else {
        await updateProjection(sessionId, { status: "unknown" });
      }
      return { id: sessionId };
    },

    async send(sessionId, input: UserTurnInput): Promise<SendResult> {
      let proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      // Attachments are verified before any state changes (rewind reset,
      // queueing, admission) so a bad ref can never dirty the durable log.
      if (input.attachments !== undefined) {
        const verified = await verifyAttachments(proj, input.attachments);
        input = { ...input };
        if (verified) input.attachments = verified;
        else delete input.attachments;
      }
      if (proj.status === "reconciling" || proj.status === "unknown") {
        throw Object.assign(new Error(`cannot send while the session is ${proj.status}`), {
          code: "conflict",
        });
      }
      const existingReconciliation = await durable.reconciliation(sessionId);
      if (existingReconciliation?.state === "reconciling"
        || existingReconciliation?.state === "blocked"
        || existingReconciliation?.state === "unknown") {
        throw Object.assign(
          new Error(`cannot send while reconciliation is ${existingReconciliation.state}`),
          { code: "conflict" },
        );
      }
      const existingOperation = await blockingOperation(sessionId);
      if (existingOperation) {
        throw Object.assign(
          new Error(`cannot send while operation ${existingOperation.operationId} is ${existingOperation.state}`),
          { code: "conflict" },
        );
      }
      const rt = await ensureWired(sessionId, proj);
      proj = (await store.projection(sessionId)) ?? proj;
      if (proj.status === "reconciling" || proj.status === "unknown") {
        throw Object.assign(new Error(`cannot send while the session is ${proj.status}`), {
          code: "conflict",
        });
      }

      // A replacement send after rewind must not continue in the backend's
      // stale conversation — and it must not reset into an EMPTY backend
      // either. Prepare a backend branch that holds the exact canonical
      // effective history before the target, then resolve the marker and admit
      // the new tail. If branch preparation fails the rewind and draft remain
      // active and no event is appended. The facts cache answers "is a rewind
      // active" with a tail read; the full log is only replayed on the rare
      // rewound path below.
      if ((await logFacts(sessionId)).rewind) {
        proj = await withSessionLock(sessionId, async () => {
          const events = await store.events(sessionId);
          const rewind = activeRewind(events);
          let current = (await store.projection(sessionId)) ?? proj!;
          if (!rewind) return current; // resolved concurrently — plain send
          if (!rt.branchSession) {
            throw Object.assign(new Error("runtime cannot branch rewound history"), { code: "unsupported" });
          }
          const project = await projects.get(current.projectId);
          const cwd = current.worktreePath ?? project?.path ?? process.cwd();
          // deriveMessages already applies the active marker, so this is the
          // exact effective model history before the reverted prompt.
          const request = {
            sourceSessionId: sessionId,
            target: {
              projectId: current.projectId,
              title: current.title,
              sessionId,
              cwd,
              ...(current.model ? { model: current.model } : {}),
              ...(current.agent ? { agent: current.agent } : {}),
            },
            history: deriveMessages(events),
          };
          const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
            sessionId,
            mutationKind: "session-revert",
            intentEvent: {
              type: "session/replacement-intended",
              data: { rewindSeq: rewind.markerSeq, atSeq: rewind.atSeq },
              ignorable: true,
            },
          }));
          const outcome = await runPreparedOperation<{ backendSessionId: string }, string>(
            prepared.operation,
            (operationId) => rt.branchSessionOperation
              ? rt.branchSessionOperation(request, operationId)
              : rt.branchSession!(request),
            (backendSessionId) => ({ backendSessionId }),
          );
          if (outcome.kind !== "confirmed") {
            if (outcome.kind === "unknown") {
              await updateProjection(sessionId, { status: "unknown" });
              scheduleReconciliation(sessionId, current, rt, "revert-outcome-unknown");
            }
            throw outcomeError(outcome);
          }
          const backendSessionId = outcome.value.backendSessionId;
          await updateProjection(sessionId, { backendSessionId, status: "idle" });
          current = { ...current, backendSessionId, status: "idle" };
          await appendAndBroadcast(sessionId, "session/rewind-cleared", {
            rewindSeq: rewind.markerSeq,
            replaced: true,
          });
          return current;
        });
      }

      // Atomic profile application: resolve to explicit model/agent up front so
      // no intermediate invalid combination can reach the runtime. Explicit
      // per-send model/agent still win over the profile's bundle.
      // UX-COMPOSER-DISC: a string selects a profile, explicit null clears the
      // session's stored profile, and an omitted field inherits it.
      const requestedProfile = input.agentProfileId; // string | null | undefined
      const effectiveProfileId = requestedProfile === undefined
        ? proj.agentProfileId
        : requestedProfile ?? undefined;
      if (effectiveProfileId && deps.profiles) {
        const profile = await deps.profiles.profileGet(effectiveProfileId);
        // An explicitly requested profile must exist; a stored (inherited)
        // profile that was deleted degrades to the projection's persisted
        // resolved model/agent rather than failing every later send.
        if (!profile && requestedProfile !== undefined) {
          throw Object.assign(new Error("agent profile not found"), { code: "not-found" });
        }
        if (profile) {
          input = {
            ...input,
            // the durable user/message records the actually applied profile id
            agentProfileId: effectiveProfileId,
            model: input.model ?? { providerID: profile.providerID, modelID: profile.modelID },
            ...(input.agent ?? profile.agent ? { agent: input.agent ?? profile.agent } : {}),
          };
        }
      }
      // Persist the explicit selection or clear after resolution succeeded, so
      // an unknown profile id can never be recorded.
      if (requestedProfile !== undefined && (proj.agentProfileId ?? undefined) !== (requestedProfile ?? undefined)) {
        await setProjectionProfile(sessionId, requestedProfile ?? undefined);
      }
      // Send-time arbitration first: resolution events precede queue/user events.
      if (input.dismissPending) await dismissPendingRequests(sessionId, rt);

      const delivery: DeliveryMode = input.delivery ?? "normal";
      const active = turnActive(sessionId);

      if (active && deps.queue) {
        if (delivery === "queue") return enqueueMessage(sessionId, input.text, "queue", undefined, input.attachments);
        if (delivery === "normal") {
          // idle race: the turn started between the client's check and admission
          return enqueueMessage(sessionId, input.text, "queue", "turn-active", input.attachments);
        }
        if (delivery === "steer") {
          const caps = await rt.capabilities().catch(() => null);
          if (!caps?.steering || !rt.steer) {
            return enqueueMessage(sessionId, input.text, "steer", "steer-unsupported", input.attachments);
          }
          // Steering is text-only in the runtime seam; attachments would be
          // silently dropped mid-turn, so they queue for the next turn instead.
          if (input.attachments?.length) {
            return enqueueMessage(sessionId, input.text, "steer", "steer-attachments", input.attachments);
          }
          const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
            sessionId,
            mutationKind: "turn-steer",
            intentEvent: {
              type: "user/message",
              data: { text: input.text, delivery: "steer" },
            },
          }));
          const outcome = await runPreparedOperation<Record<string, never>, boolean>(
            prepared.operation,
            async (operationId) => {
              try {
                const value = await (rt.steerOperation
                  ? rt.steerOperation(sessionId, input.text, operationId)
                  : rt.steer!(sessionId, input.text));
                if (isMutationOutcome<Record<string, never>>(value)) return value;
                return value
                  ? { kind: "confirmed" as const, value: {} }
                  : {
                      kind: "rejected" as const,
                      code: "steer-not-admitted",
                      message: "runtime rejected live steering",
                    };
              } catch (error) {
                throw error;
              }
            },
            () => ({}),
          );
          if (outcome.kind === "rejected") {
            return enqueueMessage(
              sessionId,
              input.text,
              "steer",
              "steer-rejected",
              undefined,
              prepared.operation.operationId,
            );
          }
          if (outcome.kind === "unknown") {
            await updateProjection(sessionId, { status: "unknown" });
            scheduleReconciliation(sessionId, proj!, rt, "steer-outcome-unknown");
            throw outcomeError(outcome);
          }
          await appendAndBroadcast(sessionId, "delivery/steered", { text: input.text }, { ignorable: true });
          return { turnId: lastTurnId.get(sessionId) ?? randomUUID() };
        }
        if (delivery === "interrupt") {
          // enqueue at the head, then abort; turn/stopped(aborted) dispatches it
          const item = await deps.queue.enqueue(sessionId, input.text, "interrupt", input.attachments);
          const rest = await deps.queue.queueList(sessionId);
          const ids = [item.id, ...rest.filter((i) => i.id !== item.id).map((i) => i.id)];
          if (ids.length > 1) await deps.queue.queueReorder(sessionId, ids);
          await appendAndBroadcast(sessionId, "queue/enqueued", {
            queueId: item.id, text: input.text, delivery,
            ...(input.attachments?.length ? { attachments: input.attachments as unknown as JsonObject[] } : {}),
          }, { ignorable: true });
          const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
            sessionId,
            mutationKind: "turn-abort",
            intentEvent: {
              type: "turn/abort-requested",
              data: { reason: "interrupt", queueId: item.id },
              ignorable: true,
            },
          }));
          const outcome = await runPreparedOperation<Record<string, never>, void>(
            prepared.operation,
            (operationId) => rt.abortOperation
              ? rt.abortOperation(sessionId, operationId)
              : rt.abort(sessionId),
            () => ({}),
          );
          if (outcome.kind === "unknown") {
            await updateProjection(sessionId, { status: "unknown" });
            scheduleReconciliation(sessionId, proj!, rt, "abort-outcome-unknown");
          } else if (outcome.kind === "rejected") {
            throw outcomeError(outcome);
          }
          return { queueId: item.id, queued: true };
        }
      }

      // Idle with older queued items: preserve FIFO — this message joins the
      // queue and the head dispatches now.
      if (!active && deps.queue && delivery !== "interrupt") {
        const pendingQueue = await deps.queue.queueList(sessionId);
        if (pendingQueue.length > 0) {
          const res = await enqueueMessage(sessionId, input.text, delivery === "steer" ? "steer" : "queue", undefined, input.attachments);
          void dispatchQueue(sessionId);
          return res;
        }
      }

      return admitTurn(sessionId, proj, rt, input);
    },

    async queueList(sessionId) {
      if (!deps.queue) return [];
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return deps.queue.queueList(sessionId);
    },
    async queueEditStart(sessionId, queueId) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const item = (await deps.queue.queueList(sessionId)).find((candidate) => candidate.id === queueId);
      if (!item) throw Object.assign(new Error("queued message has already started"), { code: "conflict" });
      const holds = queueEditHolds.get(sessionId) ?? new Map<string, number>();
      holds.set(queueId, Date.now() + QUEUE_EDIT_HOLD_MS);
      queueEditHolds.set(sessionId, holds);
      return item;
    },
    async queueEdit(sessionId, queueId, text) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const nextText = text.trim();
      if (!nextText) throw Object.assign(new Error("queued message text is required"), { code: "invalid-input" });
      const item = await deps.queue.queueEdit(sessionId, queueId, nextText);
      if (!item) throw Object.assign(new Error("queue item not found"), { code: "not-found" });
      await appendAndBroadcast(sessionId, "queue/edited", { queueId, text: nextText }, { ignorable: true });
      releaseQueueEditHold(sessionId, queueId);
      void dispatchQueue(sessionId);
      return item;
    },
    async queueEditCancel(sessionId, queueId) {
      releaseQueueEditHold(sessionId, queueId);
      void dispatchQueue(sessionId);
    },
    async queueReorder(sessionId, ids) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const items = await deps.queue.queueReorder(sessionId, ids);
      await appendAndBroadcast(sessionId, "queue/reordered", { ids }, { ignorable: true });
      return items;
    },
    async queueRemove(sessionId, queueId) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const removed = await deps.queue.queueRemove(sessionId, queueId);
      if (!removed) throw Object.assign(new Error("queue item not found"), { code: "not-found" });
      await appendAndBroadcast(sessionId, "queue/removed", { queueId }, { ignorable: true });
    },

    async pinContext(sessionId, sourceEventSeq) {
      return withSessionLock(sessionId, async () => {
        if (!Number.isSafeInteger(sourceEventSeq) || sourceEventSeq <= 0) {
          throw Object.assign(new Error("sourceEventSeq must be a positive event sequence"), { code: "invalid-input" });
        }
        if (!(await store.projection(sessionId))) {
          throw Object.assign(new Error("session not found"), { code: "not-found" });
        }
        const source = (await store.events(sessionId)).find((event) => event.seq === sourceEventSeq);
        if (source?.type !== "user/message" && source?.type !== "assistant/message") {
          throw Object.assign(new Error("pin target must be a user or assistant message"), { code: "invalid-input" });
        }
        return appendAndBroadcast(
          sessionId,
          "context/pinned",
          { sourceEventSeq },
          { ignorable: true },
        );
      });
    },

    async unpinContext(sessionId, sourceEventSeq) {
      return withSessionLock(sessionId, async () => {
        if (!Number.isSafeInteger(sourceEventSeq) || sourceEventSeq <= 0) {
          throw Object.assign(new Error("sourceEventSeq must be a positive event sequence"), { code: "invalid-input" });
        }
        if (!(await store.projection(sessionId))) {
          throw Object.assign(new Error("session not found"), { code: "not-found" });
        }
        const source = (await store.events(sessionId)).find((event) => event.seq === sourceEventSeq);
        if (source?.type !== "user/message" && source?.type !== "assistant/message") {
          throw Object.assign(new Error("pin target must be a user or assistant message"), { code: "invalid-input" });
        }
        return appendAndBroadcast(
          sessionId,
          "context/unpinned",
          { sourceEventSeq },
          { ignorable: true },
        );
      });
    },

    async abort(sessionId) {
      await withSessionLock(sessionId, async () => {
        const projection = await store.projection(sessionId);
        if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
        const runtime = sessionRuntime.get(sessionId) ?? await ensureWired(sessionId, projection);
        const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
          sessionId,
          mutationKind: "turn-abort",
          intentEvent: {
            type: "turn/abort-requested",
            data: { reason: "user" },
            ignorable: true,
          },
        }));
        const outcome = await runPreparedOperation<Record<string, never>, void>(
          prepared.operation,
          (operationId) => runtime.abortOperation
            ? runtime.abortOperation(sessionId, operationId)
            : runtime.abort(sessionId),
          () => ({}),
        );
        if (outcome.kind === "unknown") {
          await updateProjection(sessionId, { status: "unknown" });
          scheduleReconciliation(sessionId, projection, runtime, "abort-outcome-unknown");
        } else if (outcome.kind === "rejected") {
          throw outcomeError(outcome);
        }
      });
    },

    // UX-MSG-ACTIONS Fork: backend branch is prepared FIRST; the canonical
    // child (prefix + projection + one lineage marker) publishes in a single
    // store transaction only after the backend id is verified. Failure at any
    // stage leaves the source selected and creates no optimistic child.
    async fork(sessionId, atSeq): Promise<ForkResult> {
      return withSessionLock(sessionId, async () => {
        const { proj, events } = await assertMutable(sessionId);
        const eff = effectiveHistory(events);
        let draft: ForkDraft | undefined;
        let prefix: SessionEvent[];
        if (atSeq !== undefined) {
          // Per-message fork: the child prefix ends strictly BEFORE the target
          // user message; the excluded prompt returns only as an editable draft.
          if (!Number.isSafeInteger(atSeq) || atSeq <= 0) {
            throw Object.assign(new Error("atSeq must be a positive event sequence"), { code: "invalid-input" });
          }
          if (eff.rewind) {
            throw Object.assign(new Error("restore or replace the current rewind first"), { code: "conflict" });
          }
          const target = eff.events.find((ev) => ev.seq === atSeq);
          if (!target) throw Object.assign(new Error("fork event not found"), { code: "not-found" });
          if (target.type !== "user/message") {
            throw Object.assign(new Error("fork target must be a user message"), { code: "invalid-input" });
          }
          const d = target.data as { raw?: unknown; text?: unknown; attachments?: unknown };
          draft = {
            text: typeof d.raw === "string" ? d.raw : typeof d.text === "string" ? d.text : "",
            ...(Array.isArray(d.attachments) && d.attachments.length
              ? { attachments: d.attachments as AttachmentRef[] }
              : {}),
          };
          prefix = eff.events.filter((ev) => ev.seq < atSeq);
        } else {
          // Whole-session fork: the complete effective history at the locked
          // source tail; no draft.
          prefix = eff.events;
        }
        const copiedThroughSeq = prefix.length > 0 ? prefix[prefix.length - 1]!.seq : 0;
        const history = deriveMessages(prefix);

        const forkId = randomUUID();
        const project = await projects.get(proj.projectId);
        const forkCwd = proj.worktreePath ?? project?.path ?? process.cwd();
        // ensureWired (not a bare runtime lookup): after a server restart the
        // adapter has no canonical→backend mapping yet, and branchSession must
        // resolve the SOURCE session's backend id to fork from it.
        const rt = await ensureWired(sessionId, proj);
        const title = `${proj.title} (fork)`;
        const target: CreateSessionInput & { sessionId: string; cwd: string } = {
          projectId: proj.projectId, title, sessionId: forkId, cwd: forkCwd,
          ...(proj.model ? { model: proj.model } : {}),
          ...(proj.agent ? { agent: proj.agent } : {}),
        };
        // An empty prefix needs no branch — a fresh backend session already
        // represents the same (empty) history. Anything else requires exact
        // branching; approximating with a hidden prompt is forbidden.
        if (history.length > 0 && !rt.branchSession) {
          throw Object.assign(new Error("runtime cannot branch exact history"), { code: "unsupported" });
        }
        const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
          sessionId,
          mutationKind: "session-fork",
          intentEvent: {
            type: "session/fork-intended",
            data: {
              childSessionId: forkId,
              copiedThroughSeq,
              ...(atSeq !== undefined ? { sourceAtSeq: atSeq } : {}),
            },
            ignorable: true,
          },
        }));
        const outcome = await runPreparedOperation<{ backendSessionId: string }, string>(
          prepared.operation,
          (operationId) => history.length === 0
            ? (rt.createSessionOperation
                ? rt.createSessionOperation(target, operationId)
                : rt.ensureSession(target))
            : (rt.branchSessionOperation
                ? rt.branchSessionOperation({
                    sourceSessionId: sessionId,
                    target,
                    history,
                  }, operationId)
                : rt.branchSession!({
                    sourceSessionId: sessionId,
                    target,
                    history,
                  })),
          (backendSessionId) => ({ backendSessionId }),
        );
        if (outcome.kind !== "confirmed") {
          if (outcome.kind === "unknown") {
            await updateProjection(sessionId, { status: "unknown" });
            scheduleReconciliation(sessionId, proj, rt, "fork-outcome-unknown");
          }
          throw outcomeError(outcome);
        }
        const backendSessionId = outcome.value.backendSessionId;

        const now = Date.now();
        const projection: SessionProjection = {
          ...proj, id: forkId, parentId: sessionId, title,
          status: "reconciling",
          createdAt: now,
          updatedAt: now,
          backendSessionId,
          runtimeBinding: await newRuntimeBinding(rt, backendSessionId, forkCwd, "copied"),
        };
        const markerData: SessionForkedData = {
          fromSessionId: sessionId,
          ...(atSeq !== undefined ? { sourceAtSeq: atSeq } : {}),
          copiedThroughSeq,
          ...(draft ? { draft } : {}),
        };
        let published: ChildSnapshotResult;
        try {
          if (store.publishChildSession) {
            published = await store.publishChildSession({
              childSessionId: forkId,
              events: prefix.map((ev) => ({
                time: ev.time, type: ev.type, data: ev.data,
                ...(ev.ignorable ? { ignorable: true as const } : {}),
                ...(ev.surfaceOp ? { surfaceOp: ev.surfaceOp } : {}),
                ...(ev.producerPlugin ? { producerPlugin: ev.producerPlugin } : {}),
                sourceSeq: ev.seq,
              })),
              projection,
              marker: { type: "session/forked", data: markerData as unknown as JsonObject, ignorable: true },
            });
          } else {
            // Fallback for stores without the atomic child-snapshot seam:
            // same content, same provenance, without single-transaction wrap.
            const copied: SessionEvent[] = [];
            for (const ev of prefix) {
              copied.push(await store.append(forkId, ev.type, ev.data, {
                ...(ev.ignorable ? { ignorable: true } : {}),
                ...(ev.surfaceOp ? { surfaceOp: ev.surfaceOp } : {}),
                sourceEventSeqs: [ev.seq],
              }));
            }
            await store.upsertProjection(projection);
            const marker = await store.append(
              forkId, "session/forked", markerData as unknown as JsonObject, { ignorable: true },
            );
            published = { events: copied, marker };
          }
        } catch (err) {
          // The branch mutation is confirmed and durably identified. Do not
          // issue an unowned best-effort delete outside the outcome machine.
          throw err;
        }
        wire(forkId, rt);
        // append-before-broadcast: nothing above was visible; everything below
        // reflects only the committed transaction.
        for (const ev of published.events) broadcast.event(ev);
        broadcast.event(published.marker);
        broadcast.projection(projection);
        if (typeof (rt as ReliabilityRuntime).reconcile === "function") {
          await reconcileSession(
            forkId,
            projection,
            rt,
            "session-forked",
          );
        } else if (typeof (rt as ReliabilityRuntime).endpoint !== "function") {
          await updateProjection(forkId, { status: "idle" });
        } else {
          await updateProjection(forkId, { status: "unknown" });
        }
        return {
          id: forkId,
          fromSessionId: sessionId,
          ...(atSeq !== undefined ? { sourceAtSeq: atSeq } : {}),
          ...(draft ? { draft } : {}),
        };
      });
    },

    async rewind(sessionId, atSeq): Promise<SessionEvent> {
      return withSessionLock(sessionId, async () => {
        const { events } = await assertMutable(sessionId);
        if (!Number.isSafeInteger(atSeq) || atSeq <= 0) {
          throw Object.assign(new Error("atSeq must be a positive event sequence"), { code: "invalid-input" });
        }
        const eff = effectiveHistory(events);
        if (eff.rewind) {
          throw Object.assign(new Error("restore or replace the current rewind first"), { code: "conflict" });
        }
        // Only a VISIBLE user message is a valid target — a prompt inside a
        // previously replaced tail no longer exists in effective history.
        const target = eff.events.find((ev) => ev.seq === atSeq);
        if (!target) throw Object.assign(new Error("rewind event not found"), { code: "not-found" });
        if (target.type !== "user/message") {
          throw Object.assign(new Error("rewind target must be a user message"), { code: "invalid-input" });
        }
        // The marker carries no prompt copy: the target user/message already
        // owns raw text and attachments, and the draft derives from replay.
        return appendAndBroadcast(sessionId, "session/rewound", { atSeq });
      });
    },

    async clearRewind(sessionId): Promise<SessionEvent> {
      return withSessionLock(sessionId, async () => {
        const { events } = await assertMutable(sessionId);
        const rewind = activeRewind(events);
        if (!rewind) throw Object.assign(new Error("session has no active rewind"), { code: "conflict" });
        return appendAndBroadcast(sessionId, "session/rewind-cleared", { rewindSeq: rewind.markerSeq });
      });
    },

    async runShell(sessionId, command) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (!deps.shell) throw Object.assign(new Error("composer shell unavailable"), { code: "unsupported" });
      if (turnActive(sessionId) || proj.status === "working" || proj.status === "waiting") {
        throw Object.assign(new Error("cannot run a composer shell command during an active turn"), { code: "conflict" });
      }
      const cmd = command.trim();
      if (!cmd || cmd.length > 8_000 || cmd.includes("\0")) {
        throw Object.assign(new Error("shell command required (≤8000 chars)"), { code: "invalid-input" });
      }
      const callId = `shell_${randomUUID()}`;
      const verdict = permissions.evaluate("shell", [cmd], proj.projectId, sessionId);
      if (verdict === "deny") {
        await finishShell(sessionId, proj, cmd, callId, true);
        return { callId, status: "rejected" };
      }
      if (verdict === "ask") {
        const requestId = `per_${randomUUID()}`;
        await appendAndBroadcast(sessionId, "permission/requested", {
          requestId,
          permission: "shell",
          patterns: [cmd],
          tool: "shell",
          callId,
          preview: buildPermissionPreview({ permission: "shell", patterns: [cmd], tool: "shell" }) as unknown as JsonObject,
          allowedScopes: [...PERMISSION_ALLOWED_SCOPES],
        }, { ignorable: true, producerPlugin: "composer-shell" });
        await updateProjection(sessionId, { status: "waiting" });
        return { callId, requestId, status: "pending" };
      }
      await finishShell(sessionId, proj, cmd, callId);
      return { callId, status: "completed" };
    },

    async archive(sessionId) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (proj.status === "archived") return; // idempotent: no duplicate events
      await appendAndBroadcast(sessionId, "session/archived", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "archived" });
      // Release the dispatch slot when idle. A mid-turn archive stays wired:
      // model-visible content must keep landing in the log until the turn
      // stops; ensureWired re-wires lazily after a restore.
      if (!turnActive(sessionId)) unwire(sessionId);
    },
    async restore(sessionId) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (proj.status !== "archived") return; // idempotent
      await appendAndBroadcast(sessionId, "session/restored", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "idle" });
    },

    // Hard delete (UX-SHELL-CONSOLIDATION-02): destructive intent is confirmed
    // upstream (the UI confirms running/pending sessions before calling this).
    // Runs under the per-session lock so it can never interleave with a turn
    // callback; a still-running turn is aborted before the log is removed.
    async delete(sessionId) {
      return withSessionLock(sessionId, async () => {
        const proj = await store.projection(sessionId);
        if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
        const active = turnActive(sessionId);
        const project = await projects.get(proj.projectId);
        const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
        const rt = sessionRuntime.get(sessionId) ?? (proj.backendSessionId
          ? await runtimes.forProject(proj.projectId, cwd)
          : undefined);
        // Drop callbacks before abort/delete I/O. A synchronous turn/stopped
        // emitted by abort must never be queued for the soon-tombstoned log.
        unwire(sessionId);
        lastTurnId.delete(sessionId);
        admitting.delete(sessionId);
        if (active && rt) {
          const abortPrepared = await broadcastTail(sessionId, () => durable.prepareOperation({
            sessionId,
            mutationKind: "turn-abort",
            intentEvent: {
              type: "turn/abort-requested",
              data: { reason: "session-delete" },
              ignorable: true,
            },
          }));
          await runPreparedOperation<Record<string, never>, void>(
            abortPrepared.operation,
            (operationId) => rt.abortOperation
              ? rt.abortOperation(sessionId, operationId)
              : rt.abort(sessionId),
            () => ({}),
          );
        }
        const binding = rt
          ? await runtimeBinding(rt, proj, cwd)
          : proj.backendSessionId
            ? {
                canonicalSessionId: sessionId,
                backendSessionId: proj.backendSessionId,
                authorityId: `legacy:${proj.projectId}:${cwd}`,
                generation: 0,
                continuity: "generation-only" as const,
                location: { directory: cwd },
              }
            : undefined;
        const deletion = await durable.prepareSessionDeletion({
          binding: {
            canonicalSessionId: sessionId,
            authorityId: binding?.authorityId ?? `legacy:${proj.projectId}:${cwd}`,
            generation: binding?.generation ?? 0,
            location: binding?.location ?? { directory: cwd },
            // An unknown create has no protocol-proven backend id. Retaining
            // the canonical id still prevents canonical resurrection; Agent F
            // must supply operation lookup to bind an unknown backend child.
            backendSessionId: binding?.backendSessionId ?? `unknown:${sessionId}`,
          },
        });
        factsCache.delete(sessionId);
        await claimOperation(deletion.operation);
        let outcome: MutationOutcome<Record<string, never>>;
        if ((!rt?.discardSession && !rt?.discardSessionOperation) || !proj.backendSessionId) {
          outcome = {
            kind: "unknown",
            operationId: deletion.operation.operationId,
            message: "runtime cannot prove upstream session deletion",
          };
        } else {
          try {
            const value = await boundedRuntimeAwait<
              void | MutationOutcome<Record<string, never>>
            >(
              rt.discardSessionOperation
                ? rt.discardSessionOperation(sessionId, deletion.operation.operationId)
                : rt.discardSession!(sessionId),
              deletion.operation.operationId,
            );
            outcome = isMutationOutcome<Record<string, never>>(value)
              ? value
              : {
                  kind: "unknown",
                  operationId: deletion.operation.operationId,
                  message: "legacy best-effort deletion has no authoritative receipt",
                };
          } catch {
            outcome = {
              kind: "unknown",
              operationId: deletion.operation.operationId,
              message: "runtime did not provide a definitive deletion outcome",
            };
          }
        }
        await settleOperation(deletion.operation, outcome);
        if (outcome.kind === "confirmed") {
          await durable.retireDeletionTombstone(sessionId, { kind: "confirmed" });
        }
      });
    },

    async rename(sessionId, title) {
      return withSessionLock(sessionId, async () => {
        const t = title.trim();
        if (!t || t.length > 200) throw Object.assign(new Error("title required (≤200 chars)"), { code: "invalid-input" });
        const proj = await store.projection(sessionId);
        if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
        await appendAndBroadcast(sessionId, "session/metadata-changed", { title: t }, { ignorable: true });
        await updateProjection(sessionId, { title: t });
      });
    },

    async organize(sessionId, patch: SessionOrganizePatch) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const next: Partial<SessionProjection> = {};
      if (patch.folderId !== undefined) {
        if (patch.folderId === null) {
          next.folderId = undefined;
        } else {
          if (!deps.org) throw Object.assign(new Error("folders unavailable"), { code: "unsupported" });
          const folders = await deps.org.folderList(proj.projectId);
          if (!folders.some((f) => f.id === patch.folderId)) {
            // absent or cross-project — both are rejected the same way
            throw Object.assign(new Error("folder not found in this project"), { code: "invalid-input" });
          }
          next.folderId = patch.folderId;
        }
      }
      if (patch.labelIds !== undefined) next.labelIds = patch.labelIds;
      if (patch.pinned !== undefined) {
        if (patch.pinned === null) {
          next.pinned = undefined;
        } else {
          const position = patch.pinned.position;
          if (!Number.isSafeInteger(position) || position < 0 || position > 100_000) {
            throw Object.assign(new Error("pin position must be an integer from 0 to 100000"), { code: "invalid-input" });
          }
          next.pinned = { position };
        }
      }
      // Pin state is organization metadata, not model-visible session history.
      if (patch.folderId !== undefined || patch.labelIds !== undefined) {
        await appendAndBroadcast(sessionId, "session/metadata-changed", {
          ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
          ...(patch.labelIds !== undefined ? { labelIds: patch.labelIds } : {}),
        }, { ignorable: true });
      }
      // folderId: undefined must actually clear the stored key
      const current = await store.projection(sessionId);
      if (!current) return;
      const merged = { ...current, ...next, updatedAt: Date.now() };
      if (patch.folderId === null) delete merged.folderId;
      if (patch.pinned === null) delete merged.pinned;
      await store.upsertProjection(merged);
      broadcast.projection(merged);
    },

    async markWorktreeMissing(projectId, worktreePath) {
      const missingPath = resolve(worktreePath);
      for (const projection of await store.projections(projectId)) {
        if (!projection.worktreePath || resolve(projection.worktreePath) !== missingPath) continue;
        const next: SessionProjection = {
          ...projection,
          worktreeState: "missing",
          updatedAt: Date.now(),
        };
        await store.upsertProjection(next);
        broadcast.projection(next);
      }
    },

    async list(projectId) {
      const projections = await store.projections(projectId);
      if (!deps.org || projections.length === 0) return projections;
      // Attention badges derive from durable events on every read (WP5).
      const counts = await deps.org.attentionFor(projections.map((p) => p.id)).catch(() => ({} as Record<string, { questions: number; permissions: number }>));
      return projections.map((p) => {
        const c = counts[p.id];
        return c ? { ...p, attention: { questions: c.questions, permissions: c.permissions, unread: 0 } } : p;
      });
    },
    async sync(projectId) {
      // F14: bulk adopt-everything, kept for programmatic use. The web now
      // browses /api/control/backend-sessions and imports selectively.
      const { items } = await backendSessionScan(projectId);
      if (items.length > 0) {
        await this.importBackendSessions!(projectId, items.map((r) => r.id));
      }
      return store.projections(projectId);
    },
    async backendSessions(projectId) {
      const { items, total } = await backendSessionScan(projectId);
      return { items, total };
    },
    async importBackendSessions(projectId, backendIds) {
      const { project, runtime, items } = await backendSessionScan(projectId);
      const wanted = new Set(backendIds);
      const out: SessionProjection[] = [];
      for (const remote of items) {
        if (!wanted.has(remote.id)) continue;
        const id = randomUUID();
        const projection: SessionProjection = {
          id,
          projectId,
          title: remote.title,
          status: "reconciling",
          backendSessionId: remote.id,
          runtimeBinding: await newRuntimeBinding(runtime, remote.id, project.path, "import"),
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
        };
        // History is NOT fetched here — importing full histories for every
        // remote session at once is what OOM'd the server. It is imported
        // lazily in events() the first time the session is opened.
        await store.upsertProjection(projection);
        await appendAndBroadcast(id, "session/imported", { backendSessionId: remote.id }, { ignorable: true });
        broadcast.projection(projection);
        await ensureWired(id, projection);
        out.push((await store.projection(id)) ?? projection);
      }
      return out;
    },
    async snapshot(sessionId) {
      const p = await store.projection(sessionId);
      if (!p) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return p;
    },
    async events(sessionId, afterSeq, page) {
      if (afterSeq === 0 && !sessionRuntime.has(sessionId)) {
        const projection = await store.projection(sessionId);
        if (projection && (projection.backendSessionId || projection.status === "unknown")) {
          try {
            await ensureWired(sessionId, projection);
          } catch (error) {
            console.warn(`[polyth] failed to materialize runtime session ${sessionId}`, error);
          }
        }
      }
      // Restart recovery: opening an idle session with persisted queued
      // messages resumes FIFO dispatch (never into an active stream).
      if (afterSeq === 0 && deps.queue && !turnActive(sessionId)) {
        void deps.queue.queueList(sessionId).then((q) => {
          if (q.length > 0) return dispatchQueue(sessionId);
          return undefined;
        }).catch(() => {});
      }
      // Lazy history import: one-time, bounded, only for sessions adopted
      // from OpenCode. Importing all histories eagerly at sync time is what
      // OOM'd the server, so history arrives the first time a session opens.
      if (afterSeq === 0) {
        const proj = await store.projection(sessionId);
        if (proj?.backendSessionId) {
          // Indexed existence checks; scanning the whole log to answer two
          // booleans made every session open O(events).
          let imported: boolean;
          let fetched: boolean;
          if (store.hasEventOfType) {
            [imported, fetched] = await Promise.all([
              store.hasEventOfType(sessionId, "session/imported"),
              store.hasEventOfType(sessionId, "session/history-imported"),
            ]);
          } else {
            const all = await store.events(sessionId);
            imported = all.some((e) => e.type === "session/imported");
            fetched = all.some((e) => e.type === "session/history-imported");
          }
          if (imported && !fetched) {
            try {
              const rt = await ensureWired(sessionId, proj);
              for (const message of await rt.history(proj.backendSessionId)) {
                await appendAndBroadcast(sessionId, message.role === "user" ? "user/message" : "assistant/message", {
                  partId: `import_${randomUUID()}`, text: message.text,
                  ...(message.reasoning ? { reasoning: message.reasoning } : {}),
                });
              }
              await appendAndBroadcast(sessionId, "session/history-imported", {}, { ignorable: true });
            } catch (err) {
              console.warn(`[polyth] failed to import history for ${sessionId}`, err);
            }
          }
        }
      }
      return store.events(sessionId, afterSeq, page);
    },

    async debug(sessionId) {
      const projection = await store.projection(sessionId);
      if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const facts = await logFacts(sessionId);
      const turnId = lastTurnId.get(sessionId);
      return {
        status: projection.status,
        eventCount: facts.eventCount,
        latestSeq: facts.lastEvent?.seq ?? 0,
        ...(facts.lastEvent ? { lastEvent: { ...facts.lastEvent } } : {}),
        runtime: {
          attached: sessionRuntime.has(sessionId),
          activeTurn: turnActive(sessionId),
          admissionPending: admitting.has(sessionId),
          ...(turnId ? { turnId } : {}),
          ...(projection.backendSessionId ? { backendSessionId: projection.backendSessionId } : {}),
          ...(projection.worktreePath ? { worktreePath: projection.worktreePath } : {}),
        },
        queue: deps.queue ? await deps.queue.queueList(sessionId) : [],
        pending: {
          permissions: [...facts.openPermissions.keys()],
          questions: [...facts.openQuestions.keys()],
          secrets: [...facts.openSecrets.keys()],
        },
        recentErrors: [...facts.recentErrors],
      };
    },

    async replyPermission(sessionId, requestId, reply, scope) {
      await withSessionLock(sessionId, () =>
        replyPermissionCore(sessionId, requestId, reply, scope));
    },

    async replyQuestion(sessionId, requestId, answers) {
      await withSessionLock(sessionId, () =>
        replyQuestionCore(sessionId, requestId, answers));
    },

    async replySecret(sessionId, requestId, reply) {
      await withSessionLock(sessionId, async () => {
        const facts = await logFacts(sessionId);
        const requested = facts.openSecrets.get(requestId);
        if (!requested) {
          if (facts.requestedSecrets.has(requestId)) {
            throw Object.assign(new Error("secret request already resolved"), { code: "conflict" });
          }
          throw Object.assign(new Error("secret request not found"), { code: "not-found" });
        }

        const data = requested.data as unknown as SecretRequestData;
        const proj = await store.projection(sessionId);
        if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
        const rt = await ensureWired(sessionId, proj);
        const intentAction = reply.action === "save" ? "save" : "dismiss";
        const expected: JsonObject = { action: intentAction, handle: data.handle };
        const choice = await broadcastTail(sessionId, () => durable.chooseResponseIntent({
          kind: "secret",
          sessionId,
          requestId,
          action: intentAction,
          handle: data.handle,
        }));
        const operation = assertChosenIntent(choice, expected);
        let result: SecretResolvedData;
        if (reply.action === "save") {
          if (!deps.secureSafe) {
            await broadcastTail(sessionId, () => durable.settleResponseIntent(operation.operationId, {
              kind: "rejected",
              code: "unsupported",
              message: "Secure Safe unavailable",
            }));
            throw Object.assign(new Error("Secure Safe unavailable"), { code: "unsupported" });
          }
          if (typeof reply.value !== "string" || !reply.value.trim()) {
            await broadcastTail(sessionId, () => durable.settleResponseIntent(operation.operationId, {
              kind: "rejected",
              code: "invalid-input",
              message: "value is required",
            }));
            throw Object.assign(new Error("value is required"), { code: "invalid-input" });
          }
          let saved: Awaited<ReturnType<SecureSafeService["upsertByHandle"]>>;
          try {
            saved = await deps.secureSafe.upsertByHandle({
              handle: data.handle,
              label: data.label,
              ...(data.purpose ? { purpose: data.purpose } : {}),
              ...(data.kind ? { kind: data.kind } : {}),
              value: reply.value,
            });
          } catch (error) {
            await broadcastTail(sessionId, () => durable.settleResponseIntent(operation.operationId, {
              kind: "rejected",
              code: "secure-safe-failed",
              message: "secret could not be saved before the runtime response",
            }));
            throw error;
          }
          result = { requestId, action: "saved", handle: saved.handle };
        } else {
          result = { requestId, action: "dismissed", handle: data.handle };
        }

        const outcome = await runResponseOperation<Record<string, never>, void>(
          operation,
          (operationId) => rt.replySecret
            ? (rt.replySecretOperation
                ? rt.replySecretOperation(sessionId, requestId, result, operationId)
                : rt.replySecret(sessionId, requestId, result))
            : (rt.replyQuestionOperation
                ? rt.replyQuestionOperation(sessionId, requestId, { action: "reject" }, operationId)
                : rt.replyQuestion(sessionId, requestId, { action: "reject" })),
          () => ({}),
          {
            type: "secret/resolved",
            data: result as unknown as JsonObject,
            ignorable: true,
          },
        );
        if (outcome.kind !== "confirmed") {
          if (outcome.kind === "unknown") {
            await updateProjection(sessionId, { status: "unknown" });
            scheduleReconciliation(sessionId, proj, rt, "secret-outcome-unknown");
          }
          throw outcomeError(outcome);
        }
        if (proj.status === "waiting") await updateProjection(sessionId, { status: "working" });
      });
    },

    async autoAcceptGet(sessionId) {
      if (!deps.autoAccept) throw Object.assign(new Error("auto-accept unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return { setting: deps.autoAccept.get(sessionId), effective: await effectiveAutoAccept(sessionId) };
    },

    async autoAcceptSet(sessionId, setting: AutoAcceptSetting) {
      if (!deps.autoAccept) throw Object.assign(new Error("auto-accept unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (setting !== "on" && setting !== "off" && setting !== "inherit") {
        throw Object.assign(new Error("setting must be on, off, or inherit"), { code: "invalid-input" });
      }
      deps.autoAccept.set(sessionId, setting);
      // Refresh the effective flag everywhere the change can be seen through a
      // parent chain, and reconcile pending requests where the policy now
      // approves them (OC#2158: enabling resolves requests already waiting).
      for (const p of await store.projections()) {
        const effective = await effectiveAutoAccept(p.id);
        if ((p.autoAccept ?? false) !== effective) await updateProjection(p.id, { autoAccept: effective });
        if (effective && p.status === "waiting") await reconcilePendingPermissions(p.id);
      }
      return { setting, effective: await effectiveAutoAccept(sessionId) };
    },
  };

  /** F18 reconcile-on-enable: resolve every pending runtime permission request
   *  of the session with an auto "once". Composer-shell confirmations are
   *  skipped — those confirm a command the USER typed and must stay manual. */
  const reconcilePendingPermissions = async (sessionId: string): Promise<void> => {
    await withSessionLock(sessionId, async () => {
      const facts = await logFacts(sessionId);
      for (const [rid, requested] of [...facts.openPermissions]) {
        if (requested.producerPlugin === "composer-shell") continue;
        await replyPermissionCore(sessionId, rid, "once", undefined, true);
      }
    });
  };

  return service;
}
