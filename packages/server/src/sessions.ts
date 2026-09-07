// SessionService: canonical session orchestration.
// Runtime events -> appended to durable session log FIRST -> then broadcast/projections.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { continuityWorkspace } from "./continuityWorkspace.ts";
import type {
  AgentProfile, AgentRuntime, AttachmentRef, AutoAcceptSetting, CanonicalEventInput, ChildSnapshotResult, ClientSettingsDto, CreateSessionInput, DeliveryMode,
  Disposable, DurableOperation, HarnessSelection, ForkDraft, ForkResult, JsonObject, ModelRef, MutationOutcome, NotificationRecord,
  PersistedRuntimeBinding,
  InstalledPluginDto, PackageDescriptorDto, QueueItemDto, RateLimitRetry, RateLimitRetryHint, RuntimeEvent,
  RuntimeEpochTransitionResult, TurnResumeCancelledData,
  ExecutionReleaseProof,
  RuntimeEpochFence,
  RuntimeEndpoint, RuntimeLifecycleNotification, RuntimeMutationKind, RuntimeObservation,
  RuntimeSessionBinding, RuntimeSnapshot,
  SecretRequestData, SecretResolvedData, SecureSafeKind, SecureSafeService,
  RuntimeSession, SendResult, SessionDebugDto, SessionDebugEndpointDto, SessionEvent, SessionFolderDto, SessionForkedData, SessionIsolation, SessionOrganizePatch, SessionProjection, SessionRef,
  SessionService, SessionPersistence, UserTurnInput,
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import { isolationBlocksUserMutation } from "@polyth/contracts";
import type { AutoAcceptStore, PermissionService } from "@polyth/permissions";
import { resolveAutoAccept } from "@polyth/permissions";
import {
  activeRewind,
  deriveMessages,
  effectiveHistory,
  planRuntimeEpochRecovery,
  recoveredUserText,
  redactContinuity,
  sessionDebugObservability,
  snapshotDebugEndpoint,
  type Store as DurableSessionStore,
} from "@polyth/session";
import { buildPermissionPreview, PERMISSION_ALLOWED_SCOPES } from "./permissionPreview.ts";
import { sanitizeAttachments } from "./attachments.ts";
import { settleAllOrThrow } from "./settle.ts";
import {
  createResumeScheduler,
  planResume,
  rateLimitNoticeHint,
  RESUME_FALLBACK_BACKOFF_SEC,
} from "./resume.ts";
const QUIET_DISPATCH_ERRORS = new Set([
  "shutting_down",
  "restart-deferred",
  "outcome-unknown",
  "epoch-pending",
]);

export interface Broadcaster {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
  /** NTF-01: unfiltered notification-centre fan-out. Optional so existing
   *  fakes stay valid; inbox records never pass through appendAndBroadcast
   *  or any session reducer. */
  notification?(record: NotificationRecord): void;
  pluginChanged?(packageId: string): void;
  packageChanged?(pkg: PackageDescriptorDto): void;
  /** Server-persisted client preferences changed on another device. */
  clientSettingsChanged?(settings: ClientSettingsDto): void;
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
  forSession?(projection: SessionProjection, cwd: string, targetHarnessId?: string): Promise<AgentRuntime>;
  resolve?(projection: SessionProjection, cwd: string, selection: HarnessSelection): Promise<string>;
  forgetSession?(sessionId: string): void;
  forgetRuntime?(runtime: AgentRuntime): void;
  /** Dispose the facade for one project+cwd so the next lookup starts fresh. */
  release?(projectId: string, cwd: string): Promise<void>;
  /** Session lease on a shared pool facade. Does not own process disposal. */
  bindSession?(sessionId: string, runtime: AgentRuntime): void;
  unbindSession?(sessionId: string, runtime: AgentRuntime): void;
  /** Restart all currently live runtime facades in place. */
  restartAll?(): Promise<number>;
  /** Generation replacement notification. Resolves only after every wired
   * session listener has finished its admission-barrier reconciliation. */
  onRestart?(listener: (runtime: AgentRuntime) => Promise<void>): Disposable;
  /** Process-only idle eviction notification. Durable bindings remain intact;
   * listeners only release references to the disposed facade. */
  onEvict?(listener: (runtime: AgentRuntime) => void | Promise<void>): Disposable;
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
  /** Assess every session currently wired to one pool facade. `inspectionRuntime`
   * bypasses pool activity accounting while authoritative reconciliation runs. */
  canEvictRuntime(
    runtime: AgentRuntime,
    inspectionRuntime: AgentRuntime,
    expected: RuntimeRestartFingerprint,
    liveStreamSessionIds: readonly string[],
  ): Promise<RuntimeRestartSafety>;
}

export type RuntimeEpochAuthorityDisposition =
  | ({ kind: "owned-authority-destroyed" } & Omit<ExecutionReleaseProof, "backendSessionId">)
  | ({ kind: "session-execution-released" } & ExecutionReleaseProof)
  | { kind: "borrowed-runtime-confirmed" }
  /** The backend session is unusable, but the endpoint identity itself is
   * still valid. Start a fresh backend context without fencing the old one. */
  | { kind: "unknown-session-replaced" };

export interface RuntimeEpochTransitionOptions {
  resetOperationId: string;
  harness?: import("@polyth/contracts").RuntimeEpochTransitionInput["harness"];
  reason: string;
  authorityDisposition: RuntimeEpochAuthorityDisposition;
}

export interface RuntimeEpochSessionService extends RestartSafetySessionService {
  /** Complete the durable runtime epoch after Phase 4 has protocol-confirmed a
   * fresh session-reset. This never creates or hydrates a backend session. */
  transitionRuntimeEpoch(
    sessionId: string,
    runtime: AgentRuntime,
    options: RuntimeEpochTransitionOptions,
  ): Promise<RuntimeEpochTransitionResult>;
  /** User-confirmed borrowed/external replacement. Never fences unknowns. */
  confirmBorrowedRuntimeEpoch(sessionId: string): Promise<SessionProjection>;
}

export const canRebindPersistedSession = (
  persisted: PersistedRuntimeBinding,
  requested: {
    backendSessionId: string;
    endpoint: RuntimeEndpoint;
    protocol: "legacy" | "v2";
  },
): boolean => {
  const { endpoint } = requested;
  if (
    persisted.backendSessionId !== requested.backendSessionId
    || persisted.authorityId !== endpoint.authorityId
    || persisted.location.directory !== endpoint.location.directory
    || (persisted.location.workspace ?? "") !== (endpoint.location.workspace ?? "")
  ) {
    return false;
  }
  // Protocol identifies the adapter used to reach the durable authority, not
  // the backend session itself. A managed adapter upgrade may retain identity.
  return persisted.generation === endpoint.generation
    || (
      persisted.continuity === "verified"
      && endpoint.continuity === "verified"
    );
};

const requireLaunchModelForAutoAgent = async (
  runtime: AgentRuntime,
  agent: string | undefined,
  model: ModelRef | undefined,
): Promise<void> => {
  if (!agent || model) return;
  const descriptors = await runtime.agents().catch(() => []);
  if (!descriptors.some((candidate) => candidate.name === agent && candidate.mode === "auto")) return;
  throw Object.assign(
    new Error(`model is required when launching auto agent "${agent}"`),
    { code: "invalid-input" },
  );
};

export const isRuntimeOperationBlocking = (operation: DurableOperation): boolean =>
  operation.state === "prepared"
  || operation.state === "executing"
  || operation.state === "unknown";

type RuntimeDurability = Pick<
  DurableSessionStore,
  | "prepareOperation"
  | "prepareSessionCreate"
  | "operation"
  | "operations"
  | "queueReservation"
  | "claimOperation"
  | "settleOperation"
  | "transitionRuntimeEpoch"
  | "recoverRestartInterruptedTurns"
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
  attentionFor(sessionIds: string[]): Promise<Record<string, { questions: number; permissions: number; unread: number }>>;
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
  /** Supply workflow context for a fresh runtime epoch. The session service
   * combines this with its confirmed canonical-history tail. */
  runtimeEpochContext?(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<{
    objective?: string;
    pinned: Array<{ sourceEventSeq: number; role: "user" | "assistant"; text: string }>;
    behavior?: string;
    agent?: string;
  }>;
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
  /** Process shutdown fence. Distinct from config-restart fencing. */
  isShuttingDown?: () => boolean;
  hooks?: TurnHooks;
  expand?: ExpandInput;
  queue?: QueueStore;
  org?: OrgStore;
  /** Authoritative git worktree inventory used to validate session cwd overrides. */
  worktrees?: {
    list(root: string): Promise<Array<{ path: string; branch: string | null }>>;
  };
  /** Stop shells/watchers whose cwd is about to be deleted. */
  closeWorkspaceProcesses?: (cwd: string) => Promise<void>;
  /** Drop the OpenCode facade for a previous session cwd after rebind. */
  releaseRuntime?: (projectId: string, cwd: string) => Promise<void>;
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
  /** Attachment preparation seam (F2). `stat` existence-checks an ordinary
   *  project file against the session's execution root; `materialize`
   *  guarantees a staged `_inbox/*` upload exists at the execution root,
   *  copying from the project root when the session runs in a linked worktree
   *  or on a remote host. Both must reject paths escaping the root; `maxBytes`
   *  reuses the upload cap. */
  attachments?: {
    maxBytes: number;
    stat(root: string, rel: string): Promise<{ kind: "file" | "dir"; size: number }>;
    materialize(input: {
      projectId: string;
      projectRoot: string;
      execRoot: string;
      rel: string;
    }): Promise<{ kind: "file"; size: number }>;
  };
  /** Managed browser capture artifacts outside the project worktree. */
  browserArtifacts?: {
    resolve(id: string): Promise<{ id: string; mime: string; size: number; localPath: string } | null>;
    /** Promote draft captures to durable storage when a message is sent. */
    commit?(ids: ReadonlyArray<string>): Promise<void>;
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
  /** Hard ceiling for one runtime tool execution. A hung tool is aborted and
   * recorded as a model-visible tool/error. Defaults to ten minutes. */
  toolExecutionTimeoutMs?: number;
}): RuntimeEpochSessionService {
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
    "transitionRuntimeEpoch",
    "recoverRestartInterruptedTurns",
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
  // Owned runtime identity breaks are recoverable without user action. The
  // implementation is assigned after the epoch helpers are declared; callers
  // can safely request recovery during attach/reconciliation.
  let recoverOwnedEpochIfPending: (sessionId: string) => Promise<void> = async () => {};
  // Last redacted endpoint seen during normal attach/bind. debug() reads this
  // instead of calling endpoint(), which can restart a dead owned instance.
  const attachedEndpoint = new WeakMap<AgentRuntime, SessionDebugEndpointDto>();
  const rememberEndpoint = (runtime: AgentRuntime, endpoint: RuntimeEndpoint): void => {
    attachedEndpoint.set(runtime, snapshotDebugEndpoint(endpoint));
  };
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
  // OpenCode publishes the semantic title it generated from the prompt — or
  // until an explicit rename supersedes it.
  const autoTitleRequested = new Set<string>();
  const titleRefreshInFlight = new Set<string>();
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
  // Stop is a recovery control, not a background submission: fail it promptly
  // so reconciliation can take over instead of leaving the control disabled.
  const ABORT_AWAIT_MS = 8_000;
  const TOOL_EXECUTION_TIMEOUT_MS = deps.toolExecutionTimeoutMs ?? 10 * 60_000;
  const toolWatchdogs = new Map<string, NodeJS.Timeout>();
  const toolWatchdogKey = (sessionId: string, callId: string): string => `${sessionId}\0${callId}`;
  const clearToolWatchdog = (sessionId: string, callId: string): void => {
    const key = toolWatchdogKey(sessionId, callId);
    const timer = toolWatchdogs.get(key);
    if (timer) clearTimeout(timer);
    toolWatchdogs.delete(key);
  };
  const clearSessionToolWatchdogs = (sessionId: string): void => {
    for (const [key, timer] of toolWatchdogs) {
      if (!key.startsWith(`${sessionId}\0`)) continue;
      clearTimeout(timer);
      toolWatchdogs.delete(key);
    }
  };
  const activeToolsFromEvents = (
    events: readonly SessionEvent[],
  ): Map<string, { tool: string; input: JsonObject; startedAt: number }> => {
    const active = new Map<string, { tool: string; input: JsonObject; startedAt: number }>();
    for (const event of events) {
      const data = event.data as Record<string, unknown>;
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (event.type === "turn/started" || event.type === "turn/stopped") active.clear();
      if ((event.type === "tool/started" || (event.type === "tool/call" && data.status === "running")) && callId) {
        active.set(callId, {
          tool: typeof data.tool === "string" ? data.tool : "tool",
          input: data.input && typeof data.input === "object" && !Array.isArray(data.input)
            ? data.input as JsonObject
            : {},
          startedAt: event.time,
        });
      } else if ((event.type === "tool/result" || event.type === "tool/error") && callId) {
        active.delete(callId);
      }
    }
    return active;
  };
  function armToolWatchdog(
    sessionId: string,
    callId: string,
    startedAt = Date.now(),
  ): void {
    if (TOOL_EXECUTION_TIMEOUT_MS <= 0) return;
    clearToolWatchdog(sessionId, callId);
    const timer = setTimeout(() => {
      toolWatchdogs.delete(toolWatchdogKey(sessionId, callId));
      void stopTimedOutTool(sessionId, callId).catch((error) => {
        console.error(`[polyth] failed to stop timed-out tool ${callId} in ${sessionId}`, error);
      });
    }, Math.max(0, TOOL_EXECUTION_TIMEOUT_MS - (Date.now() - startedAt)));
    timer.unref?.();
    toolWatchdogs.set(toolWatchdogKey(sessionId, callId), timer);
  }
  function updateToolWatchdog(sessionId: string, event: RuntimeEvent): void {
    if (event.type === "tool/started" || (event.type === "tool/call" && event.status === "running")) {
      armToolWatchdog(sessionId, event.callId);
    } else if (event.type === "tool/result" || event.type === "tool/error") {
      clearToolWatchdog(sessionId, event.callId);
    } else if (event.type === "turn/stopped") {
      clearSessionToolWatchdogs(sessionId);
    }
  }
  const boundedRuntimeAwait = async <T,>(
    promise: Promise<T>,
    operationId: string,
    timeoutMs = RUNTIME_AWAIT_MS,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(
              new Error(`runtime operation ${operationId} exceeded ${timeoutMs}ms`),
              { code: "runtime-timeout" },
            ));
          }, timeoutMs);
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
    timeoutMs = RUNTIME_AWAIT_MS,
  ): Promise<MutationOutcome<T>> => {
    await claimOperation(operation);
    let outcome: MutationOutcome<T>;
    try {
      const value = await boundedRuntimeAwait(
        call(operation.operationId),
        operation.operationId,
        timeoutMs,
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
      && isRuntimeOperationBlocking(operation));

  /** Operations named by any `runtime/restart-recovered` marker — turns that
   *  were in flight when Polyth restarted and whose owned backend session was
   *  later re-verified alive. They stay `unknown` (never auto-resolved) but no
   *  longer gate send admission, mirroring prior-epoch unknowns after a
   *  confirmed session-reset. Fork / rewind / assertMutable still 409 on them. */
  const restartRecoveredOperationIds = async (
    sessionId: string,
  ): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const event of await store.events(sessionId)) {
      if (event.type !== "runtime/restart-recovered") continue;
      const recovered = (event.data as { recoveredOperationIds?: unknown }).recoveredOperationIds;
      if (Array.isArray(recovered)) {
        for (const id of recovered) if (typeof id === "string") ids.add(id);
      }
    }
    return ids;
  };

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
    lastStopReason: "completed" | "aborted" | "error" | null;
    turnOpen: boolean;
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
    lastStopReason: null,
    turnOpen: false,
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
        case "permission/expired":
          if (rid) facts.openPermissions.delete(rid);
          break;
        case "question/asked":
          if (rid) { facts.askedQuestions.add(rid); facts.openQuestions.set(rid, ev); }
          break;
        case "question/answered":
        case "question/expired":
          if (rid) facts.openQuestions.delete(rid);
          break;
        case "secret/requested":
          if (rid) { facts.requestedSecrets.add(rid); facts.openSecrets.set(rid, ev); }
          break;
        case "secret/resolved":
        case "secret/expired":
          if (rid) facts.openSecrets.delete(rid);
          break;
        case "turn/started":
          facts.lastStopReason = null;
          facts.turnOpen = true;
          break;
        case "turn/stopped": {
          const reason = data.reason;
          facts.lastStopReason =
            reason === "completed" || reason === "aborted" || reason === "error" ? reason : null;
          facts.turnOpen = false;
          break;
        }
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

  const openTurnFromEvents = (
    events: readonly SessionEvent[],
  ): { turnId: string; abortRequested: boolean } | undefined => {
    let open: { turnId: string; abortRequested: boolean } | undefined;
    for (const event of events) {
      if (event.type === "turn/started") {
        const turnId = (event.data as { turnId?: unknown }).turnId;
        open = typeof turnId === "string" && turnId
          ? { turnId, abortRequested: false }
          : undefined;
      } else if (event.type === "turn/abort-requested" && open) {
        open.abortRequested = true;
      } else if (event.type === "turn/stopped") {
        open = undefined;
      }
    }
    return open;
  };

  // A durable terminal event is enough to admit a follow-up after a stopped
  // turn, even if the backend cannot provide a comparable reconciliation
  // watermark. Unresolved runtime operations remain a separate hard block.
  const hasPersistedStoppedTurn = (events: readonly SessionEvent[]): boolean => {
    let lastTurnEvent: SessionEvent | undefined;
    for (const event of events) {
      if (event.type === "turn/started" || event.type === "turn/stopped") {
        lastTurnEvent = event;
      }
    }
    return lastTurnEvent?.type === "turn/stopped";
  };

  const terminalizeReconciledTurn = async (
    sessionId: string,
    state: "idle" | "failed" | "interrupted",
  ): Promise<void> => {
    const open = openTurnFromEvents(await store.events(sessionId));
    if (!open) return;
    await onRuntimeEvent(sessionId, {
      type: "turn/stopped",
      turnId: open.turnId,
      reason: state === "interrupted"
        ? "aborted"
        : state === "failed"
          ? "error"
          : open.abortRequested ? "aborted" : "completed",
    });
  };

  const stopLocally = async (
    sessionId: string,
    toolError = "Command stopped by user.",
  ): Promise<void> => {
    const projection = await store.projection(sessionId);
    if (!projection || projection.status === "archived") return;
    const events = await store.events(sessionId);
    const open = openTurnFromEvents(events);
    const activeTools = activeToolsFromEvents(events);
    if (!open && activeTools.size === 0 && projection.status === "idle") return;
    for (const [callId, active] of activeTools) {
      await onRuntimeEvent(sessionId, {
        type: "tool/error",
        callId,
        tool: active.tool,
        input: active.input,
        error: toolError,
      });
    }
    await onRuntimeEvent(sessionId, {
      type: "turn/stopped",
      ...(open ? { turnId: open.turnId } : {}),
      reason: "aborted",
    });
  };

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
  // Runtime wiring and reconciliation maintain the projection; they are not
  // session activity and must not change the sidebar's recent order.
  const updateProjectionQuietly = async (sessionId: string, patch: Partial<SessionProjection>) => {
    await applyProjection(sessionId, (current) => ({ ...current, ...patch }));
  };

  // A delegated (subagent) child session never streams its own turn
  // lifecycle: OpenCode runs it inside the parent's turn and garbage-collects
  // its ephemeral backend session soon after. Without an explicit retirement
  // the child stays pinned at working/reconciling/unknown forever and the UI
  // can never open it as a finished transcript. The parent's task snapshot
  // (`outcome` set) is the authoritative end signal; a plain read (`outcome`
  // omitted) retires the child only when its transcript is demonstrably not
  // mid-exchange. An open turn or an already-terminal status is left alone.
  const settleDelegatedChild = async (
    childSessionId: string,
    outcome?: "done" | "failed",
  ): Promise<void> => {
    const projection = await store.projection(childSessionId);
    if (!projection?.parentId) return;
    if (
      projection.status !== "working"
      && projection.status !== "reconciling"
      && projection.status !== "unknown"
    ) return;
    const events = await store.events(childSessionId);
    if (openTurnFromEvents(events)) return;
    if (outcome === undefined) {
      const lastTurnEvent = [...events].reverse().find((event) =>
        event.type === "user/message" || event.type === "assistant/message");
      if (lastTurnEvent?.type === "user/message") return;
    }
    // The guards above already proved the status is non-terminal, so this
    // always moves the child forward to a terminal state.
    await updateProjectionQuietly(childSessionId, {
      status: outcome === "failed" ? "failed" : "idle",
    });
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
    epoch = 0,
  ): Promise<PersistedRuntimeBinding> => {
    const endpoint = await (runtime as ReliabilityRuntime).endpoint?.();
    if (!endpoint) {
      return {
        backendSessionId,
        authorityId: `legacy:unmanaged:${cwd}`,
        generation: 0,
        epoch,
        continuity: "generation-only",
        protocol: "legacy",
        location: { directory: cwd },
        ...(historyBaseline ? { historyBaseline } : {}),
      };
    }
    rememberEndpoint(runtime, endpoint);
    return {
      backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      epoch,
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
      rememberEndpoint(rt, endpoint);
      const protocol = await (rt as ReliabilityRuntime).protocol?.()
        ?? proj.runtimeBinding?.protocol
        ?? "legacy";
      const persisted = proj.runtimeBinding;
      if (!persisted) {
        throw Object.assign(
          new Error("persisted backend binding has no durable runtime identity"),
          { code: "binding-mismatch" },
        );
      }
      if (
        !canRebindPersistedSession(persisted, {
          backendSessionId: proj.backendSessionId,
          endpoint,
          protocol,
        })
      ) {
        throw Object.assign(
          new Error("persisted backend binding does not match a verified runtime"),
          { code: "binding-mismatch" },
        );
      }
      const currentBinding = {
        backendSessionId: proj.backendSessionId,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: endpoint.continuity,
        protocol,
        location: endpoint.location,
        ...(persisted.epoch !== undefined ? { epoch: persisted.epoch } : {}),
        ...(persisted.historyBaseline
          ? { historyBaseline: persisted.historyBaseline }
          : {}),
      };
      if (
        persisted.generation !== currentBinding.generation
        || persisted.continuity !== currentBinding.continuity
        || persisted.protocol !== currentBinding.protocol
      ) {
        await applyProjection(proj.id, (current) => ({
          ...current,
          runtimeBinding: currentBinding,
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
        (
          operation.mutationKind === "session-create"
          || operation.mutationKind === "session-reset"
          || operation.mutationKind === "session-revert"
        )
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

  const markOwnedEpochPending = async (
    sessionId: string,
    projection: SessionProjection,
    runtime: AgentRuntime,
    error: unknown,
    reconciliationOrdinal?: number,
  ): Promise<boolean> => {
    if (
      (error as { code?: unknown }).code !== "binding-mismatch"
      || !projection.runtimeBinding
    ) {
      return false;
    }
    const endpoint = await (runtime as ReliabilityRuntime).endpoint?.().catch(() => undefined);
    if (!endpoint) return false;
    const reason = "persisted runtime authority requires an epoch transition";
    const ordinal = reconciliationOrdinal
      ?? (await broadcastTail(
        sessionId,
        () => durable.startReconciliation(sessionId),
      )).ordinal;
    const current = await durable.reconciliation(sessionId);
    if (current?.ordinal === ordinal) {
      await broadcastTail(sessionId, () => durable.settleReconciliation(
        sessionId,
        ordinal,
        "blocked",
        reason,
      ));
    }
    await updateProjectionQuietly(sessionId, {
      status: "epoch-pending",
      runtimeControl: endpoint.control.kind === "owned" ? "owned" : "borrowed",
    });
    if (
      endpoint.control.kind === "owned"
      && (runtime.resetSessionOperation || runtime.resetSession)
    ) {
      void recoverOwnedEpochIfPending(sessionId);
    }
    return true;
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
      await updateProjectionQuietly(sessionId, { status: "reconciling" });
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
          await updateProjectionQuietly(sessionId, { status: "unknown" });
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
        let authoritativeState = await authoritativeSnapshotState(
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
        if (
          authoritativeState.value === "idle"
          || authoritativeState.value === "failed"
          || authoritativeState.value === "interrupted"
        ) {
          await terminalizeReconciledTurn(sessionId, authoritativeState.value);
        }
        if (historyBaseline) {
          // A delegated child is reconciled the instant its parent spawns it —
          // before the backend subagent session has produced any messages.
          // Emitting session/history-imported then would permanently disable
          // the lazy re-import in events() and strand the child with an empty
          // transcript. For a child on the "import" baseline, defer the
          // finalize until real history has actually landed; every other case
          // (fork "copied", non-child adoption) finalizes exactly as before.
          const importFinalized = historyBaseline !== "import"
            || !currentProjection?.parentId
            || (store.hasEventOfType
              ? (await store.hasEventOfType(sessionId, "user/message"))
                || (await store.hasEventOfType(sessionId, "assistant/message"))
              : (await store.events(sessionId)).some((event) =>
                  event.type === "user/message" || event.type === "assistant/message"));
          if (importFinalized) {
            await applyProjection(sessionId, (current) => {
              if (!current.runtimeBinding) return current;
              const runtimeBinding = { ...current.runtimeBinding };
              delete runtimeBinding.historyBaseline;
              return { ...current, runtimeBinding };
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
        }

        let facts = await logFacts(sessionId);
        await settleAcceptedOperations(sessionId, snapshot, facts);
        facts = await logFacts(sessionId);
        await settleProvenOperationNonapplications(sessionId, snapshot, facts);
        facts = await logFacts(sessionId);
        // Warm-restart recovery: the rebind above only succeeds against the
        // SAME verified owned backend session. When it is demonstrably alive
        // (definite running/idle evidence), lift any turn stranded `unknown` by
        // a Polyth restart out of the admission barrier so the session is
        // usable again on that same backend — the operation stays `unknown`.
        if (authoritativeState.value === "running" || authoritativeState.value === "idle") {
          const recovered = await broadcastTail(sessionId, () =>
            durable.recoverRestartInterruptedTurns({
              sessionId,
              authorityId: binding.authorityId,
              generation: binding.generation,
              reconciliationOrdinal: started.ordinal,
            }));
          if (recovered) facts = await logFacts(sessionId);
        }
        const recoveredRestartIds = await restartRecoveredOperationIds(sessionId);
        // A durable turn/stopped already closed the turn locally. When the
        // backend is unreachable (`unknown`), that terminal record is
        // authoritative — marking the session `unknown` again would wedge the
        // Stop button on a dead turn. Admission already treats
        // `unknown && stoppedTurnRecorded` as safe.
        const stoppedTurnRecorded = hasPersistedStoppedTurn(await store.events(sessionId));
        const unresolved = (await durable.operations(sessionId)).find((operation) =>
          operation.operationId !== ignoredOperationId
          && isRuntimeOperationBlocking(operation)
          && !(operation.state === "unknown" && recoveredRestartIds.has(operation.operationId)));
        const nextStatus = unresolved
          ? "unknown"
          : authoritativeState.value === "running"
            ? (openRequestTotal(facts) > 0 ? "waiting" : "working")
            : authoritativeState.value === "idle"
              ? (openRequestTotal(facts) > 0 ? "waiting" : "idle")
              : authoritativeState.value === "unknown" && stoppedTurnRecorded
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
        await updateProjectionQuietly(sessionId, { status: nextStatus });
        if (nextStatus === "idle") void dispatchQueue(sessionId);
      } catch (error) {
        if (await markOwnedEpochPending(sessionId, proj, rt, error, started.ordinal)) {
          return;
        }
        const current = await durable.reconciliation(sessionId);
        if (current?.ordinal === started.ordinal) {
          await broadcastTail(sessionId, () => durable.settleReconciliation(
            sessionId,
            started.ordinal,
            "unknown",
            error instanceof Error ? error.message : "runtime reconciliation failed",
          ));
          await updateProjectionQuietly(sessionId, { status: "unknown" });
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
        reconciliations.push((async () => {
          await reconcileUnderLock(
            sessionId,
            projection,
            runtime,
            "runtime-generation-replaced",
          );
          await recoverOwnedEpochIfPending(sessionId);
        })());
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

  // SSE is preferred, but some OpenCode providers only expose the generated
  // title through /session. At most four reads over 11 seconds per turn avoid
  // a background poll while covering its delayed title write.
  function refreshGeneratedTitle(sessionId: string, runtime: AgentRuntime): void {
    if (titleRefreshInFlight.has(sessionId)) return;
    titleRefreshInFlight.add(sessionId);
    const delays = [0, 1_000, 3_000, 7_000] as const;
    const attempt = async (index: number): Promise<void> => {
      if (!autoTitleRequested.has(sessionId)) {
        titleRefreshInFlight.delete(sessionId);
        return;
      }
      const current = await store.projection(sessionId);
      if (!current?.backendSessionId) {
        titleRefreshInFlight.delete(sessionId);
        return;
      }
      try {
        const title = (await runtime.sessions()).find((session) => session.id === current.backendSessionId)?.title;
        // Timestamp titles are OpenCode's failed auto-title. Treating them as
        // real titles leaves the backend placeholder as the visible name;
        // skipping keeps the request pending for the next interval while a
        // retry (or a later turn) may still produce a semantic title.
        if (title
          && !isPlaceholderTitle(title, current.backendSessionId)
          && !/^new session - \d{4}-\d{2}-\d{2}t/i.test(title)) {
          await onRuntimeEvent(sessionId, { type: "session/title-generated", title });
          titleRefreshInFlight.delete(sessionId);
          return;
        }
      } catch {
        // Retry on the next bounded interval; SSE can still settle the title.
      }
      if (index === delays.length - 1) {
        titleRefreshInFlight.delete(sessionId);
        return;
      }
      setTimeout(() => { void attempt(index + 1); }, delays[index + 1]);
    };
    void attempt(0);
  }

  // ---- rate-limit auto-resume ------------------------------------------------
  // A provider capacity stop (rate limit / quota / overload) is recoverable:
  // the backend adapter tags turn/stopped with a retry hint, we persist a
  // SessionResumeState on the projection and arm a timer that re-sends the
  // last user message. The user can cancel the wait or continue on another
  // model instead (both go through cancelResume / send).
  const resumeScheduler = createResumeScheduler({
    fire: (sessionId) => runScheduledResume(sessionId),
    onError: (sessionId, err) =>
      console.error(`[polyth] rate-limit resume failed for ${sessionId}`, err),
  });

  const lastUserMessage = (
    events: readonly SessionEvent[],
  ): { seq: number; text: string; attachments?: JsonObject[] } | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type !== "user/message") continue;
      const data = ev.data as {
        text?: unknown; raw?: unknown; attachments?: unknown; githubConflictResolution?: unknown;
      };
      if (data.githubConflictResolution === true) return undefined;
      const text = typeof data.raw === "string" && data.raw.trim()
        ? data.raw
        : typeof data.text === "string" ? data.text : "";
      return {
        seq: ev.seq,
        text,
        ...(Array.isArray(data.attachments) && data.attachments.length
          ? { attachments: data.attachments as JsonObject[] }
          : {}),
      };
    }
    return undefined;
  };

  /** Compute + persist the resume plan for a limit stop and arm the timer.
   *  Returns the plan so the caller can embed it in the turn/stopped event. */
  const scheduleResume = async (
    sessionId: string,
    hint: RateLimitRetryHint,
    events: readonly SessionEvent[],
  ): Promise<RateLimitRetry | undefined> => {
    const last = lastUserMessage(events);
    if (!last) return undefined;
    const previous = (await store.projection(sessionId))?.resume;
    const state = planResume({
      hint,
      userMessageSeq: last.seq,
      ...(previous
        ? { previous: { attempt: previous.attempt, userMessageSeq: previous.userMessageSeq } }
        : {}),
      now: Date.now(),
    });
    await applyProjection(sessionId, (current) => ({ ...current, resume: state, updatedAt: Date.now() }));
    resumeScheduler.arm(sessionId, state.resumeAt);
    return {
      scope: state.scope,
      ...(state.provider ? { provider: state.provider } : {}),
      ...(state.retryAfterSec ? { retryAfterSec: state.retryAfterSec } : {}),
      resumeAt: state.resumeAt,
      attempt: state.attempt,
    };
  };

  /** Drop a pending resume (user cancel, model switch, superseded, resumed). */
  const clearResume = async (
    sessionId: string,
    reason: TurnResumeCancelledData["reason"],
  ): Promise<boolean> => {
    resumeScheduler.cancel(sessionId);
    if (!(await store.projection(sessionId))?.resume) return false;
    await applyProjection(sessionId, (current) => {
      const next = { ...current, updatedAt: Date.now() };
      delete next.resume;
      return next;
    });
    await appendAndBroadcast(sessionId, "turn/resume-cancelled", { reason }, { ignorable: true });
    return true;
  };

  // Runs from the timer (no session lock held). The check + clear are done
  // under the lock; service.send runs after release so it can take the lock
  // through its own admission path.
  const runScheduledResume = async (sessionId: string): Promise<void> => {
    const plan = await withSessionLock(sessionId, async (): Promise<
      { text: string; attachments?: AttachmentRef[]; model?: ModelRef; resumeAt: number; userMessageSeq: number } | null
    > => {
      const proj = await store.projection(sessionId);
      if (!proj?.resume) return null;
      if (proj.status === "working" || proj.status === "reconciling" || proj.status === "archived") {
        return null;
      }
      const last = lastUserMessage(await store.events(sessionId));
      if (!last || last.seq !== proj.resume.userMessageSeq || !last.text.trim()) {
        await clearResume(sessionId, "user");
        return null;
      }
      return {
        text: last.text,
        ...(last.attachments
          ? { attachments: last.attachments as unknown as AttachmentRef[] }
          : {}),
        ...(proj.model ? { model: proj.model } : {}),
        resumeAt: proj.resume.resumeAt,
        userMessageSeq: proj.resume.userMessageSeq,
      };
    });
    if (!plan) return;
    try {
      // Keep the plan until `turn/started` is durably observed. A temporary
      // reconciliation barrier must retry instead of losing the only prompt
      // that was meant to be submitted automatically.
      await service.send(sessionId, {
        text: plan.text,
        ...(plan.attachments ? { attachments: plan.attachments } : {}),
        ...(plan.model ? { model: plan.model } : {}),
        autoResume: true,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "conflict") {
        const current = await store.projection(sessionId);
        const last = current ? lastUserMessage(await store.events(sessionId)) : undefined;
        if (
          current?.resume?.resumeAt === plan.resumeAt
          && current.resume.userMessageSeq === plan.userMessageSeq
          && last?.seq === plan.userMessageSeq
        ) {
          resumeScheduler.arm(sessionId, Date.now() + RESUME_FALLBACK_BACKOFF_SEC[0]! * 1000);
        }
      }
      throw error;
    }
  };

  /** Boot: re-arm timers for sessions that stopped rate-limited before a
   *  restart. A resumeAt already in the past fires on the next tick. */
  const rehydrateResume = async (): Promise<void> => {
    let rows: SessionProjection[] = [];
    try {
      rows = await store.projections();
    } catch {
      return;
    }
    for (const row of rows) {
      if (row.resume && row.status !== "archived") {
        // The projection can be committed just before a process dies, leaving
        // the durable retry plan without its terminal event. The UI derives
        // the notice from that event, so repair the log before re-arming the
        // timer. Do not duplicate a stop that already carries this plan.
        const events = await store.events(row.id);
        const lastTurnEvent = [...events].reverse().find(
          (event) => event.type === "turn/started" || event.type === "turn/stopped",
        );
        const retry = lastTurnEvent?.type === "turn/stopped"
          ? (lastTurnEvent.data as { retry?: unknown }).retry
          : undefined;
        const retryData = retry && typeof retry === "object" && !Array.isArray(retry)
          ? retry as Record<string, unknown>
          : undefined;
        const hasMatchingStop = retryData?.resumeAt === row.resume.resumeAt
          && retryData.attempt === row.resume.attempt
          && retryData.scope === row.resume.scope
          && retryData.provider === row.resume.provider;
        const last = lastUserMessage(events);
        const targetMatches = last?.seq === row.resume.userMessageSeq;
        if (!hasMatchingStop && targetMatches) {
          await appendAndBroadcast(row.id, "turn/stopped", {
            turnId: openTurnFromEvents(events)?.turnId
              ?? lastTurnId.get(row.id)
              ?? "rate-limit-stall",
            reason: "error",
            error: "provider rate limit reached",
            retry: {
              scope: row.resume.scope,
              ...(row.resume.provider ? { provider: row.resume.provider } : {}),
              ...(row.resume.retryAfterSec ? { retryAfterSec: row.resume.retryAfterSec } : {}),
              resumeAt: row.resume.resumeAt,
              attempt: row.resume.attempt,
            },
          }, { ignorable: true });
        }
        // A newer user message means the old plan was superseded while the
        // process was stopping; leave the normal timer guard to clear it.
        if (targetMatches && row.status !== "failed") {
          await updateProjection(row.id, { status: "failed" });
        }
        resumeScheduler.arm(row.id, row.resume.resumeAt);
        continue;
      }
      // Command Code can leave SSE open after a `[rate-limit]` reasoning
      // notice, without its normal terminal event. On restart the adapter has
      // no live turn to watchdog, so recover the durable wait from a quiet log
      // rather than leaving the session in `working` forever.
      if (row.status !== "working") continue;
      const events = await store.events(row.id);
      if (Date.now() - (events.at(-1)?.time ?? Date.now()) < 15_000) continue;
      let active = false;
      let hint: RateLimitRetryHint | null = null;
      for (const event of events) {
        if (event.type === "turn/started") {
          active = true;
          hint = null;
          continue;
        }
        if (event.type === "turn/stopped") {
          active = false;
          hint = null;
          continue;
        }
        if (!active || (event.type !== "assistant/reasoning-chunk" && event.type !== "assistant/message")) continue;
        const data = event.data as { text?: unknown; reasoning?: unknown };
        hint = rateLimitNoticeHint(
          typeof data.reasoning === "string" ? data.reasoning : typeof data.text === "string" ? data.text : "",
        ) ?? hint;
      }
      if (!active || !hint) continue;
      const retry = await scheduleResume(row.id, hint, events);
      if (!retry) continue;
      await appendAndBroadcast(row.id, "turn/stopped", {
        turnId: lastTurnId.get(row.id) ?? "rate-limit-stall",
        reason: "error",
        error: "provider rate limit reached",
        retry: retry as unknown as JsonObject,
      }, { ignorable: true });
      await updateProjection(row.id, { status: "failed" });
    }
  };

  const settleAfterLastRequest = async (sessionId: string): Promise<void> => {
    const current = await store.projection(sessionId);
    if (!current || current.status !== "waiting") return;
    const facts = await logFacts(sessionId);
    if (openRequestTotal(facts) > 0) return;
    if (turnActive(sessionId) || facts.turnOpen) {
      await updateProjection(sessionId, { status: "working" });
      return;
    }
    const next = facts.lastStopReason === "error" ? "failed" : "idle";
    await updateProjection(sessionId, { status: next });
    if (next === "idle") void dispatchQueue(sessionId);
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
    // A runtime may report the same terminal state after Stop already supplied
    // the durable fallback. Observation replay must still apply projection
    // effects for its already-ingested event batch.
    const observationReplay = options.persist !== undefined && sideEffects;
    if (
      ev.type === "turn/stopped"
      && !observationReplay
      && hasPersistedStoppedTurn(await store.events(sessionId))
    ) {
      return;
    }
    // OpenCode creates delegated sessions itself. Adopt those exact backend
    // sessions as children before publishing the parent's task snapshot, so a
    // task card and the navigator always point at the same canonical session.
    if (ev.type === "subagent/snapshot" && sideEffects) {
      const parent = await store.projection(sessionId);
      const runtime = sessionRuntime.get(sessionId);
      if (parent && runtime) {
        const remote = new Map((await runtime.sessions()).map((item) => [item.id, item]));
        const known = await store.projections(parent.projectId);
        const canonicalByBackend = new Map(
          known.flatMap((item) => item.backendSessionId ? [[item.backendSessionId, item.id] as const] : []),
        );
        const agents = [] as typeof ev.agents;
        for (const agent of ev.agents) {
          const child = remote.get(agent.sessionId);
          // A task call can precede the backend session metadata. Keep its
          // temporary identifier until OpenCode supplies a real child.
          if (!child || child.parentId !== parent.backendSessionId) {
            agents.push(agent);
            continue;
          }
          let childId = canonicalByBackend.get(child.id);
          if (!childId) {
            childId = randomUUID();
            const project = await projects.get(parent.projectId);
            const cwd = parent.worktreePath ?? project?.path ?? process.cwd();
            const projection: SessionProjection = {
              id: childId,
              projectId: parent.projectId,
              // Delegated children live in the parent's Space, always.
              ...(parent.spaceId ? { spaceId: parent.spaceId } : {}),
              parentId: sessionId,
              title: child.title || agent.label,
              status: "reconciling",
              backendSessionId: child.id,
              runtimeBinding: await newRuntimeBinding(runtime, child.id, cwd, "import"),
              createdAt: child.createdAt,
              updatedAt: child.updatedAt,
            };
            await store.upsertProjection(projection);
            await appendAndBroadcast(childId, "session/imported", { backendSessionId: child.id }, { ignorable: true });
            broadcast.projection(projection);
            await ensureWired(childId, projection);
            canonicalByBackend.set(child.id, childId);
          }
          // The parent's task snapshot is the only authoritative signal that a
          // delegated run ended — the child itself never streams a terminal
          // turn event. Pull its now-complete transcript while the ephemeral
          // backend session is still guaranteed to exist, then retire it so it
          // can never linger as an unopenable `working` session.
          if (agent.status === "done" || agent.status === "failed") {
            const childProjection = await store.projection(childId);
            const childRuntime = sessionRuntime.get(childId);
            const historyPending = Boolean(childProjection?.backendSessionId)
              && childRuntime !== undefined
              && !(store.hasEventOfType
                ? await store.hasEventOfType(childId, "session/history-imported")
                : (await store.events(childId)).some((e) => e.type === "session/history-imported"));
            if (historyPending) {
              try {
                await reconcileSession(childId, childProjection!, childRuntime!, "subagent-completed");
              } catch (error) {
                console.warn(`[polyth] delegated history import failed for ${childId}`, error);
              }
            }
            await settleDelegatedChild(childId, agent.status === "failed" ? "failed" : "done");
          }
          agents.push({ ...agent, sessionId: childId });
        }
        ev = { ...ev, agents };
      }
    }
    // Delegated work asks its parent for input by default. The child retains
    // the request (the runtime binding belongs there), while the parent gets a
    // replyable mirror marked with the canonical child ID.
    if (
      sideEffects
      && (ev.type === "permission/requested"
        || (ev.type === "question/asked" && !ev.questions.some((question) => secureRequest(ev.requestId, question))))
    ) {
      const child = await store.projection(sessionId);
      if (child?.parentId) {
        const { type: _type, ...data } = ev;
        await appendAndBroadcast(child.parentId, ev.type, {
          ...data as unknown as JsonObject,
          sourceSessionId: sessionId,
        }, { ignorable: true });
        await updateProjection(child.parentId, { status: "waiting" });
      }
    }
    switch (ev.type) {
      case "turn/started":
        // Runtime turn models must not replace the user's session choice.
        await persist(sessionId, "turn/started", { turnId: ev.turnId, ...(ev.model ? { model: ev.model } : {}) } as unknown as JsonObject, { ignorable: true });
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
            // A fresh turn (auto-resume, manual retry, or new prompt) settles
            // any pending rate-limit wait.
            await clearResume(sessionId, "resumed");
          }
        }
        break;
      case "session/title-generated": {
        // The first user prompt already makes the session legible in every
        // surface that reads the log; a semantic title that fails to materialize
        // is a naming bug only when OpenCode can do better than the raw prompt.
        if (!autoTitleRequested.has(sessionId)) break;
        const current = await store.projection(sessionId);
        if (!current || !isPlaceholderTitle(current.title, sessionId)) {
          if (sideEffects) autoTitleRequested.delete(sessionId);
          break;
        }
        const title = ev.title.trim().slice(0, 200);
        if (!title || isPlaceholderTitle(title, sessionId)) break;
        // "New session - <iso>" is OpenCode's failure mode (timestamp title
        // replaces the auto-title that never ran, e.g. a bad small model).
        // Persisting it as the visible title defeats the prompt-derived
        // fallback, so keep those names in backend territory only.
        if (/^new session - \d{4}-\d{2}-\d{2}t/i.test(title)) break;
        await persist(
          sessionId,
          "session/metadata-changed",
          { title, source: sessionRuntime.get(sessionId)?.harnessId ?? "runtime" },
          { ignorable: true, producerPlugin: sessionRuntime.get(sessionId)?.harnessId ? `backend-${sessionRuntime.get(sessionId)!.harnessId}` : "runtime" },
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
      case "turn/stopped": {
        const interruptQueued = ev.reason === "error" && deps.queue
          ? (await deps.queue.queueList(sessionId))[0]?.delivery === "interrupt"
          : false;
        const effectiveReason = ev.reason === "error" && interruptQueued ? "aborted" : ev.reason;
        // A provider capacity stop is recoverable: plan the auto-resume before
        // persisting so its resumeAt/attempt travel with the terminal event
        // (the UI renders a countdown instead of a generic failure).
        const retry = sideEffects && !observationReplay && effectiveReason === "error" && ev.retry
          ? await scheduleResume(sessionId, ev.retry, await store.events(sessionId))
          : undefined;
        await persist(sessionId, "turn/stopped", {
          turnId: ev.turnId ?? lastTurnId.get(sessionId) ?? ev.type,
          reason: effectiveReason,
          ...(ev.error ? { error: ev.error } : {}),
          ...(retry ? { retry: retry as unknown as JsonObject } : {}),
        }, { ignorable: true });
        if (sideEffects) {
          // Any non-limit terminal stop (completed / aborted / hard error)
          // supersedes a pending resume from an earlier limit stop.
          if (!retry) await clearResume(sessionId, "user");
          const requestsOpen = openRequestTotal(await logFacts(sessionId)) > 0;
          const nextStatus = requestsOpen
            ? "waiting"
            : effectiveReason === "error" ? "failed" : "idle";
          const through = dialogueThrough(await store.events(sessionId));
          const applied = await applyRuntimeProjection(
            sessionId,
            runtimeEventSeq,
            (current) => ({
              ...current,
              ...(current.runtimeLeg ? { runtimeLeg: { ...current.runtimeLeg, canonicalThroughSeq: through, bootstrap: "native-resume" as const } } : {}),
              status: nextStatus,
              updatedAt: Date.now(),
            }),
          );
          if (applied) {
            lastTurnId.delete(sessionId);
            admitting.delete(sessionId);
            // OpenCode can publish its generated session title after the
            // terminal status event. Keep this one-shot request alive until a
            // title update (or a later send) settles it.
            const titleRuntime = sessionRuntime.get(sessionId);
            if (titleRuntime && autoTitleRequested.has(sessionId)) {
              refreshGeneratedTitle(sessionId, titleRuntime);
            }
            const current = await store.projection(sessionId);
            if (current?.harnessTransition && !deps.isShuttingDown?.()) {
              void withSessionLock(sessionId, () => finishHarnessSwitchUnderLock(sessionId))
                .then(() => dispatchQueue(sessionId)).catch((error) => console.error("[polyth] harness switch remains pending", error));
            }
            deps.notify?.turnStopped(sessionId, effectiveReason);
            if (effectiveReason === "completed") hooks.onTurnCompleted?.(sessionId, replyText(sessionId));
            if (!requestsOpen && effectiveReason !== "error") {
              void dispatchQueue(sessionId);
            }
          }
        }
        break;
      }
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
                ...(ev.tokens.cacheRead !== undefined ? { cacheRead: (proj.tokenTotals?.cacheRead ?? 0) + ev.tokens.cacheRead } : {}),
                ...(ev.tokens.cacheWrite !== undefined ? { cacheWrite: (proj.tokenTotals?.cacheWrite ?? 0) + ev.tokens.cacheWrite } : {}),
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
          { ignorable: true, producerPlugin: sessionRuntime.get(sessionId)?.harnessId ? `backend-${sessionRuntime.get(sessionId)!.harnessId}` : "runtime" },
        );
        break;
      }
      case "compaction/part-recorded": {
        const { type: _t, ...data } = ev;
        await persist(
          sessionId,
          "compaction/part-recorded",
          data as unknown as JsonObject,
          { ignorable: true, producerPlugin: sessionRuntime.get(sessionId)?.harnessId ? `backend-${sessionRuntime.get(sessionId)!.harnessId}` : "runtime" },
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
    if (sideEffects) updateToolWatchdog(sessionId, ev);
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
        producerPlugin: sessionRuntime.get(sessionId)?.harnessId ? `backend-${sessionRuntime.get(sessionId)!.harnessId}` : "runtime",
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
    runtimes.bindSession?.(sessionId, rt);
    if (runtimeSubs.has(rt)) return;
    const subscriptions: Disposable[] = [];
    subscriptions.push(rt.onEvent((sid, ev) => {
      // deliver only to sessions currently wired to this runtime — the same
      // filter the old per-session closures applied, minus the listener pile-up.
      if (sessionRuntime.get(sid) !== rt) return;
      // Serialize each canonical session: a terminal turn/stopped can never be
      // overwritten by an older usage or chunk projection update.
      void withSessionLock(sid, async () => { if (sessionRuntime.get(sid) === rt) await onRuntimeEvent(sid, ev); }).catch((err) => {
        console.error(`[polyth] runtime event handling failed for ${sid}`, err);
      });
    }));
    if (rt.onObservation) {
      subscriptions.push(rt.onObservation((sid, observation) => {
        if (sessionRuntime.get(sid) !== rt) return;
        void withSessionLock(sid, async () => { if (sessionRuntime.get(sid) === rt) await ingestRuntimeObservation(sid, observation); }).catch((err) => {
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
            await recoverOwnedEpochIfPending(sid);
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
    runtimes.unbindSession?.(sessionId, rt);
    clearSessionToolWatchdogs(sessionId);
    turnReply.delete(sessionId);
    behaviorLogged.delete(sessionId);
    autoTitleRequested.delete(sessionId);
    for (const wired of sessionRuntime.values()) if (wired === rt) return;
    for (const subscription of runtimeSubs.get(rt) ?? []) subscription.dispose();
    runtimeSubs.delete(rt);
  };
  runtimes.onEvict?.(async (runtime) => {
    for (const [sessionId, wired] of [...sessionRuntime]) {
      if (wired === runtime) unwire(sessionId);
    }
  });

  const dialogueThrough = (events: readonly SessionEvent[]) => effectiveHistory([...events]).events.filter((event) => !event.ignorable && (event.type === "user/message" || event.type === "assistant/message")).at(-1)?.seq ?? 0;

  const runtimeFor = (projection: SessionProjection, cwd: string, targetHarnessId?: string): Promise<AgentRuntime> =>
    runtimes.forSession ? runtimes.forSession(projection, cwd, targetHarnessId) : runtimes.forProject(projection.projectId, cwd);

  const ensureWired = async (
    sessionId: string,
    proj: SessionProjection,
    admittedPreparedOperationId?: string,
  ): Promise<AgentRuntime> => {
    let rt = sessionRuntime.get(sessionId);
    if (!rt) {
      const project = await projects.get(proj.projectId);
      const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
      rt = await runtimeFor(proj, cwd);
      let attachedProjection = proj;
      if (!proj.backendSessionId && (await store.events(sessionId)).some((event) => event.type === "session/snapshot-imported")) {
        let operation = (await durable.operations(sessionId)).find((op) => op.mutationKind === "session-create");
        if (!operation) operation = (await broadcastTail(sessionId, () => durable.prepareOperation({
          sessionId, mutationKind: "session-create",
          intentEvent: { type: "session/native-create-requested", data: {}, ignorable: true },
        }))).operation;
        if (rt.harnessId && !proj.resolvedHarnessId) await updateProjection(sessionId, { resolvedHarnessId: rt.harnessId });
        if (operation.state === "prepared") {
          const request = { sessionId, projectId: proj.projectId, title: proj.title, cwd };
          const outcome = await runPreparedOperation<{ backendSessionId: string }, string>(operation,
            (id) => rt!.createSessionOperation ? rt!.createSessionOperation(request, id) : rt!.ensureSession(request),
            (backendSessionId) => ({ backendSessionId }),
            (result) => settleOperation(operation!, result.kind === "confirmed" ? { ...result, receipt: result.value.backendSessionId } : result));
          if (outcome.kind !== "confirmed") throw outcomeError(outcome);
        }
        attachedProjection = (await store.projection(sessionId))!;
      }

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
            runtimeBinding: attachedProjection.runtimeBinding ?? await newRuntimeBinding(rt, recoveredBackendId, cwd, "empty"),
            status: "reconciling",
          };
          await store.upsertProjection(attachedProjection);
          broadcast.projection(attachedProjection);
        } else {
          await updateProjectionQuietly(sessionId, { status: "unknown" });
          throw Object.assign(new Error("backend session creation outcome is unknown"), {
            code: "outcome-unknown",
          });
        }
      }
      // Validate/persist the durable endpoint binding before the facade is
      // allowed to register an existing backend ID in its in-memory map.
      try {
        await runtimeBinding(rt, attachedProjection, cwd);
      } catch (error) {
        if (await markOwnedEpochPending(sessionId, attachedProjection, rt, error)) {
          throw Object.assign(
            new Error("runtime replacement is pending a durable epoch transition"),
            { code: "epoch-pending" },
          );
        }
        throw error;
      }
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
        await updateProjectionQuietly(sessionId, { status: "unknown" });
        throw error;
      }
      if (rt.harnessId && !attachedProjection.runtimeLeg) {
        const history = await store.events(sessionId);
        const imported = history.some((event) => event.type === "session/snapshot-imported");
        await updateProjection(sessionId, {
          harness: attachedProjection.harness ?? { mode: "auto" }, resolvedHarnessId: rt.harnessId,
          runtimeLeg: { id: randomUUID(), harnessId: rt.harnessId, nativeSessionId: attachedProjection.backendSessionId!, startedAt: Date.now(), canonicalThroughSeq: imported ? 0 : dialogueThrough(history), bootstrap: imported ? "continuity" : "native-resume" },
        });
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
      else if (e.type === "question/answered" || e.type === "question/expired") questions.delete(rid);
      else if (e.type === "permission/requested") perms.add(rid);
      else if (e.type === "permission/resolved" || e.type === "permission/expired") perms.delete(rid);
      else if (e.type === "secret/requested") secrets.add(rid);
      else if (e.type === "secret/resolved" || e.type === "secret/expired") secrets.delete(rid);
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
    if (
      proj.status === "reconciling"
      || proj.status === "epoch-pending"
      || proj.status === "unknown"
    ) {
      throw Object.assign(new Error(`unavailable while the session is ${proj.status}`), { code: "conflict" });
    }
    const reconciliation = await durable.reconciliation(sessionId);
    if (reconciliation?.state === "reconciling"
      || reconciliation?.state === "blocked") {
      throw Object.assign(new Error(`unavailable while reconciliation is ${reconciliation.state}`), {
        code: "conflict",
      });
    }
    // A stale/insufficient reconciliation snapshot is not itself a mutation
    // in flight. The runtime binding and live admission checks below are the
    // authoritative guards; blocking here strands otherwise idle sessions.
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
      }, { timeoutMs: 120_000, maxOutputBytes: 64 * 1_024 });
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

  const closeParentRequestMirror = async (
    childSessionId: string,
    requestId: string,
    kind: "permission" | "question",
    payload: JsonObject,
  ): Promise<void> => {
    const child = await store.projection(childSessionId);
    if (!child?.parentId) return;
    const parentId = child.parentId;
    const parentFacts = await logFacts(parentId);
    const stillOpen = kind === "permission"
      ? parentFacts.openPermissions.has(requestId)
      : parentFacts.openQuestions.has(requestId);
    if (!stillOpen) return;
    await appendAndBroadcast(
      parentId,
      kind === "permission" ? "permission/resolved" : "question/answered",
      { requestId, ...payload },
      { ignorable: true },
    );
    await settleAfterLastRequest(parentId);
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
    await settleAfterLastRequest(sessionId);
    await closeParentRequestMirror(sessionId, requestId, "permission", {
      reply,
      ...(auto ? { auto: true } : {}),
      ...(scope ? { scope } : {}),
    });
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
    await settleAfterLastRequest(sessionId);
    await closeParentRequestMirror(sessionId, requestId, "question", {
      ...(reject ? { rejected: true } : { answers }),
    });
  };

  /** F2: shape-check + prepare attachments before anything is logged or
   *  queued. Ordinary project files are existence-checked against the
   *  session's execution root; staged `_inbox/*` uploads are materialized
   *  into that root (a linked worktree or remote host needs its own copy).
   *  Failures raise a typed, name-only error — no path or file contents. */
  const prepareAttachments = async (
    proj: SessionProjection, raw: unknown, sessionId: string,
  ): Promise<AttachmentRef[] | undefined> => {
    const maxBytes = deps.attachments?.maxBytes ?? 20 * 1024 * 1024;
    const refs = sanitizeAttachments(raw, { maxBytes, projectId: proj.projectId });
    if (refs.length === 0) return undefined;
    const committedIds: string[] = [];
    for (const ref of refs) {
      if (ref.kind !== "browser-context") continue;
      const ctx = ref.browserContext;
      if (!ctx) {
        throw Object.assign(new Error("browser context required"), { code: "invalid-input" });
      }
      for (const key of ["screenshot", "crop"] as const) {
        const art = ctx[key];
        if (!art) continue;
        if (!deps.browserArtifacts) {
          throw Object.assign(new Error("browser artifacts unavailable"), { code: "unavailable" });
        }
        const resolved = await deps.browserArtifacts.resolve(art.id);
        if (!resolved) {
          delete ctx[key];
          continue;
        }
        art.mime = resolved.mime;
        art.size = resolved.size;
        art.localPath = resolved.localPath;
        committedIds.push(art.id);
      }
      const thumb = ctx.crop ?? ctx.screenshot;
      if (thumb) ref.url = `/api/browser/artifacts?id=${encodeURIComponent(thumb.id)}`;
      else delete ref.url;
    }
    if (committedIds.length && deps.browserArtifacts?.commit) {
      await deps.browserArtifacts.commit(committedIds);
    }
    if (!deps.attachments) {
      // The files package failed to load: ordinary refs pass through as before,
      // but a staged upload can never be materialized — fail loudly.
      if (refs.some((ref) => ref.path?.startsWith("_inbox/"))) {
        throw Object.assign(new Error("attachment staging is unavailable"), { code: "unsupported" });
      }
      return refs;
    }
    const project = await projects.get(proj.projectId);
    const projectRoot = project?.path;
    const execRoot = proj.worktreePath ?? project?.path;
    if (!projectRoot || !execRoot) {
      throw Object.assign(new Error("project not found"), { code: "not-found" });
    }
    for (const ref of refs) {
      if (ref.kind === "browser-context") continue;
      if (!ref.path) continue; // url attachments have nothing on disk
      const rel = ref.path;
      let stat: { kind: "file" | "dir"; size: number };
      try {
        stat = rel.startsWith("_inbox/")
          ? await deps.attachments.materialize({ projectId: proj.projectId, projectRoot, execRoot, rel })
          : await deps.attachments.stat(execRoot, rel);
      } catch {
        console.warn(
          `[polyth] attachment prepare failed attachmentId=${ref.id} sessionId=${sessionId} `
          + `projectId=${proj.projectId} execRoot=${execRoot} rel=${rel}`,
        );
        throw Object.assign(new Error(`attachment could not be prepared: ${ref.name}`), { code: "invalid-input" });
      }
      if (stat.kind !== "file") {
        throw Object.assign(new Error(`attachment could not be prepared: ${ref.name}`), { code: "invalid-input" });
      }
      if (stat.size > deps.attachments.maxBytes) {
        throw Object.assign(new Error(`attachment is too large: ${ref.name}`), { code: "invalid-input" });
      }
      ref.size = stat.size; // trust disk, not the client
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

  const runtimeEpochRecoveryPlan = async (
    sessionId: string,
    events: readonly SessionEvent[],
    includeWorkflow: boolean,
    includeRestored = false,
  ) => {
    const operations = await durable.operations(sessionId);
    const heldQueueIds = new Set(
      (await deps.queue?.queueList(sessionId) ?? [])
        .filter((item) => item.heldForReview)
        .map((item) => item.id),
    );
    const workflow = includeWorkflow
      ? await hooks.runtimeEpochContext?.(sessionId, events)
      : undefined;
    const proj = await store.projection(sessionId);
    const sensitiveEnv = Object.entries(process.env).filter(([key, value]) => value && /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(key)).map(([, value]) => value!);
    const sanitize = (value: string) => redactContinuity(deps.secureSafe?.redact?.(value) ?? value, sensitiveEnv);
    const safeEvents = events.map((event) => ({ ...event, data: JSON.parse(JSON.stringify(event.data, (_key, value) => typeof value === "string" ? sanitize(value) : value)) as JsonObject }));
    const project = proj ? await projects.get(proj.projectId) : undefined;
    const workspace = proj ? await continuityWorkspace(proj.worktreePath ?? project?.path ?? process.cwd(), Boolean(project?.remote)) : undefined;
    const safeWorkspace = workspace ? JSON.parse(JSON.stringify(workspace, (_key, value) => typeof value === "string" ? sanitize(value) : value)) as typeof workspace : undefined;
    const safeWorkflow = workflow ? JSON.parse(JSON.stringify(workflow, (_key, value) => typeof value === "string" ? sanitize(value) : value)) as typeof workflow : undefined;
    return planRuntimeEpochRecovery({
      events: safeEvents,
      ...(safeWorkspace ? { workspace: safeWorkspace } : {}),
      operations,
      heldQueueIds,
      includeWorkflow,
      includeRestored,
      workflow: {
        ...(safeWorkflow?.objective ? { objective: safeWorkflow.objective } : {}),
        ...(safeWorkflow?.pinned ? { pinned: safeWorkflow.pinned } : {}),
        ...(safeWorkflow?.behavior ? { behavior: safeWorkflow.behavior } : {}),
        ...(safeWorkflow?.agent ?? proj?.runtimeLeg?.agentIntent ?? proj?.agent
          ? { agent: sanitize((safeWorkflow?.agent ?? proj?.runtimeLeg?.agentIntent ?? proj?.agent)!) }
          : {}),
      },
    });
  };

  /** Dispatch the next queued message iff the session is idle. Never enters an
   *  active stream: re-checked after every await. */
  const dispatchQueue = async (sessionId: string): Promise<void> => {
    if (!deps.queue) return;
    try {
      await withSessionLock(sessionId, async () => {
        if (deps.isShuttingDown?.() || deps.admission?.fenced()) return;
        let proj = await store.projection(sessionId);
        if (proj?.harnessTransition) proj = await finishHarnessSwitchUnderLock(sessionId);
        if (deps.isShuttingDown?.() || deps.admission?.fenced()) return;
        if (turnActive(sessionId)) return;
        if (!proj || proj.harnessTransition || proj.status !== "idle") return;
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
        if (reserved.kind === "held") return;
        if (reserved.kind === "blocked" && reserved.reservation.operation.state !== "prepared") return;
        const rt = await ensureWired(
          sessionId,
          proj,
          reserved.reservation.operation.operationId,
        );
        const current = await store.projection(sessionId);
        if (!current || current.status !== "idle" || turnActive(sessionId)) return;
        // Re-prepare on dispatch: a queued `_inbox/*` upload was materialized at
        // send time, but the owning worktree may have changed since, so ensure
        // the bytes are present at the current execution root before admission.
        const queuedAttachments = reserved.reservation.queueItem.attachments?.length
          ? await prepareAttachments(current, reserved.reservation.queueItem.attachments, sessionId)
          : undefined;
        await admitTurnCore(sessionId, current, rt, {
          text: reserved.reservation.queueItem.text,
          ...(queuedAttachments?.length ? { attachments: queuedAttachments } : {}),
        }, {
          operation: reserved.reservation.operation,
          queueId: reserved.reservation.queueItem.id,
        });
      });
    } catch (err) {
      if (QUIET_DISPATCH_ERRORS.has(String((err as { code?: unknown })?.code))) return;
      console.error(`[polyth] queued dispatch failed for ${sessionId}`, err);
    }
  };

  /** Expansion + user/message append + startTurn. Callers already decided
   *  admission; this is the single place a text enters the model stream. */
  const admitTurnCoreUnfenced = async (
    sessionId: string, proj: SessionProjection, rt: AgentRuntime, input: UserTurnInput,
    reserved?: { operation: DurableOperation; queueId: string },
  ): Promise<SendResult> => {
    if ((await store.projection(sessionId))?.harnessTransition) {
      throw Object.assign(new Error("harness switch is pending"), { code: "conflict" });
    }
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
    const model = input.model ?? cmdModel ?? proj.model;
    const agent = input.agent ?? cmdAgent ?? proj.agent;
    await requireLaunchModelForAutoAgent(rt, agent, model);
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
    const recoveryEvents = await store.events(sessionId);
    const decoration = hooks.beforeTurn
      ? await hooks.beforeTurn(sessionId, recoveryEvents)
      : null;
    const epochRecovery = await runtimeEpochRecoveryPlan(
      sessionId,
      recoveryEvents,
      decoration === null,
    );
    const recoveryContext = [
      epochRecovery?.recoveryContext,
      decoration?.recoveryContext,
    ].filter((value): value is string => Boolean(value)).join("\n\n");
    const epochPinnedSourceSeqs = epochRecovery
      ? [...new Set([
          ...epochRecovery.pinnedSourceSeqs,
          ...(decoration?.pinnedSourceSeqs ?? []),
        ])]
      : [];
    const messageData: JsonObject = {
      text, ...(raw !== text ? { raw } : {}),
      ...(reserved ? { queueId: reserved.queueId } : {}),
      ...(input.githubConflictResolution === true ? { githubConflictResolution: true } : {}),
      ...(input.attachments ? { attachments: input.attachments as unknown as JsonObject[] } : {}),
      ...(recoveryContext ? { recoveryContext } : {}),
      ...(decoration ? {
        compactionRecovery: {
          compactionSeq: decoration.compactionSeq,
          ...(decoration.goalRestored ? { goalRestored: true } : {}),
          ...(decoration.pinnedSourceSeqs.length
            ? { pinnedSourceSeqs: decoration.pinnedSourceSeqs }
            : {}),
        },
      } : {}),
      ...(epochRecovery ? {
        runtimeEpochRecovery: {
          epoch: epochRecovery.epoch,
          markerSeq: epochRecovery.markerSeq,
          ...(epochRecovery.goalRestored || decoration?.goalRestored
            ? { goalRestored: true }
            : {}),
          ...(epochPinnedSourceSeqs.length
            ? { pinnedSourceSeqs: epochPinnedSourceSeqs }
            : {}),
        },
      } : {}),
      ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.agentProfileId ? {
        ...(model ? { resolvedModel: model as unknown as JsonObject } : {}),
        ...(agent ? { resolvedAgent: agent } : {}),
      } : {}),
      ...(input.autoResume === true ? { autoResume: true } : {}),
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
          text: recoveredUserText(text, recoveryContext || undefined),
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
    if (epochRecovery && !decoration && epochRecovery.goalRestored) {
      await appendAndBroadcast(sessionId, "goal/context-restored", {
        epoch: epochRecovery.epoch,
        epochMarkerSeq: epochRecovery.markerSeq,
        sourceMessageSeq: message!.seq,
      }, { ignorable: true });
    }
    if (epochRecovery && !decoration && epochRecovery.pinnedSourceSeqs.length) {
      await appendAndBroadcast(sessionId, "context/restored", {
        epoch: epochRecovery.epoch,
        epochMarkerSeq: epochRecovery.markerSeq,
        sourceMessageSeq: message!.seq,
        pinnedSourceSeqs: epochRecovery.pinnedSourceSeqs,
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
      let current = (await store.projection(sessionId)) ?? proj;
      const active = turnActive(sessionId);
      if (current.harnessTransition) {
        current = await finishHarnessSwitchUnderLock(sessionId);
        if (current.harnessTransition) return enqueueMessage(sessionId, input.text, "queue", "harness-switch", input.attachments);
        rt = await ensureWired(sessionId, current);
      }
      let stoppedTurnRecorded = hasPersistedStoppedTurn(await store.events(sessionId));
      const unsafeStatus = current.status === "reconciling"
        || (current.status === "unknown" && !stoppedTurnRecorded);
      const reconciliation = await durable.reconciliation(sessionId);
      const barrier = reconciliation?.state === "reconciling"
        || reconciliation?.state === "blocked"
        || (reconciliation?.state === "unknown" && !stoppedTurnRecorded);
      const unresolved = await sendAdmissionBlocking(sessionId);
      const reservedId = reserved?.operation.operationId;
      const blocking = unresolved && unresolved.operationId !== reservedId
        ? unresolved
        : undefined;
      const requestsWaiting = openRequestTotal(await logFacts(sessionId)) > 0;
      if (active || unsafeStatus || barrier || blocking || requestsWaiting) {
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
            : blocking
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
      const binding = await newRuntimeBinding(runtime, remote.id, project.path, undefined);
      if (await durable.hasDeletionTombstone({
        canonicalSessionId: `candidate:${remote.id}`,
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

  const transitionRuntimeEpochUnderLock = async (
    sessionId: string,
    runtime: AgentRuntime,
    options: RuntimeEpochTransitionOptions,
  ): Promise<RuntimeEpochTransitionResult> => {
        const projection = await store.projection(sessionId);
        if (!projection) {
          throw Object.assign(new Error("session not found"), { code: "not-found" });
        }
        const oldBinding = projection.runtimeBinding;
        if (!oldBinding || projection.backendSessionId !== oldBinding.backendSessionId) {
          throw Object.assign(
            new Error("runtime epoch transition requires a complete persisted binding"),
            { code: "binding-mismatch" },
          );
        }
        const endpoint = await (runtime as ReliabilityRuntime).endpoint?.();
        if (!endpoint) {
          throw Object.assign(
            new Error("runtime epoch transition requires endpoint identity"),
            { code: "unsupported" },
          );
        }
        let fence: RuntimeEpochFence | undefined;
        if (options.authorityDisposition.kind === "unknown-session-replaced") {
          if (lastTurnId.has(sessionId) || admitting.has(sessionId)) {
            throw Object.assign(
              new Error("cannot replace an unknown session while a turn is active"),
              { code: "conflict" },
            );
          }
        } else if (endpoint.control.kind === "owned") {
          const disposition = options.authorityDisposition;
          if (
            disposition.kind !== "session-execution-released"
            && disposition.kind !== "owned-authority-destroyed"
          ) {
            throw Object.assign(
              new Error("owned runtime epoch requires proof of the released binding"),
              { code: "epoch-proof-required" },
            );
          }
          if (
            disposition.authorityId !== oldBinding.authorityId
            || disposition.generation !== oldBinding.generation
          ) {
            throw Object.assign(
              new Error("owned runtime epoch requires proof of the released binding"),
              { code: "epoch-proof-required" },
            );
          }
          if (
            disposition.kind === "owned-authority-destroyed"
            && endpoint.authorityId === oldBinding.authorityId
          ) {
            throw Object.assign(
              new Error("owned runtime epoch requires proof of the destroyed binding"),
              { code: "epoch-proof-required" },
            );
          }
          if (disposition.kind === "session-execution-released") {
            fence = {
              mode: "session-released",
              authorityId: disposition.authorityId,
              generation: disposition.generation,
              backendSessionId: disposition.backendSessionId,
            };
          } else {
            fence = {
              mode: "destroyed",
              authorityId: disposition.authorityId,
              generation: disposition.generation,
            };
          }
        } else if (options.authorityDisposition.kind !== "borrowed-runtime-confirmed") {
          throw Object.assign(
            new Error("borrowed runtime epoch requires explicit user confirmation"),
            { code: "confirmation-required" },
          );
        } else if (turnActive(sessionId)) {
          throw Object.assign(
            new Error("borrowed runtime epoch cannot replace an active turn"),
            { code: "conflict" },
          );
        }

        const reset = await durable.operation(options.resetOperationId);
        if (
          !reset
          || reset.sessionId !== sessionId
          || reset.mutationKind !== "session-reset"
          || reset.state !== "confirmed"
          || !reset.receipt
          || reset.receipt === oldBinding.backendSessionId
        ) {
          throw Object.assign(
            new Error("runtime epoch transition requires a confirmed fresh session-reset"),
            { code: "epoch-reset-unconfirmed" },
          );
        }
        const epoch = oldBinding.epoch ?? 0;
        if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) {
          throw Object.assign(new Error("runtime epoch is invalid or exhausted"), {
            code: "invalid-input",
          });
        }
        const protocol = await (runtime as ReliabilityRuntime).protocol?.()
          ?? oldBinding.protocol;
        const currentEndpoint = await (runtime as ReliabilityRuntime).endpoint?.();
        if (
          !currentEndpoint
          || currentEndpoint.authorityId !== endpoint.authorityId
          || currentEndpoint.generation !== endpoint.generation
          || currentEndpoint.location.directory !== endpoint.location.directory
          || (currentEndpoint.location.workspace ?? "") !== (endpoint.location.workspace ?? "")
        ) {
          throw Object.assign(
            new Error("runtime endpoint changed during epoch preparation"),
            { code: "stale-evidence" },
          );
        }
        const replacementBinding: PersistedRuntimeBinding = {
          backendSessionId: reset.receipt,
          authorityId: endpoint.authorityId,
          generation: endpoint.generation,
          epoch: epoch + 1,
          continuity: endpoint.continuity,
          protocol,
          location: endpoint.location,
          historyBaseline: "empty",
        };
        const result = await broadcastTail(sessionId, () => durable.transitionRuntimeEpoch({
          sessionId,
          expectedBinding: oldBinding,
          replacementBinding,
          resetOperationId: reset.operationId,
          reason: options.reason,
          ...(options.harness ? { harness: options.harness } : {}),
          ...(fence ? { fence } : {}),
        }));
        lastTurnId.delete(sessionId);
        admitting.delete(sessionId);
        unwire(sessionId);
        broadcast.projection(result.projection);
        return result;
  };

  const prepareFreshEpochResetUnderLock = async (
    sessionId: string,
    projection: SessionProjection,
    runtime: AgentRuntime,
    endpoint: RuntimeEndpoint,
    cwd: string,
  ): Promise<DurableOperation> => {
    const oldBinding = projection.runtimeBinding;
    if (!oldBinding) {
      throw Object.assign(
        new Error("runtime epoch recovery requires a complete persisted binding"),
        { code: "binding-mismatch" },
      );
    }
    const events = await store.events(sessionId);
    const eventBySeq = new Map(events.map((event) => [event.seq, event]));
    const resetCandidates = (await durable.operations(sessionId))
      .filter((operation) => {
        if (
          operation.mutationKind !== "session-reset"
          || operation.state === "fenced"
          || operation.state === "rejected"
          || operation.state === "not-applied"
          || operation.receipt === oldBinding.backendSessionId
        ) {
          return false;
        }
        const owner = operation.ownerEventSeq === undefined
          ? undefined
          : eventBySeq.get(operation.ownerEventSeq);
        const data = owner?.data as {
          reason?: unknown;
          targetAuthorityId?: unknown;
          targetGeneration?: unknown;
          targetContinuity?: unknown;
        } | undefined;
        return owner?.type === "session/reset-intended"
          && data?.reason === "runtime-epoch-rehydration"
          && data.targetAuthorityId === endpoint.authorityId
          && (
            Number(data.targetGeneration) === endpoint.generation
            || (
              data.targetContinuity === "verified"
              && endpoint.continuity === "verified"
            )
          );
      })
      .sort((left, right) => right.ordinal - left.ordinal);
    let reset = resetCandidates[0];
    if (reset?.state === "executing" || reset?.state === "unknown") {
      throw Object.assign(
        new Error("fresh backend session creation outcome remains unknown"),
        { code: "outcome-unknown", operationId: reset.operationId },
      );
    }
    if (!reset) {
      const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
        sessionId,
        mutationKind: "session-reset",
        intentEvent: {
          type: "session/reset-intended",
          data: {
            reason: "runtime-epoch-rehydration",
            oldAuthorityId: oldBinding.authorityId,
            oldGeneration: oldBinding.generation,
            oldEpoch: oldBinding.epoch ?? 0,
            targetAuthorityId: endpoint.authorityId,
            targetGeneration: endpoint.generation,
            targetContinuity: endpoint.continuity,
          },
          ignorable: true,
        },
      }));
      reset = prepared.operation;
    }
    if (reset.state === "prepared") {
      const outcome = await runPreparedOperation<{ backendSessionId: string }, string>(
        reset,
        async (operationId) => {
          const request = {
            projectId: projection.projectId,
            title: projection.title,
            sessionId,
            cwd,
            ...(projection.model ? { model: projection.model } : {}),
            ...(projection.agent ? { agent: projection.agent } : {}),
          };
          if (!runtime.resetSessionOperation) {
            return runtime.resetSession
              ? runtime.resetSession(request)
              : Promise.resolve({
                  kind: "rejected" as const,
                  code: "capability-unsupported",
                  message: "runtime cannot create a fresh backend session",
                });
          }
          const outcome = await runtime.resetSessionOperation(request, operationId);
          // The server facade exposes both methods for compatibility. A
          // legacy adapter therefore reports capability-unsupported from the
          // operation-aware seam even when its plain reset is usable.
          return outcome.kind === "rejected"
            && outcome.code === "capability-unsupported"
            && runtime.resetSession
            ? runtime.resetSession(request)
            : outcome;
        },
        (backendSessionId) => ({ backendSessionId }),
      );
      if (outcome.kind !== "confirmed") throw outcomeError(outcome);
      reset = (await durable.operation(reset.operationId))!;
    }
    return reset;
  };

  const establishFreshRuntimeEpochUnderLock = async (
    sessionId: string,
    projection: SessionProjection,
    runtime: AgentRuntime,
    resetOperationId?: string,
  ): Promise<SessionProjection> => {
    unwire(sessionId);
    await ensureWired(sessionId, projection);
    let ready = await store.projection(sessionId);
    let reconciliation = await durable.reconciliation(sessionId);
    const resetOrdinal = resetOperationId
      ? (await durable.operation(resetOperationId))?.ordinal
      : undefined;
    const currentBlocker = (await durable.operations(sessionId)).some((operation) =>
      isRuntimeOperationBlocking(operation)
      && !(operation.state === "unknown"
        && resetOrdinal !== undefined
        && operation.ordinal < resetOrdinal),
    );
    const reconciliationOrdinal = reconciliation?.ordinal;
    if (!currentBlocker
      && ready?.status === "unknown"
      && resetOrdinal !== undefined
      && reconciliationOrdinal !== undefined
      && reconciliation?.state !== "ready") {
      await broadcastTail(sessionId, () => durable.settleReconciliation(
        sessionId,
        reconciliationOrdinal,
        "ready",
      ));
      await updateProjection(sessionId, { status: "idle" });
      ready = await store.projection(sessionId);
      reconciliation = await durable.reconciliation(sessionId);
    }
    if (
      !ready
      || ready.status !== "idle"
      || reconciliation?.state !== "ready"
    ) {
      throw Object.assign(
        new Error("fresh runtime epoch could not establish an idle reconciled session"),
        { code: ready?.status === "unknown" ? "outcome-unknown" : "conflict" },
      );
    }
    return ready;
  };

  const recoverFreshRuntimeEpochUnderLock = async (
    sessionId: string,
    recoveryKind: "epoch" | "unknown" = "epoch",
  ): Promise<{ projection: SessionProjection; runtime: AgentRuntime }> => {
    if ((await store.projection(sessionId))?.harnessTransition) throw Object.assign(new Error("harness switch pending"), { code: "conflict" });
    const replacingUnknown = recoveryKind === "unknown";
    let resetOperationId: string | undefined;
    let projection = await store.projection(sessionId);
    if (!projection?.runtimeBinding || !projection.backendSessionId) {
      throw Object.assign(
        new Error("runtime epoch recovery requires a complete persisted binding"),
        { code: "binding-mismatch" },
      );
    }
    const project = await projects.get(projection.projectId);
    const cwd = projection.worktreePath ?? project?.path ?? process.cwd();
    const runtime = await runtimeFor(projection, cwd);
    if (replacingUnknown && !runtime.resetSessionOperation && !runtime.resetSession) {
      throw Object.assign(new Error("cannot send while the session is unknown"), {
        code: "conflict",
      });
    }
    if (replacingUnknown && (lastTurnId.has(sessionId) || admitting.has(sessionId))) {
      throw Object.assign(
        new Error("cannot replace an unknown session while a turn is active"),
        { code: "conflict" },
      );
    }
    if (replacingUnknown && projection.status !== "unknown") {
      await ensureWired(sessionId, projection);
      return {
        projection: (await store.projection(sessionId)) ?? projection,
        runtime,
      };
    }
    const endpoint = await (runtime as ReliabilityRuntime).endpoint?.();
    if (!endpoint) {
      throw Object.assign(new Error("runtime epoch recovery requires endpoint identity"), {
        code: "unsupported",
      });
    }
    const events = await store.events(sessionId);
    const marker = events.findLast((event) => event.type === "runtime/epoch-replaced");
    const markerNew = marker?.data as {
      new?: { authorityId?: unknown; generation?: unknown; epoch?: unknown };
    } | undefined;
    const bindingEpoch = projection.runtimeBinding.epoch ?? 0;
    const protocol = await (runtime as ReliabilityRuntime).protocol?.()
      ?? projection.runtimeBinding.protocol;
    if (replacingUnknown && !canRebindPersistedSession(projection.runtimeBinding, {
      backendSessionId: projection.backendSessionId,
      endpoint,
      protocol,
    })) {
      throw Object.assign(
        new Error("runtime epoch requires explicit confirmation for this endpoint"),
        { code: endpoint.control.kind === "owned" ? "epoch-proof-required" : "confirmation-required" },
      );
    }
    const transitionAlreadyCommitted = !replacingUnknown
      && markerNew?.new?.authorityId === projection.runtimeBinding.authorityId
      && Number(markerNew.new.epoch) === bindingEpoch
      && endpoint.authorityId === projection.runtimeBinding.authorityId
      && canRebindPersistedSession(projection.runtimeBinding, {
        backendSessionId: projection.backendSessionId,
        endpoint,
        protocol,
      });

    if (!transitionAlreadyCommitted) {
      if (replacingUnknown) {
        // Stop listening to the unusable backend before creating its
        // replacement. The canonical log remains the source of recovery
        // context; only the runtime context is replaced.
        const eventsBeforeReset = await store.events(sessionId);
        if (openTurnFromEvents(eventsBeforeReset) || activeToolsFromEvents(eventsBeforeReset).size > 0) {
          await stopLocally(sessionId);
        }
        unwire(sessionId);
        let reset: DurableOperation;
        try {
          reset = await prepareFreshEpochResetUnderLock(
            sessionId,
            projection,
            runtime,
            endpoint,
            cwd,
          );
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (code === "unsupported" || code === "capability-unsupported") {
            throw Object.assign(new Error("cannot send while the session is unknown"), {
              code: "conflict",
            });
          }
          throw error;
        }
        resetOperationId = reset.operationId;
        await transitionRuntimeEpochUnderLock(sessionId, runtime, {
          resetOperationId: reset.operationId,
          reason: "unknown backend session replaced; restoring confirmed canonical history",
          authorityDisposition: { kind: "unknown-session-replaced" },
        });
        projection = (await store.projection(sessionId))!;
      } else {
        if (
          endpoint.control.kind !== "owned"
          || endpoint.authorityId === projection.runtimeBinding.authorityId
        ) {
          throw Object.assign(
            new Error("runtime epoch requires explicit confirmation for this endpoint"),
            { code: endpoint.control.kind === "owned" ? "epoch-proof-required" : "confirmation-required" },
          );
        }
        const oldBinding = projection.runtimeBinding;
        const reset = await prepareFreshEpochResetUnderLock(
          sessionId,
          projection,
          runtime,
          endpoint,
          cwd,
        );
        resetOperationId = reset.operationId;
        await transitionRuntimeEpochUnderLock(sessionId, runtime, {
          resetOperationId: reset.operationId,
          reason: "owned runtime authority changed; restoring confirmed canonical history",
          authorityDisposition: {
            kind: "owned-authority-destroyed",
            authorityId: oldBinding.authorityId,
            generation: oldBinding.generation,
          },
        });
        projection = (await store.projection(sessionId))!;
      }
    }

    const ready = await establishFreshRuntimeEpochUnderLock(
      sessionId,
      projection,
      runtime,
      resetOperationId,
    );
    return { projection: ready, runtime };
  };

  const ownedEpochRecoveryFlights = new Map<string, Promise<void>>();
  recoverOwnedEpochIfPending = (sessionId: string): Promise<void> => {
    const existing = ownedEpochRecoveryFlights.get(sessionId);
    if (existing) return existing;
    const flight = withSessionLock(sessionId, async () => {
      const projection = await store.projection(sessionId);
      if (
        !projection
        || projection.status !== "epoch-pending"
        || projection.runtimeControl !== "owned"
      ) return;
      await recoverFreshRuntimeEpochUnderLock(sessionId);
    }).catch((error) => {
      // Keep the durable pending state when a fresh runtime cannot be created;
      // a later runtime event or send can retry the same recovery path.
      console.error(`[polyth] automatic runtime epoch recovery failed for ${sessionId}`, error);
    }).finally(() => {
      if (ownedEpochRecoveryFlights.get(sessionId) === flight) {
        ownedEpochRecoveryFlights.delete(sessionId);
      }
    });
    ownedEpochRecoveryFlights.set(sessionId, flight);
    return flight;
  };

  const confirmBorrowedRuntimeEpochUnderLock = async (
    sessionId: string,
  ): Promise<SessionProjection> => {
    const projection = await store.projection(sessionId);
    if (!projection) {
      throw Object.assign(new Error("session not found"), { code: "not-found" });
    }
    if (projection.status === "archived") {
      throw Object.assign(new Error("unavailable while the session is archived"), { code: "conflict" });
    }
    if (turnActive(sessionId)) {
      throw Object.assign(new Error("borrowed runtime epoch cannot replace an active turn"), {
        code: "conflict",
      });
    }
    if (!projection.runtimeBinding || !projection.backendSessionId) {
      throw Object.assign(
        new Error("runtime epoch confirmation requires a complete persisted binding"),
        { code: "binding-mismatch" },
      );
    }
    const project = await projects.get(projection.projectId);
    const cwd = projection.worktreePath ?? project?.path ?? process.cwd();
    const runtime = await runtimeFor(projection, cwd);
    const endpoint = await (runtime as ReliabilityRuntime).endpoint?.();
    if (!endpoint) {
      throw Object.assign(new Error("runtime epoch confirmation requires endpoint identity"), {
        code: "unsupported",
      });
    }
    if (endpoint.control.kind === "owned") {
      throw Object.assign(
        new Error("owned runtime epoch requires proof of the destroyed binding"),
        { code: "epoch-proof-required" },
      );
    }
    if (
      projection.status !== "epoch-pending"
      || projection.runtimeControl !== "borrowed"
    ) {
      throw Object.assign(
        new Error("borrowed runtime epoch confirmation is only allowed for a pending borrowed identity break"),
        { code: "confirmation-not-required" },
      );
    }
    const protocol = await (runtime as ReliabilityRuntime).protocol?.()
      ?? projection.runtimeBinding.protocol;
    if (canRebindPersistedSession(projection.runtimeBinding, {
      backendSessionId: projection.backendSessionId,
      endpoint,
      protocol,
    })) {
      throw Object.assign(
        new Error("borrowed runtime epoch confirmation requires a failed rebind"),
        { code: "confirmation-not-required" },
      );
    }
    const reset = await prepareFreshEpochResetUnderLock(
      sessionId,
      projection,
      runtime,
      endpoint,
      cwd,
    );
    await transitionRuntimeEpochUnderLock(sessionId, runtime, {
      resetOperationId: reset.operationId,
      reason: "user confirmed replacement of an external runtime",
      authorityDisposition: { kind: "borrowed-runtime-confirmed" },
    });
    const next = (await store.projection(sessionId))!;
    unwire(sessionId);
    await ensureWired(sessionId, next);
    let ready = await store.projection(sessionId);
    let reconciliation = await durable.reconciliation(sessionId);
    const resetOrdinal = (await durable.operation(reset.operationId))?.ordinal;
    const unresolved = await blockingOperation(sessionId);
    if (
      unresolved?.state === "unknown"
      && resetOrdinal !== undefined
      && unresolved.ordinal < resetOrdinal
    ) {
      const current = await durable.reconciliation(sessionId);
      if (current && current.state !== "ready") {
        await broadcastTail(sessionId, () => durable.settleReconciliation(
          sessionId,
          current.ordinal,
          "ready",
        ));
      }
      if (ready?.status !== "idle") {
        await updateProjection(sessionId, { status: "idle" });
      }
      ready = await store.projection(sessionId);
      reconciliation = await durable.reconciliation(sessionId);
    }
    if (
      !ready
      || ready.status !== "idle"
      || reconciliation?.state !== "ready"
    ) {
      throw Object.assign(
        new Error("fresh runtime epoch could not establish an idle reconciled session"),
        { code: ready?.status === "unknown" ? "outcome-unknown" : "conflict" },
      );
    }
    return ready;
  };

  const latestConfirmedEpochResetOrdinal = async (
    sessionId: string,
  ): Promise<number | undefined> => {
    const events = await store.events(sessionId);
    const resetIds = events
      .filter((event) => event.type === "runtime/epoch-replaced")
      .map((event) => (event.data as { resetOperationId?: unknown }).resetOperationId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (resetIds.length === 0) return undefined;
    const named = new Set(resetIds);
    const reset = (await durable.operations(sessionId))
      .filter((operation) =>
        operation.mutationKind === "session-reset"
        && operation.state === "confirmed"
        && named.has(operation.operationId))
      .sort((left, right) => right.ordinal - left.ordinal)[0];
    return reset?.ordinal;
  };

  const sendAdmissionBlocking = async (
    sessionId: string,
  ): Promise<DurableOperation | undefined> => {
    const resetOrdinal = await latestConfirmedEpochResetOrdinal(sessionId);
    const recoveredRestartIds = await restartRecoveredOperationIds(sessionId);
    return (await durable.operations(sessionId)).find((operation) => {
      if (!isRuntimeOperationBlocking(operation)) return false;
      if (
        operation.state === "unknown"
        && resetOrdinal !== undefined
        && operation.ordinal < resetOrdinal
      ) {
        return false;
      }
      // A turn stranded `unknown` by a Polyth restart, once its owned backend
      // session was re-verified alive by reconciliation, no longer blocks a
      // new send (it stays `unknown` for fork/rewind/audit).
      if (operation.state === "unknown" && recoveredRestartIds.has(operation.operationId)) {
        return false;
      }
      return true;
    });
  };

  async function abortTurnUnderLock(
    sessionId: string,
    reason: "user" | "tool-timeout",
    toolError: string,
  ): Promise<void> {
    const projection = await store.projection(sessionId);
    if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
    // Stop is an unconditional intent. Whatever the session state — idle,
    // working, failed, or `unknown` after a Polyth restart stranded an
    // in-flight turn — the canonical turn is closed locally and controls never
    // wedge. Backend I/O is best-effort.
    let runtime: AgentRuntime | undefined = sessionRuntime.get(sessionId);
    if (!runtime) {
      try {
        runtime = await ensureWired(sessionId, projection);
      } catch (error) {
        console.error(`[polyth] abort could not wire a runtime for ${sessionId}`, error);
      }
    }
    if (!runtime) {
      await stopLocally(sessionId, toolError);
      return;
    }
    const prepared = await broadcastTail(sessionId, () => durable.prepareOperation({
      sessionId,
      mutationKind: "turn-abort",
      intentEvent: {
        type: "turn/abort-requested",
        data: { reason },
        ignorable: true,
      },
    }));
    const outcome = await runPreparedOperation<Record<string, never>, void>(
      prepared.operation,
      (operationId) => runtime!.abortOperation
        ? runtime!.abortOperation(sessionId, operationId)
        : runtime!.abort(sessionId),
      () => ({}),
      undefined,
      ABORT_AWAIT_MS,
    );
    await stopLocally(sessionId, toolError);
    if (outcome.kind === "unknown") {
      scheduleReconciliation(sessionId, projection, runtime, "abort-outcome-unknown");
    }
  }

  async function stopTimedOutTool(
    sessionId: string,
    callId: string,
  ): Promise<void> {
    await withSessionLock(sessionId, async () => {
      const active = activeToolsFromEvents(await store.events(sessionId)).get(callId);
      if (!active) return;
      const duration = TOOL_EXECUTION_TIMEOUT_MS >= 60_000
        ? `${Math.round(TOOL_EXECUTION_TIMEOUT_MS / 60_000)} minutes`
        : `${TOOL_EXECUTION_TIMEOUT_MS}ms`;
      await abortTurnUnderLock(
        sessionId,
        "tool-timeout",
        `${active.tool} was stopped after exceeding the ${duration} execution safety limit. Retry with a shorter command or an explicit timeout.`,
      );
    });
  }

  /** Called under the existing session lock. Release is idempotent against an
   * exact binding; target creation uses the existing durable mutation journal. */
  const finishHarnessSwitchUnderLock = async (sessionId: string): Promise<SessionProjection> => {
    let projection = await store.projection(sessionId);
    if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
    let transition = projection.harnessTransition;
    if (!transition) return projection;
    if (deps.isShuttingDown?.()) return projection;
    let oldBinding = projection.runtimeBinding;
    if (!oldBinding || !runtimes.forSession) throw Object.assign(new Error("runtime binding unavailable"), { code: "unsupported" });
    const cwd = projection.worktreePath ?? (await projects.get(projection.projectId))?.path ?? process.cwd();
    if (transition.phase === "requested") {
      if (transition.timing === "after-turn" && turnActive(sessionId)) return projection;
      const old = await runtimeFor(projection, cwd);
      if (transition.timing === "stop-now") await abortTurnUnderLock(sessionId, "user", "Stopped to change harness");
      else {
        await ensureWired(sessionId, projection);
        await reconcileSession(sessionId, projection, old, "harness-switch");
        projection = (await store.projection(sessionId))!;
        if (turnActive(sessionId) || projection.status === "working" || projection.status === "waiting") return projection;
        if (await blockingOperation(sessionId)) throw Object.assign(new Error("Reconcile the previous operation before switching"), { code: "outcome-unknown" });
      }
      oldBinding = (await store.projection(sessionId))!.runtimeBinding!;
      if (!old.releaseExecution) throw Object.assign(new Error("This harness cannot yet prove execution has stopped"), { code: "unsupported" });
      if (!oldBinding.backendSessionId) {
        throw Object.assign(new Error("Old execution identity is missing"), { code: "outcome-unknown" });
      }
      const released = await boundedRuntimeAwait(old.releaseExecution({
        canonicalSessionId: sessionId,
        backendSessionId: oldBinding.backendSessionId,
        authorityId: oldBinding.authorityId,
        generation: oldBinding.generation,
        continuity: oldBinding.continuity,
        location: oldBinding.location,
      }, transition.id), transition.id);
      if (released.kind !== "confirmed") throw outcomeError(released);
      if (
        released.value.authorityId !== oldBinding.authorityId
        || released.value.generation !== oldBinding.generation
        || released.value.backendSessionId !== oldBinding.backendSessionId
      ) {
        throw Object.assign(new Error("release proof does not match the old execution incarnation"), { code: "stale-evidence" });
      }
      transition = { ...transition, phase: "released", released: released.value };
      await commitHarnessIntent(sessionId, { harnessTransition: transition }, "harness/execution-released", { transitionId: transition.id, ...released.value });
      unwire(sessionId);
      lastTurnId.delete(sessionId);
      admitting.delete(sessionId);
      runtimes.forgetSession?.(sessionId);
      projection = (await store.projection(sessionId))!;
    }
    if (deps.isShuttingDown?.()) return (await store.projection(sessionId))!;
    // The old execution incarnation is durably released BEFORE a target runtime can exist.
    const target = await runtimeFor(projection, cwd, transition.targetHarnessId);
    const events = await store.events(sessionId);
    const intent = events.findLast((event) => event.type === "harness/native-create-requested" && event.data.transitionId === transition!.id);
    let operation = intent ? (await durable.operations(sessionId)).find((op) => op.ownerEventSeq === intent.seq) : undefined;
    if (!operation) {
      operation = (await broadcastTail(sessionId, () => durable.prepareOperation({
        sessionId,
        mutationKind: "session-reset",
        intentEvent: { type: "harness/native-create-requested", data: { transitionId: transition!.id, harnessId: transition!.targetHarnessId }, ignorable: true },
      }))).operation;
    }
    if (operation.state === "prepared") {
      const request = { projectId: projection.projectId, sessionId, title: projection.title, cwd };
      const outcome = await runPreparedOperation<{ backendSessionId: string }, string>(operation,
        (id) => target.resetSessionOperation ? target.resetSessionOperation(request, id)
          : target.createSessionOperation ? target.createSessionOperation(request, id)
          : target.ensureSession(request),
        (backendSessionId) => ({ backendSessionId }),
        async (result) => {
          await settleOperation(operation!, result.kind === "confirmed" ? { ...result, receipt: result.value.backendSessionId } : result);
        });
      if (outcome.kind !== "confirmed") throw outcomeError(outcome);
      operation = (await durable.operation(operation.operationId))!;
    }
    if (operation.state !== "confirmed" || !operation.receipt) {
      // A lost create response is recovered ONLY by a stable operation receipt.
      const matches = (await target.sessions()).filter((item) => item.operationId === operation!.operationId);
      if (operation.state === "unknown" && matches.length === 1) {
        await broadcastTail(sessionId, () => durable.settleOperation(operation!.operationId, { kind: "confirmed", receipt: matches[0]!.id }));
        operation = (await durable.operation(operation.operationId))!;
      } else throw Object.assign(new Error("Target session creation is unresolved; no request was replayed"), { code: "outcome-unknown" });
    }
    const profile = projection.agentProfileId ? await deps.profiles?.profileGet(projection.agentProfileId) : undefined;
    const agentIntent = profile ? [profile.name, profile.notes].filter(Boolean).join(": ") : projection.runtimeLeg?.agentIntent ?? projection.agent;
      if (transition.phase !== "released") {
        throw Object.assign(new Error("release proof was not persisted"), { code: "stale-evidence" });
      }
      await transitionRuntimeEpochUnderLock(sessionId, target, {
      resetOperationId: operation.operationId,
      reason: "harness-switch",
      authorityDisposition: { kind: "session-execution-released", ...transition.released },
      harness: {
        transitionId: transition.id,
        selection: transition.selection,
        leg: { id: transition.id, harnessId: transition.targetHarnessId, nativeSessionId: operation.receipt!, startedAt: Date.now(), canonicalThroughSeq: 0, bootstrap: "continuity", ...(agentIntent ? { agentIntent } : {}) },
      },
    });
    projection = (await store.projection(sessionId))!;
    return establishFreshRuntimeEpochUnderLock(sessionId, projection, target, operation.operationId);
  };

  const commitHarnessIntent = async (sessionId: string, patch: Partial<SessionProjection>, type: string, data: JsonObject) => {
    if (!store.appendBatch) throw Object.assign(new Error("atomic session publication unavailable"), { code: "unsupported" });
    const projection = await store.projection(sessionId);
    if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
    const events = await store.appendBatch(sessionId, [{ type, data, ignorable: true }], {
      projection: { ...projection, ...patch }, expectedSeq: await store.latestSeq(sessionId),
    });
    events.forEach((event) => broadcast.event(event));
    broadcast.projection((await store.projection(sessionId))!);
  };

  const service: RuntimeEpochSessionService = {
    async switchHarness(sessionId, selection, timing = "after-turn") {
      return withSessionLock(sessionId, async () => {
        let projection = await store.projection(sessionId);
        if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
        if (deps.isShuttingDown?.() && !projection.harnessTransition) {
          throw Object.assign(new Error("harness switching is fenced for shutdown"), {
            code: "shutting_down",
          });
        }
        if (!runtimes.resolve) throw Object.assign(new Error("harness selection unavailable"), { code: "unsupported" });
        if (selection.mode !== "auto" && (selection.mode !== "pinned" || !/^[a-z][a-z0-9-]*$/.test(selection.harnessId))) throw Object.assign(new Error("invalid harness selection"), { code: "invalid-input" });
        if (projection.harnessTransition) {
          const pending = projection.harnessTransition;
          if (JSON.stringify(pending.selection) !== JSON.stringify(selection)) throw Object.assign(new Error("Finish the pending harness switch first"), { code: "conflict" });
          if (timing === "stop-now" && pending.phase === "requested" && pending.timing !== timing) {
            await commitHarnessIntent(sessionId, { harnessTransition: { ...pending, timing } }, "harness/switch-updated", { transitionId: pending.id, timing });
          }
          return finishHarnessSwitchUnderLock(sessionId);
        }
        const cwd = projection.worktreePath ?? (await projects.get(projection.projectId))?.path ?? process.cwd();
        const targetHarnessId = await runtimes.resolve(projection, cwd, selection);
        if (targetHarnessId === projection.resolvedHarnessId) {
          await commitHarnessIntent(sessionId, { harness: selection }, "harness/selection-changed", { selection: { ...selection } });
          return (await store.projection(sessionId))!;
        }
        await clearResume(sessionId, "user");
        await commitHarnessIntent(sessionId, {
          harnessTransition: { id: randomUUID(), selection, targetHarnessId, timing, phase: "requested" },
        }, "harness/switch-requested", { targetHarnessId, timing, selection: { ...selection } });
        return finishHarnessSwitchUnderLock(sessionId);
      });
    },

    async transitionRuntimeEpoch(sessionId, runtime, options) {
      return withSessionLock(sessionId, () =>
        transitionRuntimeEpochUnderLock(sessionId, runtime, options));
    },

    async confirmBorrowedRuntimeEpoch(sessionId) {
      return withSessionLock(sessionId, () =>
        confirmBorrowedRuntimeEpochUnderLock(sessionId));
    },

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
    async canEvictRuntime(runtime, inspectionRuntime, expected, liveStreamSessionIds) {
      if (liveStreamSessionIds.length > 0) {
        return {
          safe: false,
          reason: `runtime has a live stream for ${liveStreamSessionIds[0]}`,
        };
      }
      const sessionIds = [...sessionRuntime]
        .filter(([, wired]) => wired === runtime)
        .map(([sessionId]) => sessionId);
      const activity = async (sessionId: string): Promise<string | undefined> => {
        if (turnActive(sessionId)) return `session ${sessionId} has an active or admitting turn`;
        const operation = await blockingOperation(sessionId);
        if (operation) {
          return `session ${sessionId} has ${operation.state} operation ${operation.operationId}`;
        }
        if (openRequestTotal(await logFacts(sessionId)) > 0) {
          return `session ${sessionId} has an open runtime request`;
        }
        const queue = deps.queue ? await deps.queue.queueList(sessionId) : [];
        if (queue.some((item) => !item.heldForReview)) {
          return `session ${sessionId} has a queued message waiting`;
        }
        return undefined;
      };

      for (const sessionId of sessionIds) {
        const reason = await activity(sessionId);
        if (reason) return { safe: false, reason };
      }
      for (const sessionId of sessionIds) {
        const safety = await service.reconcileForRuntimeRestart(
          sessionId,
          inspectionRuntime,
          expected,
        );
        if (!safety.safe) return safety;
      }
      // Runtime callbacks may append requests or settle operations while the
      // authoritative reads run. Re-check durable and in-memory gates before
      // the pool atomically enters its eviction fence.
      for (const sessionId of sessionIds) {
        const reason = await activity(sessionId);
        if (reason) return { safe: false, reason };
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
      const sessionId = input.id?.trim() || randomUUID();
      if (input.id) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
          throw Object.assign(new Error("session id is invalid"), { code: "invalid-input" });
        }
        if (await store.projection(sessionId)) {
          throw Object.assign(new Error("session already exists"), { code: "conflict" });
        }
      }
      const cwd = input.worktreePath ?? project.path;
      const now = Date.now();
      let rt: AgentRuntime | undefined;
      if (input.agent && !input.model) {
        rt = await runtimeFor({ id: sessionId, projectId: project.id, title: input.title ?? "New session", status: "idle", createdAt: now, updatedAt: now, harness: input.harness }, cwd);
        await requireLaunchModelForAutoAgent(rt, input.agent, input.model);
      }
      // F18: a subagent/fork child starts under the nearest parent's policy —
      // the indicator must be honest from the first projection broadcast.
      const inheritedAutoAccept = input.parentId ? await effectiveAutoAccept(input.parentId) : false;
      const projection: SessionProjection = {
        id: sessionId, projectId: project.id,
        harness: input.harness ?? { mode: "auto" },
        // Tenancy is inherited from the owning project — the one place a
        // session's Space is decided. No caller can pass it in.
        ...(project.spaceId ? { spaceId: project.spaceId } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(inheritedAutoAccept ? { autoAccept: true } : {}),
        title: input.title || "New session",
        ...(input.worktreePath ? {
          worktreePath: input.worktreePath,
          worktreeId: input.worktreePath,
          worktreeState: "ready" as const,
          ...(worktree?.branch ? { branch: worktree.branch } : {}),
        } : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
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
            ...(input.isolation ? { isolation: input.isolation as unknown as JsonObject } : {}),
            ...(input.model ? { model: input.model as unknown as JsonObject } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
          },
          ignorable: true,
        },
      }));
      broadcast.projection(projection);
      try {
        rt ??= await runtimeFor(projection, cwd);
      } catch (error) {
        await broadcastTail(sessionId, () => durable.settleOperation(prepared.operation.operationId, {
          kind: "rejected",
          code: "runtime-unavailable",
          message: "runtime could not be started before session creation",
        }));
        await updateProjection(sessionId, { status: "failed" });
        throw error;
      }
      if (rt.harnessId) await updateProjection(sessionId, { resolvedHarnessId: rt.harnessId });
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
        ...(rt.harnessId ? {
          resolvedHarnessId: rt.harnessId,
          runtimeLeg: { id: randomUUID(), harnessId: rt.harnessId, nativeSessionId: outcome.value.backendSessionId, startedAt: Date.now(), canonicalThroughSeq: 0, bootstrap: "empty" as const },
        } : {}),
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
      let stoppedTurnRecorded = hasPersistedStoppedTurn(await store.events(sessionId));
      const delivery: DeliveryMode = input.delivery ?? "normal";
      // Attachments are prepared (existence-checked, `_inbox/*` materialized
      // into the session's execution root) before any state changes (rewind
      // reset, queueing, admission) so a bad ref can never dirty the durable
      // log.
      if (input.attachments !== undefined) {
        const prepared = await prepareAttachments(proj, input.attachments, sessionId);
        input = { ...input };
        if (prepared) input.attachments = prepared;
        else delete input.attachments;
      }
      if (proj.harnessTransition) {
        proj = await withSessionLock(sessionId, () => finishHarnessSwitchUnderLock(sessionId));
        if (proj.harnessTransition) return enqueueMessage(sessionId, input.text, "queue", "harness-switch", input.attachments);
      }
      if (!proj.harnessTransition && proj.runtimeLeg && proj.status === "idle" && !turnActive(sessionId)
        && !await blockingOperation(sessionId) && proj.runtimeLeg.bootstrap !== "continuity"
        && proj.runtimeLeg.canonicalThroughSeq !== dialogueThrough(await store.events(sessionId))) {
        proj = await withSessionLock(sessionId, async () => {
          await commitHarnessIntent(sessionId, { harnessTransition: { id: randomUUID(), selection: proj!.harness ?? { mode: "auto" }, targetHarnessId: proj!.resolvedHarnessId!, timing: "after-turn", phase: "requested" } }, "harness/switch-requested", { reason: "native history is stale", targetHarnessId: proj!.resolvedHarnessId! });
          return finishHarnessSwitchUnderLock(sessionId);
        });
      }
      const initialBlockingOperation = await blockingOperation(sessionId);
      let recoverEpoch = proj.status === "epoch-pending";
      let replaceUnknown = false;
      let candidateRuntime: AgentRuntime | undefined;
      let candidateCanRebind = false;
      if (
        proj.runtimeBinding
        && (
          proj.status === "unknown"
          || initialBlockingOperation?.state === "prepared"
        )
      ) {
        const project = await projects.get(proj.projectId);
        const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
        candidateRuntime = await runtimeFor(proj, cwd);
        const endpoint = await (candidateRuntime as ReliabilityRuntime).endpoint?.().catch(() => undefined);
        if (endpoint && proj.backendSessionId) {
          const protocol = await (candidateRuntime as ReliabilityRuntime).protocol?.()
            ?? proj.runtimeBinding.protocol;
          candidateCanRebind = canRebindPersistedSession(proj.runtimeBinding, {
            backendSessionId: proj.backendSessionId,
            endpoint,
            protocol,
          });
        }
        recoverEpoch = endpoint?.control.kind === "owned"
          && endpoint.authorityId !== proj.runtimeBinding.authorityId;
      }
      // Warm restart: an in-flight turn interrupted by a Polyth restart leaves
      // its operation `unknown` and forces the session status to `unknown` at
      // boot, even though the SAME owned backend session is still alive. The
      // runtime identity has not changed, so this is a rebind — not an epoch.
      // Reconcile in place: it re-verifies the backend and, when alive, records
      // a `runtime/restart-recovered` marker that lifts the crash-orphaned turn
      // out of the send-admission barrier so this send continues on the same
      // backend session with its full context. If the backend cannot be
      // verified the status stays `unknown` and the conflict below still fires.
      if (
        proj.status === "unknown"
        && !recoverEpoch
        && proj.runtimeBinding
        && candidateRuntime
        && typeof (candidateRuntime as ReliabilityRuntime).reconcile === "function"
      ) {
        await reconcileUnderLock(sessionId, proj, candidateRuntime, "send-after-restart");
        proj = (await store.projection(sessionId)) ?? proj;
        stoppedTurnRecorded = hasPersistedStoppedTurn(await store.events(sessionId));
      }
      // Steer and interrupt are "act on it now" intents. When a Polyth restart
      // left the session `unknown` and reconciliation could not recover the
      // stranded backend turn, do not reject the message: record the durable
      // aborted stop (which lifts the send-admission barrier) and let the text
      // continue immediately as the next turn on the rebound runtime.
      if (
        proj.status === "unknown"
        && !recoverEpoch
        && !stoppedTurnRecorded
        && (input.delivery === "steer" || input.delivery === "interrupt")
      ) {
        await withSessionLock(sessionId, () => stopLocally(sessionId));
        proj = (await store.projection(sessionId)) ?? proj;
        stoppedTurnRecorded = hasPersistedStoppedTurn(await store.events(sessionId));
      }
      if (
        proj.status === "unknown"
        && !recoverEpoch
        && !stoppedTurnRecorded
        && delivery === "normal"
        && candidateRuntime
        && candidateCanRebind
      ) {
        replaceUnknown = true;
      }
      const admissionBarrier = await durable.reconciliation(sessionId);
      // A blocked barrier means the old runtime outcome is still uncertain. Do
      // not resend that turn, but never make the user's new message disappear:
      // durable queueing is the safe send path until reconciliation recovers.
      if (
        deps.queue
        && (delivery === "normal" || delivery === "queue")
        && !recoverEpoch
        && !replaceUnknown
        && admissionBarrier?.state === "blocked"
      ) {
        return enqueueMessage(
          sessionId,
          input.text,
          "queue",
          delivery === "normal" ? "reconciliation-blocked" : undefined,
          input.attachments,
        );
      }
      if (
        proj.status === "reconciling"
        || (proj.status === "unknown" && !recoverEpoch && !stoppedTurnRecorded && !replaceUnknown)
      ) {
        throw Object.assign(new Error(`cannot send while the session is ${proj.status}`), {
          code: "conflict",
        });
      }
      let rt: AgentRuntime;
      if (recoverEpoch || replaceUnknown) {
        ({ projection: proj, runtime: rt } = await withSessionLock(
          sessionId,
          () => recoverFreshRuntimeEpochUnderLock(
            sessionId,
            replaceUnknown ? "unknown" : "epoch",
          ),
        ));
      } else {
        const existingReconciliation = admissionBarrier;
        if (existingReconciliation?.state === "reconciling"
          || existingReconciliation?.state === "blocked"
          || (existingReconciliation?.state === "unknown" && !stoppedTurnRecorded)) {
          throw Object.assign(
            new Error(`cannot send while reconciliation is ${existingReconciliation.state}`),
            { code: "conflict" },
          );
        }
        const existingOperation = await sendAdmissionBlocking(sessionId);
        if (existingOperation) {
          throw Object.assign(
            new Error(`cannot send while operation ${existingOperation.operationId} is ${existingOperation.state}`),
            { code: "conflict" },
          );
        }
        try {
          rt = await ensureWired(sessionId, proj);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "epoch-pending") throw error;
          ({ projection: proj, runtime: rt } = await withSessionLock(
            sessionId,
            () => recoverFreshRuntimeEpochUnderLock(sessionId),
          ));
        }
      }
      proj = (await store.projection(sessionId)) ?? proj;
      stoppedTurnRecorded = hasPersistedStoppedTurn(await store.events(sessionId));
      if (
        proj.status === "reconciling"
        || proj.status === "epoch-pending"
        || (proj.status === "unknown" && !stoppedTurnRecorded)
      ) {
        throw Object.assign(new Error(`cannot send while the session is ${proj.status}`), {
          code: proj.status === "epoch-pending" ? "epoch-pending" : "conflict",
        });
      }
      const readyReconciliation = await durable.reconciliation(sessionId);
      if (readyReconciliation?.state === "reconciling"
        || readyReconciliation?.state === "blocked"
        || (readyReconciliation?.state === "unknown" && !stoppedTurnRecorded)) {
        throw Object.assign(
          new Error(`cannot send while reconciliation is ${readyReconciliation.state}`),
          { code: "conflict" },
        );
      }
      const readyOperation = await sendAdmissionBlocking(sessionId);
      if (readyOperation) {
        throw Object.assign(
          new Error(`cannot send while operation ${readyOperation.operationId} is ${readyOperation.state}`),
          { code: "conflict" },
        );
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
          // The rewind branch replaces the backend session; the durable
          // runtime binding must follow, or the observation fence rejects
          // every event from the new session as stale-evidence forever.
          const rewoundBinding = current.runtimeBinding
            ? { ...current.runtimeBinding, backendSessionId, historyBaseline: "copied" as const }
            : undefined;
          await updateProjection(sessionId, {
            backendSessionId,
            status: "idle",
            ...(rewoundBinding ? { runtimeBinding: rewoundBinding } : {}),
          });
          current = {
            ...current,
            backendSessionId,
            status: "idle",
            ...(rewoundBinding ? { runtimeBinding: rewoundBinding } : {}),
          };
          await appendAndBroadcast(sessionId, "session/rewind-cleared", {
            rewindSeq: rewind.markerSeq,
            replaced: true,
          });
          return current;
        });
      }

      const userSelectedModel = input.model;
      const userSelectedAgent = input.agent;

      // Atomic profile application: resolve to explicit model/agent up front so
      // no intermediate invalid combination can reach the runtime. Explicit
      // per-send model/agent still win over the profile's bundle.
      // UX-COMPOSER-DISC: a string selects a profile, explicit null clears the
      // session's stored profile, and an omitted field inherits it.
      const requestedProfile = input.agentProfileId; // string | null | undefined
      const effectiveProfileId = requestedProfile === undefined
        ? proj.agentProfileId
        : requestedProfile ?? undefined;
      let profileModel: { providerID: string; modelID: string } | undefined;
      let profileAgent: string | undefined;
      if (effectiveProfileId && deps.profiles) {
        const profile = await deps.profiles.profileGet(effectiveProfileId);
        // An explicitly requested profile must exist; a stored (inherited)
        // profile that was deleted degrades to the projection's persisted
        // resolved model/agent rather than failing every later send.
        if (!profile && requestedProfile !== undefined) {
          throw Object.assign(new Error("agent profile not found"), { code: "not-found" });
        }
        if (profile) {
          profileModel = { providerID: profile.providerID, modelID: profile.modelID };
          profileAgent = profile.agent;
          input = {
            ...input,
            // the durable user/message records the actually applied profile id
            agentProfileId: effectiveProfileId,
            model: input.model ?? profileModel,
            ...(input.agent ?? profile.agent ? { agent: input.agent ?? profile.agent } : {}),
          };
        }
      }
      // Persist the explicit selection or clear after resolution succeeded, so
      // an unknown profile id can never be recorded.
      if (requestedProfile !== undefined && (proj.agentProfileId ?? undefined) !== (requestedProfile ?? undefined)) {
        await setProjectionProfile(sessionId, requestedProfile ?? undefined);
      }
      await requireLaunchModelForAutoAgent(rt, input.agent ?? proj.agent, input.model ?? proj.model);
      // Persist only explicit user choices, not turn-local profile defaults.
      const stickModel = userSelectedModel
        ?? (typeof requestedProfile === "string" ? profileModel : undefined);
      const stickAgent = userSelectedAgent
        ?? (typeof requestedProfile === "string" ? profileAgent : undefined);
      if (stickModel || stickAgent) {
        await updateProjection(sessionId, {
          ...(stickModel ? { model: stickModel } : {}),
          ...(stickAgent ? { agent: stickAgent } : {}),
        });
        proj = (await store.projection(sessionId)) ?? proj;
      }
      // Send-time arbitration first: resolution events precede queue/user events.
      if (input.dismissPending) await dismissPendingRequests(sessionId, rt);

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
                  ? rt.steerOperation(sessionId, input.text, operationId, input.model, input.agent)
                  : rt.steer!(sessionId, input.text, input.model, input.agent));
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
          if (input.model || input.agent) {
            await updateProjection(sessionId, {
              ...(input.model ? { model: input.model } : {}),
              ...(input.agent ? { agent: input.agent } : {}),
            });
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
            undefined,
            ABORT_AWAIT_MS,
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
        // Held epoch drafts are review state, not delivery work. They remain
        // editable but do not prevent an explicit new request from continuing
        // on the fresh runtime.
        if (pendingQueue.some((item) => !item.heldForReview)) {
          // A failed/unknown session can never dispatch its queue; silently
          // enqueueing would strand this message, and the steer button (which
          // removes the old item after a "successful" send) would spin an
          // endless re-queue loop. Surface the state instead.
          if (proj.status !== "idle" && proj.status !== "waiting" && proj.status !== "reconciling") {
            throw Object.assign(
              new Error(`session is ${proj.status}; queued messages cannot dispatch until it is idle`),
              { code: "session-not-idle" },
            );
          }
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
      if (queueEditHeld(sessionId, queueId)) {
        throw Object.assign(new Error("queued message is already being edited"), { code: "conflict" });
      }
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
    async queueSendNow(sessionId, queueId, text) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const nextText = text.trim();
      if (!nextText) throw Object.assign(new Error("queued message text is required"), { code: "invalid-input" });
      const item = (await deps.queue.queueList(sessionId)).find((candidate) => candidate.id === queueId);
      if (!item) throw Object.assign(new Error("queue item not found"), { code: "not-found" });
      await deps.queue.queueRemove(sessionId, queueId);
      await appendAndBroadcast(sessionId, "queue/removed", { queueId }, { ignorable: true });
      releaseQueueEditHold(sessionId, queueId);
      return service.send(sessionId, {
        text: nextText,
        ...(item.attachments?.length ? { attachments: item.attachments } : {}),
        delivery: "interrupt",
        dismissPending: true,
      });
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
      await withSessionLock(sessionId, () =>
        abortTurnUnderLock(sessionId, "user", "Command stopped by user."));
    },

    async cancelResume(sessionId) {
      await withSessionLock(sessionId, () => clearResume(sessionId, "user"));
    },

    async resumeNow(sessionId, model): Promise<SendResult> {
      const plan = await withSessionLock(sessionId, async (): Promise<
        { text: string; attachments?: AttachmentRef[]; model?: ModelRef }
      > => {
        const proj = await store.projection(sessionId);
        if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
        if (!proj.resume) throw Object.assign(new Error("no pending resume"), { code: "no-resume" });
        const last = lastUserMessage(await store.events(sessionId));
        if (!last || last.seq !== proj.resume.userMessageSeq || !last.text.trim()) {
          await clearResume(sessionId, "user");
          throw Object.assign(new Error("resume target is stale"), { code: "no-resume" });
        }
        await clearResume(sessionId, model ? "model-switch" : "resumed");
        return {
          text: last.text,
          ...(last.attachments
            ? { attachments: last.attachments as unknown as AttachmentRef[] }
            : {}),
          ...(model ?? proj.model ? { model: model ?? proj.model } : {}),
        };
      });
      return service.send(sessionId, { ...plan, autoResume: true });
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
          // Repeated clicks (or two browser tabs) can enqueue the same rewind
          // before the first marker reaches the client. Reuse that committed
          // marker instead of turning an already-successful action into a
          // misleading conflict.
          if (eff.rewind.atSeq === atSeq) {
            const existing = events.find((ev) =>
              ev.seq === eff.rewind!.markerSeq && ev.type === "session/rewound");
            if (existing) return existing;
          }
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
          ? await runtimeFor(proj, cwd)
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
        let binding: RuntimeSessionBinding | undefined;
        let upstreamDeletionAllowed = true;
        if (rt) {
          try {
            binding = await runtimeBinding(rt, proj, cwd);
          } catch (error) {
            if ((error as { code?: string }).code !== "binding-mismatch") throw error;
            // The runtime may now identify a different backend. Delete this
            // canonical record, but never send its old backend ID there.
            upstreamDeletionAllowed = false;
          }
        }
        const deletionBinding = binding ?? (proj.runtimeBinding && proj.backendSessionId
          ? {
              canonicalSessionId: sessionId,
              backendSessionId: proj.backendSessionId,
              authorityId: proj.runtimeBinding.authorityId,
              generation: proj.runtimeBinding.generation,
              location: proj.runtimeBinding.location,
            }
          : proj.backendSessionId
            ? {
                canonicalSessionId: sessionId,
                backendSessionId: proj.backendSessionId,
                authorityId: `legacy:${proj.projectId}:${cwd}`,
                generation: 0,
                location: { directory: cwd },
              }
            : undefined);
        const deletion = await durable.prepareSessionDeletion({
          binding: {
            canonicalSessionId: sessionId,
            authorityId: deletionBinding?.authorityId ?? `legacy:${proj.projectId}:${cwd}`,
            generation: deletionBinding?.generation ?? 0,
            location: deletionBinding?.location ?? { directory: cwd },
            // An unknown create has no protocol-proven backend id. Retaining
            // the canonical id still prevents canonical resurrection; Agent F
            // must supply operation lookup to bind an unknown backend child.
            backendSessionId: deletionBinding?.backendSessionId ?? `unknown:${sessionId}`,
          },
        });
        factsCache.delete(sessionId);
        await claimOperation(deletion.operation);
        let outcome: MutationOutcome<Record<string, never>>;
        if (
          !upstreamDeletionAllowed
          || (!rt?.discardSession && !rt?.discardSessionOperation)
          || !proj.backendSessionId
        ) {
          outcome = {
            kind: "unknown",
            operationId: deletion.operation.operationId,
            message: upstreamDeletionAllowed
              ? "runtime cannot prove upstream session deletion"
              : "runtime identity changed; upstream session deletion was not attempted",
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
        // A manual rename settles the naming intent: a later (or delayed)
        // OpenCode title event must not overwrite the user's explicit choice.
        autoTitleRequested.delete(sessionId);
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
      const merged = { ...current, ...next };
      if (patch.folderId === null) delete merged.folderId;
      if (patch.pinned === null) delete merged.pinned;
      await store.upsertProjection(merged);
      broadcast.projection(merged);
    },

    async markWorktreeMissing(projectId, worktreePath) {
      // TODO(attachment-cleanup-ownership): _inbox staged copies are
      // session-lifetime; remove on worktree deletion (this is the hook).
      const missingPath = resolve(worktreePath);
      for (const projection of await store.projections(projectId)) {
        if (!projection.worktreePath || resolve(projection.worktreePath) !== missingPath) continue;
        const next: SessionProjection = {
          ...projection,
          worktreeState: "missing",
          updatedAt: Date.now(),
          ...(projection.isolation
            ? { isolation: { ...projection.isolation, state: "missing" as const } }
            : {}),
        };
        await store.upsertProjection(next);
        broadcast.projection(next);
      }
    },

    async patchIsolation(sessionId, isolation) {
      const next = await applyProjection(sessionId, (current) => {
        const patched: SessionProjection = { ...current, updatedAt: Date.now() };
        if (isolation) patched.isolation = isolation;
        else delete patched.isolation;
        return patched;
      });
      if (!next) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return next;
    },

    async rebindWorkspace(sessionId, input) {
      return withSessionLock(sessionId, async () => {
        const projection = await store.projection(sessionId);
        if (!projection) throw Object.assign(new Error("session not found"), { code: "not-found" });
        if (projection.status === "archived") {
          throw Object.assign(new Error("unavailable while the session is archived"), { code: "conflict" });
        }
        if (turnActive(sessionId) || isolationBlocksUserMutation(projection.status)) {
          throw Object.assign(new Error("cannot rebind a running session"), { code: "conflict" });
        }
        const project = await projects.get(projection.projectId);
        const previousCwd = projection.worktreePath ?? project?.path;
        const destCwd = input.worktreePath === null
          ? (project?.path ?? previousCwd)
          : typeof input.worktreePath === "string"
            ? input.worktreePath
            : previousCwd;
        const alreadyAtDest = !!previousCwd && !!destCwd && resolve(previousCwd) === resolve(destCwd);
        if (!alreadyAtDest && previousCwd) {
          if (deps.closeWorkspaceProcesses) {
            await deps.closeWorkspaceProcesses(previousCwd);
          }
          unwire(sessionId);
          if (deps.releaseRuntime) {
            await deps.releaseRuntime(projection.projectId, previousCwd);
          }
        }
        const next = await applyProjection(sessionId, (current) => {
          const patched: SessionProjection = {
            ...current,
            updatedAt: Date.now(),
            ...(input.branch !== undefined
              ? (input.branch ? { branch: input.branch } : { branch: undefined })
              : {}),
          };
          if (input.worktreePath === null) {
            delete patched.worktreePath;
            delete patched.worktreeId;
            delete patched.worktreeState;
          } else if (typeof input.worktreePath === "string") {
            patched.worktreePath = input.worktreePath;
            patched.worktreeId = input.worktreePath;
            patched.worktreeState = "ready";
          }
          if (input.isolation === null) delete patched.isolation;
          else if (input.isolation) patched.isolation = input.isolation;
          if (input.branch === null) delete patched.branch;
          return patched;
        });
        if (!next) throw Object.assign(new Error("session not found"), { code: "not-found" });
        const cwd = next.worktreePath ?? project?.path ?? process.cwd();
        const runtime = await runtimeFor(next, cwd);
        if (next.runtimeBinding && next.backendSessionId && (runtime.resetSessionOperation || runtime.resetSession)) {
          try {
            const endpoint = await (runtime as ReliabilityRuntime).endpoint?.();
            if (endpoint) {
              const reset = await prepareFreshEpochResetUnderLock(sessionId, next, runtime, endpoint, cwd);
              await transitionRuntimeEpochUnderLock(sessionId, runtime, {
                resetOperationId: reset.operationId,
                reason: "session workspace rebound; restoring confirmed canonical history",
                authorityDisposition: { kind: "unknown-session-replaced" },
              });
              const rebound = (await store.projection(sessionId))!;
              await establishFreshRuntimeEpochUnderLock(sessionId, rebound, runtime, reset.operationId);
            }
          } catch (error) {
            console.error(`[polyth] isolation session-rebind epoch failed for ${sessionId}`, error);
            throw error;
          }
        }
        return (await store.projection(sessionId)) ?? next;
      });
    },

    async markRead(sessionId, seq) {
      if (!store.setReadCursor) return;
      const advanced = await store.setReadCursor(sessionId, seq);
      if (!advanced) return;
      const projection = await store.projection(sessionId);
      if (!projection) return;
      const counts = await deps.org?.attentionFor([sessionId]).catch(() => undefined);
      const attention = counts?.[sessionId];
      broadcast.projection(attention ? { ...projection, attention } : projection);
    },

    async list(projectId) {
      const projections = await store.projections(projectId);
      const settled = await Promise.all(projections.map(async (projection) => {
        if (
          !projection.parentId
          || (projection.status !== "working"
            && projection.status !== "reconciling"
            && projection.status !== "unknown")
        ) return projection;
        await settleDelegatedChild(projection.id);
        return (await store.projection(projection.id)) ?? projection;
      }));
      if (!deps.org || settled.length === 0) return settled;
      // Attention badges derive from durable events on every read (WP5).
      const counts = await deps.org.attentionFor(settled.map((p) => p.id)).catch(() => ({} as Record<string, { questions: number; permissions: number; unread: number }>));
      return settled.map((p) => {
        const c = counts[p.id];
        return c ? { ...p, attention: { questions: c.questions, permissions: c.permissions, unread: c.unread } } : p;
      });
    },
    async sync(projectId) {
      // F14: bulk adopt-everything, kept for programmatic use. The web now
      // browses /api/agent/backend-sessions and imports selectively.
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
          ...(project.spaceId ? { spaceId: project.spaceId } : {}),
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
      let p = await store.projection(sessionId);
      if (!p) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (
        p.parentId
        && (p.status === "working" || p.status === "reconciling" || p.status === "unknown")
      ) {
        await settleDelegatedChild(sessionId);
        p = (await store.projection(sessionId)) ?? p;
      }
      return p;
    },
    async events(sessionId, afterSeq, page) {
      const interactiveRead = afterSeq === 0
        ? page?.prefetch !== true
        : page?.prefetch === false;
      if (interactiveRead && !sessionRuntime.has(sessionId)) {
        const projection = await store.projection(sessionId);
        if (projection && (projection.backendSessionId || projection.status === "unknown")) {
          try {
            await ensureWired(sessionId, projection);
          } catch (error) {
            if ((error as { code?: unknown }).code !== "epoch-pending") {
              console.warn(`[polyth] failed to materialize runtime session ${sessionId}`, error);
            }
          }
        }
      }
      // Restart recovery: opening an idle session with persisted queued
      // messages resumes FIFO dispatch (never into an active stream).
      if (interactiveRead && deps.queue && !turnActive(sessionId)) {
        void deps.queue.queueList(sessionId).then((q) => {
          if (q.length > 0) return dispatchQueue(sessionId);
          return undefined;
        }).catch(() => {});
      }
      // Lazy history import is only for sessions adopted from OpenCode.
      // OpenCode's current history API is unpaged; faking a partial import
      // would break durable chronological sequencing, so that first import
      // remains deferred here until the backend offers a real page boundary.
      // Passive pointer prefetches never enter this path.
      if (interactiveRead) {
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
      const events = await store.events(sessionId);
      const operations = await durable.operations(sessionId);
      const queue = deps.queue ? await deps.queue.queueList(sessionId) : [];
      const heldForReview = queue.filter((item) => item.heldForReview).length;
      const attached = sessionRuntime.get(sessionId);
      const endpoint = attached ? attachedEndpoint.get(attached) : undefined;
      const plan = await runtimeEpochRecoveryPlan(sessionId, events, true, true);
      const restored = events.some((event) => {
        if (event.type !== "user/message") return false;
        const metadata = (event.data as {
          runtimeEpochRecovery?: { markerSeq?: unknown; epoch?: unknown };
        }).runtimeEpochRecovery;
        return Number(metadata?.markerSeq) === plan?.markerSeq
          && Number(metadata?.epoch) === plan?.epoch;
      });
      const observability = sessionDebugObservability({
        events,
        operations,
        heldForReview,
        ...(projection.runtimeBinding ? { binding: projection.runtimeBinding } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(plan ? { recoveryPlan: plan, recoveryRestored: restored } : {}),
      });
      return {
        status: projection.status,
        eventCount: facts.eventCount,
        latestSeq: facts.lastEvent?.seq ?? 0,
        ...(facts.lastEvent ? { lastEvent: { ...facts.lastEvent } } : {}),
        runtime: {
          attached: Boolean(attached),
          activeTurn: turnActive(sessionId),
          admissionPending: admitting.has(sessionId),
          ...(turnId ? { turnId } : {}),
          ...(projection.backendSessionId ? { backendSessionId: projection.backendSessionId } : {}),
          ...(projection.worktreePath ? { worktreePath: projection.worktreePath } : {}),
        },
        queue,
        pending: {
          permissions: [...facts.openPermissions.keys()],
          questions: [...facts.openQuestions.keys()],
          secrets: [...facts.openSecrets.keys()],
        },
        recentErrors: [...facts.recentErrors],
        ...observability,
      };
    },

    async replyPermission(sessionId, requestId, reply, scope) {
      await withSessionLock(sessionId, async () => {
        const forwarded = (await logFacts(sessionId)).openPermissions.get(requestId)?.data as
          { sourceSessionId?: unknown } | undefined;
        const target = typeof forwarded?.sourceSessionId === "string" ? forwarded.sourceSessionId : sessionId;
        await replyPermissionCore(target, requestId, reply, scope);
        if (target !== sessionId) await settleAfterLastRequest(sessionId);
      });
    },

    async replyQuestion(sessionId, requestId, answers) {
      await withSessionLock(sessionId, async () => {
        const forwarded = (await logFacts(sessionId)).openQuestions.get(requestId)?.data as
          { sourceSessionId?: unknown } | undefined;
        const target = typeof forwarded?.sourceSessionId === "string" ? forwarded.sourceSessionId : sessionId;
        await replyQuestionCore(target, requestId, answers);
        if (target !== sessionId) await settleAfterLastRequest(sessionId);
      });
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
        await settleAfterLastRequest(sessionId);
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

    async saveDraft(sessionId, text) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const now = Date.now();
      // Last-write-wins: only overwrite if incoming timestamp is newer (or absent).
      if (proj.draftUpdatedAt && proj.draftUpdatedAt > now) return;
      await applyProjection(sessionId, (current) => ({
        ...current,
        draft: text || undefined,
        draftUpdatedAt: text ? now : undefined,
        updatedAt: now,
      }));
    },
  };

  const rehydrateToolWatchdogs = async (): Promise<void> => {
    for (const row of await store.projections()) {
      if (row.status === "archived" || row.status === "idle") continue;
      for (const [callId, active] of activeToolsFromEvents(await store.events(row.id))) {
        armToolWatchdog(row.id, callId, active.startedAt);
      }
    }
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

  // Re-arm rate-limit resume timers for sessions that were waiting when the
  // server last stopped. Fire-and-forget: timers are unref'd and a past
  // resumeAt simply resends on the next tick.
  void rehydrateResume().catch(
    (err: unknown) => console.error("[polyth] rate-limit resume rehydrate failed", err),
  );
  void rehydrateToolWatchdogs().catch(
    (err: unknown) => console.error("[polyth] tool watchdog rehydrate failed", err),
  );

  return service;
}
