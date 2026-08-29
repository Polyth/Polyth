// Polyth public contracts. Type-only. No implementation imports allowed here.
// Erasable TS only (no enums/namespaces) — Node strips types at runtime.
import type { IncomingMessage, ServerResponse } from "node:http";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface Disposable { dispose(): void | Promise<void> }

/** Server route contribution shared by trusted server plugins and the gateway. */
export type RouteHandler = (request: RouteRequest) => Promise<boolean>;
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  body(): Promise<Record<string, unknown>>;
  json(code: number, body: unknown): void;
}

// ---------------------------------------------------------------- capabilities

export interface CapabilityKey<T> {
  readonly id: string;      // e.g. "polyth.sessionPersistence"
  readonly version: string; // semver range supported by consumer
  // phantom: T is carried at type level only
  readonly __t?: T;
}
export const cap = <T>(id: string, version = "1"): CapabilityKey<T> => ({ id, version });

// ---------------------------------------------------------------- session events

export interface SessionEvent<T extends JsonObject = JsonObject> {
  id: string;              // uuid
  sessionId: string;
  seq: number;             // monotonic per session, transactionally allocated
  time: number;            // ms epoch
  type: string;            // "assistant/chunk" etc.
  data: T;
  ignorable?: boolean;     // not part of model history derivation
  surfaceOp?: "append" | "replace";
  sourceEventSeqs?: number[];
  producerPlugin?: string;
  v: 1;
}

/** Protocol-neutral durable events emitted when mutation state becomes
 * externally observable. These events are ignorable canonical facts; the
 * operations table remains authoritative for execution state. */
export const CANONICAL_MUTATION_EVENT_TYPES = [
  "mutation/prepared",
  "mutation/claimed",
  "mutation/confirmed",
  "mutation/rejected",
  "mutation/uncertainty-recorded",
  "mutation/nonapplication-confirmed",
  "mutation/fenced",
] as const;
export type CanonicalMutationEventType = (typeof CANONICAL_MUTATION_EVENT_TYPES)[number];

export const CANONICAL_RECONCILIATION_EVENT_TYPES = [
  "reconciliation/started",
  "reconciliation/completed",
  "reconciliation/blocked",
] as const;
export type CanonicalReconciliationEventType = (typeof CANONICAL_RECONCILIATION_EVENT_TYPES)[number];

// Data payloads for the M1 vocabulary (all must stay JSON-serializable)
export interface CompactionRecoveryMetadata {
  compactionSeq: number;
  goalRestored?: boolean;
  pinnedSourceSeqs?: number[];
}
export interface RuntimeEpochRecoveryMetadata {
  epoch: number;
  markerSeq: number;
  goalRestored?: boolean;
  pinnedSourceSeqs?: number[];
}
export interface UserMessageData {
  text: string;
  attachments?: AttachmentRef[];
  /** Agent handoff prompt shown as a semantic GitHub card, not a user bubble. */
  githubConflictResolution?: boolean;
  /** Model-visible recovery instructions kept separate from the visible bubble. */
  recoveryContext?: string;
  /** Durable dedup key proving this compaction was handled by this turn. */
  compactionRecovery?: CompactionRecoveryMetadata;
  /** Durable proof that a confirmed turn restored one fresh runtime epoch. */
  runtimeEpochRecovery?: RuntimeEpochRecoveryMetadata;
}
export interface GithubConflictResolutionStartedData {
  prNumber: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}
export interface AssistantChunkData { partId: string; text: string }
export interface AssistantReasoningChunkData { partId: string; text: string }
export interface AssistantMessageData { partId: string; text: string; reasoning?: string; tokens?: TokenUsage; cost?: number }
export interface ToolCallData { callId: string; tool: string; input: JsonObject; partId?: string }
export interface ToolResultData { callId: string; tool: string; output: string; title?: string; metadata?: JsonObject; attachments?: AttachmentRef[]; input?: JsonObject }
export interface ToolErrorData { callId: string; tool: string; error: string }
export interface PermissionPreview { title: string; lines: string[]; risk?: "low" | "medium" | "high" }
export type PermissionScope = "once" | "session" | "project";
export interface PermissionRequestData {
  requestId: string; permission: string; patterns: string[]; metadata?: JsonObject; tool?: string;
  /** Server-generated, secret-redacted preview (optional; old events lack it). */
  preview?: PermissionPreview;
  allowedScopes?: PermissionScope[];
}
export interface PermissionResolvedData { requestId: string; reply: "once" | "always" | "reject"; scope?: "session" | "project" }
export interface QuestionOption { value: string; label: string; description?: string }
export interface QuestionItem {
  id: string;
  title?: string;
  prompt: string;
  type: "single" | "multi" | "text";
  options?: QuestionOption[];
  required?: boolean;
  allowOther?: boolean;
}
export interface QuestionRequestData { requestId: string; questions: JsonObject[] }
export interface SecretRequestData {
  requestId: string;
  handle: string;
  label: string;
  purpose?: string;
  kind?: SecureSafeKind;
  existing?: boolean;
}
export interface SecretResolvedData {
  requestId: string;
  action: "saved" | "dismissed";
  handle?: string;
}
export interface RuntimeEpochIdentity {
  authorityId: string;
  generation: number;
  epoch: number;
}
export interface RuntimeEpochReplacedData {
  old: RuntimeEpochIdentity;
  new: RuntimeEpochIdentity;
  reason: string;
}
export interface RuntimeRequestExpiredData {
  requestId: string;
  epoch: number;
  reason: "runtime-epoch-replaced";
}
export interface TurnStartedData { turnId: string; model?: ModelRef; agent?: string }
export interface TurnStoppedData { turnId: string; reason: "completed" | "aborted" | "error"; error?: string }
export interface TokenUsage { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
export interface UsageRecordedData { model: ModelRef; tokens: TokenUsage; cost?: number }
export interface GoalAttachedData { objective: string; budgetTokens?: number; maxContinuations?: number }
export interface GoalAuditData { verdict: "keep" | "done" | "stuck"; consecutiveStuck: number; note?: string }
export interface ContextPinnedData { sourceEventSeq: number }
export interface ContextUnpinnedData { sourceEventSeq: number }
export interface SessionCompactedData {
  backendEventId?: string;
}
export interface CompactionPartRecordedData {
  partId: string;
  messageId?: string;
  auto?: boolean;
}
export interface GoalContextRestoredData {
  compactionSeq: number;
  sourceMessageSeq: number;
}
export interface ContextRestoredData {
  compactionSeq: number;
  sourceMessageSeq: number;
  pinnedSourceSeqs: number[];
}
export interface SessionRewoundData {
  /** The reverted user/message seq. That message and its following tail are hidden. */
  atSeq: number;
  restoredText?: string;
}
export interface SessionRewindClearedData {
  /** Seq of the session/rewound marker being resolved. */
  rewindSeq: number;
  /** True when a new send replaces the hidden tail; false/absent means redo. */
  replaced?: boolean;
}

// ---------------------------------------------------------------- fork lineage (UX-MSG-ACTIONS)

/** Editable composer seed carried by a per-message fork marker. Never
 *  model-visible: the target prompt is excluded from the child history and
 *  exists only as this draft until the user sends it. */
export interface ForkDraft {
  text: string;
  attachments?: AttachmentRef[];
}

/** `session/forked` marker payload (ignorable). Legacy whole-session markers
 *  carry only `fromSessionId` (+ optional `atSeq`); per-message forks add the
 *  excluded prompt seq, the copied-through seq, and the draft seed. */
export interface SessionForkedData {
  fromSessionId: string;
  /** Legacy whole-session fork bound: events copied up to and including atSeq. */
  atSeq?: number;
  /** Per-message fork: the excluded source `user/message` seq. */
  sourceAtSeq?: number;
  /** Highest source seq copied into the child prefix (0 = empty prefix). */
  copiedThroughSeq?: number;
  draft?: ForkDraft;
}

/** Typed fork response: the child ref plus the lineage/draft the client
 *  persists before navigating to the child. */
export interface ForkResult extends SessionRef {
  fromSessionId?: string;
  sourceAtSeq?: number;
  draft?: ForkDraft;
}

// ---------------------------------------------------------------- M3 workflows: multirun / fusion / walkthrough

export type MultirunRunStatus = "pending" | "running" | "completed" | "failed";
export interface MultirunRunDto {
  id: string; model?: ModelRef; agent?: string; status: MultirunRunStatus;
  output: string; tokens?: TokenUsage; cost?: number; error?: string;
  /** Wall-clock lifecycle supplied by the runner when available. */
  startedAt?: number; finishedAt?: number;
}
export interface MultirunDto { id: string; prompt: string; runs: MultirunRunDto[]; pickedRunId?: string }

export interface MultirunStartedData { multirunId: string; prompt: string; runs: Array<{ runId: string; model?: ModelRef; agent?: string }> }
export interface MultirunRunProgressData {
  multirunId: string; runId: string; status: MultirunRunStatus; output: string;
  tokens?: TokenUsage; cost?: number; error?: string;
  startedAt?: number; finishedAt?: number;
}
export interface MultirunCompletedData { multirunId: string }
export interface MultirunPickedData { multirunId: string; runId: string }

export type WorkflowPipeMode = "direct" | "ancestors";
export type WorkflowPermissionPolicy = "auto" | "manual";
export type WorkflowNodeStatus = "queued" | "running" | "done" | "error" | "skipped" | "stopped";
export type WorkflowRunStatus = "running" | "done" | "error" | "stopped";

export interface WorkflowNodeDto {
  id: string;
  role: string;
  prompt: string;
  model?: ModelRef;
  agent?: string;
  position?: { x: number; y: number };
}

export interface WorkflowEdgeDto {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowRunOptionsDto {
  pipe?: WorkflowPipeMode;
  permissions?: WorkflowPermissionPolicy;
  maxParallel?: number;
  nodeTimeoutMs?: number;
}

export interface WorkflowDto {
  id: string;
  projectId: string;
  name: string;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  defaults?: WorkflowRunOptionsDto;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunNodeDto {
  id: string;
  role: string;
  status: WorkflowNodeStatus;
  sessionId?: string;
  model?: ModelRef;
  agent?: string;
  activity?: string;
  prompt?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRunDto {
  id: string;
  workflowId: string;
  /** Owning project and parent log are included for project-wide monitoring. */
  projectId?: string;
  parentSessionId?: string;
  name: string;
  input: string;
  /** Effective options make an honest full-run retry possible after navigation. */
  options?: Required<WorkflowRunOptionsDto>;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  layers: string[][];
  nodes: WorkflowRunNodeDto[];
}

export interface WorkflowRunStartedData {
  runId: string;
  workflowId: string;
  projectId?: string;
  parentSessionId?: string;
  name: string;
  input: string;
  options?: Required<WorkflowRunOptionsDto>;
  startedAt: number;
  layers: string[][];
  nodes: WorkflowRunNodeDto[];
}

export interface WorkflowNodeProgressData {
  runId: string;
  nodeId: string;
  node: WorkflowRunNodeDto;
}

export interface WorkflowRunCompletedData {
  runId: string;
  status: WorkflowRunStatus;
  finishedAt: number;
}

export interface FusionWeightDto { model: string; weight: number }
export interface FusionSourceDto { model: string; answer: string }
export type FusionStatus = "running" | "completed" | "failed";
export interface FusionDto {
  id: string; answer: string; weights: FusionWeightDto[]; disagreements: string[];
  sources: FusionSourceDto[]; status: FusionStatus; error?: string;
}

export interface FusionStartedData { fusionId: string; prompt: string; models: string[] }
export interface FusionCompletedData {
  fusionId: string; status: FusionStatus; answer: string;
  weights: FusionWeightDto[]; disagreements: string[];
  sources: FusionSourceDto[]; error?: string;
}

export type WalkthroughStepStatus = "pending" | "approved" | "rejected";
export interface WalkthroughStepDto { file: string; explanation: string; diff: string; status: WalkthroughStepStatus }

export interface WalkthroughStepApprovedData { stepIndex: number; file: string }
export interface WalkthroughStepRejectedData { stepIndex: number; file: string }

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Display/download URL. Required (http/https) for kind "url"; for project
   *  files it is the sanitized raw endpoint and purely presentational. */
  url?: string;
  /** Attachment class; absent means "file" (backward compatible). */
  kind?: "file" | "image" | "range" | "url";
  /** Project-relative path for file/image/range attachments. */
  path?: string;
  /** 1-based inclusive line range (kind "range" only). */
  range?: [number, number];
}
export interface ModelRef { providerID: string; modelID: string; variant?: string }

// Model-visible derivation: these types feed deriveMessages()
export const MODEL_VISIBLE_TYPES = [
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
  "tool/error",
  "question/asked",
  "question/answered",
] as const;

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  parts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "file"; name: string; mime: string; path?: string; url?: string; range?: [number, number] }
    | { type: "tool-call"; callId: string; tool: string; input: JsonObject }
    | { type: "tool-result"; callId: string; tool: string; output: string; isError?: boolean }
  >;
}

// ---------------------------------------------------------------- session service

export interface CreateSessionInput {
  projectId: string;
  title?: string;
  model?: ModelRef;
  agent?: string;
  parentId?: string;      // subagent / fork parent
  worktreeId?: string;
  /** absolute path of a git worktree; when set the session's runtime uses it as cwd */
  worktreePath?: string;
  /** Existing OpenCode session to adopt rather than create. Internal adapter seam. */
  backendSessionId?: string;
}
export interface SessionRef { id: string }
export interface TurnRef { turnId: string }
export interface UserTurnInput {
  text: string;
  /** Keep this model-visible prompt out of ordinary user chat bubbles. */
  githubConflictResolution?: boolean;
  /** Accept OpenCode's generated title for this first prompt when the session
   *  still has a placeholder title. The client owns the user preference; the
   *  server owns the append + projection update. */
  autoTitle?: boolean;
  attachments?: AttachmentRef[];
  model?: ModelRef;
  agent?: string;
  /** Active-turn delivery admission; defaults to "normal". */
  delivery?: DeliveryMode;
  /** Atomically reject open questions / deny open permissions of this session before admission. */
  dismissPending?: boolean;
  /** Resolve model/agent/options through a stored agent profile at send time.
   *  A string selects a profile, `null` explicitly clears the session's
   *  stored profile, and an omitted field inherits it. The three are never
   *  conflated (UX-COMPOSER-DISC). */
  agentProfileId?: string | null;
}

export type SessionStatus =
  | "idle"
  | "working"
  | "waiting"
  | "reconciling"
  | "epoch-pending"
  | "unknown"
  | "finished"
  | "failed"
  | "archived";

/** Derived unresolved-request counters; always computed from durable events. */
export interface SessionAttention {
  questions: number;
  permissions: number;
  unread: number;
  goalStatus?: string;
}

export type BackgroundWorkKind = "multirun" | "fusion";
export interface BackgroundWorkState {
  multirun?: number;
  fusion?: number;
  /** Earliest still-active background workflow. */
  startedAt?: number;
  /** Latest terminal workflow, used for replay-deduped completion notices. */
  lastResult?: {
    id: string;
    kind: BackgroundWorkKind;
    status: "completed" | "failed";
    at: number;
  };
}

export type WorktreeState = "ready" | "bootstrapping" | "busy" | "missing";

/** F9 idle assist: recap + one suggested follow-up, keyed to the log tail.
 *  Projection-only — it is never model-visible unless the user sends it. */
export interface SessionAssist {
  recap: string;
  suggestion: string;
  /** Log seq the assist was generated against; any newer event makes it stale. */
  atSeq: number;
  generatedAt: number;
}

export interface SessionProjection {
  id: string; projectId: string; parentId?: string;
  title: string; status: SessionStatus;
  model?: ModelRef; agent?: string;
  createdAt: number; updatedAt: number;
  lastTurnAt?: number; tokenTotals?: TokenUsage; costTotal?: number;
  worktreePath?: string;
  backendSessionId?: string;
  /** Durable identity of the endpoint generation that owns backendSessionId.
   * A generation-only binding may not be silently carried to a replacement. */
  runtimeBinding?: PersistedRuntimeBinding;
  /** Presentation-only endpoint control for epoch-pending chrome.
   * Not an identity field and not stored on PersistedRuntimeBinding. */
  runtimeControl?: "owned" | "borrowed";
  /** Highest canonical event sequence whose runtime-derived projection effects
   * were applied. Makes post-ingestion projection repair idempotent. */
  runtimeObservationSeq?: number;
  goal?: { objective: string; status: string };
  // -- optional parity metadata (backward compatible: absent on old records) --
  attention?: SessionAttention;
  labelIds?: string[];
  folderId?: string;
  branch?: string;
  worktreeId?: string;
  worktreeState?: WorktreeState;
  agentProfileId?: string;
  /** Organization metadata, never written to the session event log. */
  pinned?: { position: number };
  /** Durable navigation/notification state for workflows that outlive a view. */
  backgroundWork?: BackgroundWorkState;
  /** Small-model idle assist (F9); stale once the log grows past atSeq. */
  assist?: SessionAssist;
  /** F18: effective auto-accept policy (own setting or nearest parent's) —
   *  drives the loud header indicator. Never a global default. */
  autoAccept?: boolean;
}

/** F18: per-session auto-accept policy. "inherit" (the default) walks to the
 *  nearest ancestor with an explicit setting; the root default is off.
 *  "off" on a child is the explicit opt-out from an inherited "on". */
export type AutoAcceptSetting = "on" | "off" | "inherit";

export interface AutoAcceptDto {
  setting: AutoAcceptSetting;
  effective: boolean;
}

/** Persisted binding snapshot for session debug. Identity hashes only — no
 * prompts, tokens, or provider credentials. */
export interface SessionDebugRuntimeBindingDto {
  authorityId: string;
  generation: number;
  epoch: number;
  continuity: "verified" | "generation-only";
  protocol: "legacy" | "v2";
  location: RuntimeLocation;
  historyBaseline?: "empty" | "copied" | "import";
}

/** Attached-endpoint snapshot for session debug. Never includes URL,
 * authentication values, or instance tokens. */
export interface SessionDebugEndpointDto {
  authorityId: string;
  generation: number;
  control: { kind: "owned" | "borrowed"; source?: "shared" | "external" };
}

export interface SessionDebugEpochReplacedDto {
  reason: string;
  old: RuntimeEpochIdentity;
  new: RuntimeEpochIdentity;
  seq: number;
}

/** Computed recovery-plan stats. Never includes recoveryContext text. */
export interface SessionDebugRecoveryPlanDto {
  epoch: number;
  markerSeq: number;
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
  goalRestored: boolean;
  restored: boolean;
}

/** Durable + live diagnostics exposed to authenticated agent clients. Secret
 * values are never present: pending requests contain opaque ids only. */
export interface SessionDebugDto {
  status: SessionStatus;
  eventCount: number;
  latestSeq: number;
  lastEvent?: { seq: number; time: number; type: string };
  runtime: {
    attached: boolean;
    activeTurn: boolean;
    admissionPending: boolean;
    turnId?: string;
    backendSessionId?: string;
    worktreePath?: string;
  };
  queue: QueueItemDto[];
  pending: {
    permissions: string[];
    questions: string[];
    secrets: string[];
  };
  recentErrors: Array<{ seq: number; time: number; type: string; message: string }>;
  runtimeBinding?: SessionDebugRuntimeBindingDto;
  endpoint?: SessionDebugEndpointDto;
  counts: {
    fencedOperations: number;
    unknownOperations: number;
    heldForReview: number;
  };
  lastEpochReplaced?: SessionDebugEpochReplacedDto;
  recoveryPlan?: SessionDebugRecoveryPlanDto;
}

export interface SessionService {
  create(input: CreateSessionInput): Promise<SessionRef>;
  /** Result carries turnId for admitted turns or queueId+queued for deferred delivery. */
  send(sessionId: string, input: UserTurnInput): Promise<SendResult>;
  abort(sessionId: string): Promise<void>;
  /** No atSeq: copy the complete effective history. With atSeq: per-message
   *  fork — the child prefix ends strictly BEFORE the target user message and
   *  the excluded prompt returns as an editable draft. */
  fork(sessionId: string, atSeq?: number): Promise<ForkResult>;
  /** Soft-rewind to a user message without mutating prior events. */
  rewind?(sessionId: string, atSeq: number): Promise<SessionEvent>;
  /** Restore the tail hidden by the active rewind marker. */
  clearRewind?(sessionId: string): Promise<SessionEvent>;
  /** Execute a composer `!` command through the shell permission family. */
  runShell?(sessionId: string, command: string): Promise<ShellTurnResult>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<void>;
  /** Hard-delete the session (durable log + projection + queue). Guarded:
   *  callers confirm destructive intent upstream; a running turn is aborted
   *  first. Optional so existing fakes/tests remain valid. */
  delete?(sessionId: string): Promise<void>;
  list(projectId?: string): Promise<SessionProjection[]>;
  sync(projectId: string): Promise<SessionProjection[]>;
  snapshot(sessionId: string): Promise<SessionProjection>;
  /** `page` (beforeSeq/limit) selects the newest events in the window so deep
   *  logs hydrate incrementally; implementations may ignore it. */
  events(sessionId: string, afterSeq?: number, page?: EventPage): Promise<SessionEvent[]>;
  /** Read-only troubleshooting state. Does not attach or wake a runtime. */
  debug?(sessionId: string): Promise<SessionDebugDto>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject", scope?: "session" | "project"): Promise<void>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
  replySecret?(sessionId: string, requestId: string, reply: { action: "save"; value: string } | { action: "dismiss" }): Promise<void>;
  // -- parity additions (optional so existing fakes/tests remain valid) --
  /** Append session/metadata-changed and update the projection title. */
  rename?(sessionId: string, title: string): Promise<void>;
  /** Folder/label assignment; folder must belong to the session's project. */
  organize?(sessionId: string, patch: SessionOrganizePatch): Promise<void>;
  /** Projection-only reconciliation after a linked worktree is removed. */
  markWorktreeMissing?(projectId: string, worktreePath: string): Promise<void>;
  queueList?(sessionId: string): Promise<QueueItemDto[]>;
  /** Temporarily holds the queue head while it is edited in the composer. */
  queueEditStart?(sessionId: string, queueId: string): Promise<QueueItemDto>;
  queueEdit?(sessionId: string, queueId: string, text: string): Promise<QueueItemDto>;
  queueEditCancel?(sessionId: string, queueId: string): Promise<void>;
  queueReorder?(sessionId: string, ids: string[]): Promise<QueueItemDto[]>;
  queueRemove?(sessionId: string, queueId: string): Promise<void>;
  /** Pin/unpin a model-visible message by its canonical source-event sequence. */
  pinContext?(sessionId: string, sourceEventSeq: number): Promise<SessionEvent>;
  unpinContext?(sessionId: string, sourceEventSeq: number): Promise<SessionEvent>;
  /** F14 import half: backend sessions not yet adopted (items) + how many the
   *  backend has in total, so the UI can tell "none exist" from "all imported". */
  backendSessions?(projectId: string): Promise<{ items: RuntimeSession[]; total: number }>;
  /** Adopt the selected backend sessions; returns the new projections. */
  importBackendSessions?(projectId: string, backendIds: string[]): Promise<SessionProjection[]>;
  /** F18: read the session's auto-accept policy (own setting + effective). */
  autoAcceptGet?(sessionId: string): Promise<AutoAcceptDto>;
  /** F18: set the policy; enabling reconciles already-pending requests. */
  autoAcceptSet?(sessionId: string, setting: AutoAcceptSetting): Promise<AutoAcceptDto>;
  /** User-confirmed borrowed/external runtime replacement. Never auto-epochs. */
  confirmBorrowedRuntimeEpoch?(sessionId: string): Promise<SessionProjection>;
}

export interface SessionOrganizePatch {
  /** null clears the folder assignment */
  folderId?: string | null;
  labelIds?: string[];
  /** null unpins; position controls ordering in the pinned sidebar section. */
  pinned?: { position: number } | null;
}

// ---------------------------------------------------------------- persistence

/** One copied event of an atomic child snapshot. Copied events keep their
 *  exact source times and payloads but receive fresh child ids; `sourceSeq`
 *  records lineage provenance instead of reusing one event id across sessions. */
export interface ChildSnapshotEvent {
  time: number;
  type: string;
  data: JsonObject;
  ignorable?: boolean;
  surfaceOp?: "append" | "replace";
  producerPlugin?: string;
  /** Source-session seq this copied event was derived from. */
  sourceSeq?: number;
}

/** Atomic child publication: prefix events + projection + one lineage marker
 *  commit in a single store transaction or not at all. */
export interface ChildSnapshotInput {
  childSessionId: string;
  events: ChildSnapshotEvent[];
  projection: SessionProjection;
  marker: { type: string; data: JsonObject; ignorable?: boolean };
}

export interface ChildSnapshotResult {
  events: SessionEvent[];
  marker: SessionEvent;
}

/** Keyset pagination for event reads. `limit` returns the NEWEST matching
 *  events (still in ascending seq order); `beforeSeq` bounds the window from
 *  above so older history pages backward without offset scans. */
export interface EventPage {
  /** Exclusive upper bound: only events with seq < beforeSeq. */
  beforeSeq?: number;
  /** Maximum number of events; the newest ones in the window are returned. */
  limit?: number;
}

export interface SessionPersistence {
  append(sessionId: string, type: string, data: JsonObject, opts?: Partial<Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">>): Promise<SessionEvent>;
  events(sessionId: string, afterSeq?: number, page?: EventPage): Promise<SessionEvent[]>;
  /** Indexed existence check (no full-log scan). Optional so fakes stay valid. */
  hasEventOfType?(sessionId: string, type: string): Promise<boolean>;
  latestSeq(sessionId: string): Promise<number>;
  copyTo(srcSessionId: string, dstSessionId: string, upToSeq?: number): Promise<void>;
  upsertProjection(p: SessionProjection): Promise<void>;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  projections(projectId?: string): Promise<SessionProjection[]>;
  /** All-or-nothing child snapshot (per-message fork publication). Optional so
   *  existing fakes remain valid; callers must treat absence as unsupported. */
  publishChildSession?(input: ChildSnapshotInput): Promise<ChildSnapshotResult>;
  /** Atomic read-modify-write on the latest projection row. Returns the exact
   *  committed projection (broadcast that, never a stale in-memory copy). */
  patchProjection?(sessionId: string, patch: (current: SessionProjection) => SessionProjection): Promise<SessionProjection | undefined>;
  /** Hard-delete one session's events, projection, and queued messages in a
   *  single transaction. Optional so existing fakes remain valid. */
  deleteSession?(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- agent runtime (backend seam)

/** Runtime location is explicit in every binding; callers normalize directory
 * before constructing it. */
export interface RuntimeLocation {
  directory: string;
  workspace?: string;
}

export type RuntimeControl =
  | { kind: "owned"; instanceToken: string }
  | { kind: "borrowed"; source: "shared" | "external" };

export type RuntimeConfigAuthority =
  | { kind: "read-only" }
  | { kind: "writable"; targetId: string };

/** Environment variable names and resolvers are capabilities, not persisted
 * credential values. */
export type RuntimeAuthentication =
  | { kind: "none" }
  | { kind: "basic-env"; usernameEnv: string; passwordEnv: string }
  | { kind: "endpoint-headers"; resolve: () => Promise<Record<string, string>> };

export interface RuntimeEndpoint {
  authorityId: string;
  continuity: "verified" | "generation-only";
  generation: number;
  url: string;
  location: RuntimeLocation;
  control: RuntimeControl;
  config: RuntimeConfigAuthority;
  authentication: RuntimeAuthentication;
}

export interface BaseRuntimeEndpointLease {
  endpoint(): Promise<RuntimeEndpoint>;
  refresh(reason: "connect" | "disconnect" | "unauthorized"): Promise<RuntimeEndpoint>;
  dispose(): Promise<void>;
}

export interface OwnedRuntimeEndpointLease extends BaseRuntimeEndpointLease {
  readonly control: { kind: "owned"; instanceToken: string };
  restart(reason: "crash" | "config" | "manual"): Promise<RuntimeEndpoint>;
}

export interface BorrowedRuntimeEndpointLease extends BaseRuntimeEndpointLease {
  readonly control: { kind: "borrowed"; source: "shared" | "external" };
}

export type RuntimeEndpointLease = OwnedRuntimeEndpointLease | BorrowedRuntimeEndpointLease;

export type ReplayPolicy =
  | { kind: "never" }
  | { kind: "same-operation-id"; contract: string };

export type MutationOutcome<T> =
  | { kind: "confirmed"; value: T; receipt?: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; operationId: string; message: string };

export type MutationTransportResult<T> =
  | {
      kind: "response";
      status: number;
      headers: Readonly<Record<string, string>>;
      body: T;
    }
  | { kind: "unknown"; operationId: string; message: string };

/** Wire paths remain adapter-private values. No provider DTO crosses this
 * query/mutation/stream safety boundary. */
export interface OpenCodeTransport {
  query<T>(request: {
    method: "GET" | "HEAD";
    path: string;
    deadlineMs: number;
  }): Promise<T>;
  mutate<T>(request: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    operationId: string;
    deadlineMs: number;
    replay: ReplayPolicy;
  }): Promise<MutationTransportResult<T>>;
  stream(request: {
    path: string;
    after?: string;
    signal: AbortSignal;
    onEvent(value: unknown): void;
  }): Promise<void>;
}

/** Normalized mutation names used in durable rows and canonical events. */
export type RuntimeMutationKind =
  | "session-create"
  | "session-reset"
  | "session-fork"
  | "session-revert"
  | "turn-submit"
  | "turn-steer"
  | "turn-abort"
  | "session-delete"
  | "permission-reply"
  | "question-reply"
  | "question-reject"
  | "secret-reply";

export interface RuntimeSessionBinding {
  canonicalSessionId: string;
  backendSessionId?: string;
  authorityId: string;
  generation: number;
  continuity: "verified" | "generation-only";
  location: RuntimeLocation;
}

export type RuntimeReconciliationBinding = RuntimeSessionBinding & {
  reconciliationOrdinal?: number;
};

export interface PersistedRuntimeBinding {
  backendSessionId: string;
  authorityId: string;
  generation: number;
  /** Deliberate backend-identity break counter. Missing on legacy rows means epoch 0. */
  epoch?: number;
  continuity: "verified" | "generation-only";
  protocol: "legacy" | "v2";
  location: RuntimeLocation;
  /** First-reconciliation handling for backend history already represented by
   * canonical copied events, or intentionally imported from the backend. */
  historyBaseline?: "empty" | "copied" | "import";
}

export interface RuntimeTurnBinding {
  session: RuntimeSessionBinding;
  text: string;
  attachments?: AttachmentRef[];
  model?: ModelRef;
  agent?: string;
}

export interface RuntimeSnapshot {
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
  reconciliationOrdinal: number;
  state: {
    value: "running" | "idle" | "failed" | "interrupted" | "unknown";
    watermark?: string;
    /** Provider-normalized monotonic evidence. A terminal state is destructive
     * only when this order is comparable with the stored order for `domain`. */
    comparison?: {
      domain: string;
      order: number;
    };
    /** Exact confirmed operation that makes a fresh-session idle state causal
     * without pretending its unversioned status text is monotonic evidence. */
    causalOperationId?: string;
  };
  completeness: {
    events: "complete" | "partial" | "unverifiable";
    permissions: "complete" | "partial" | "unverifiable";
    questions: "complete" | "partial" | "unverifiable";
  };
  cursorAfter?: string;
  permissions: Array<{
    requestId: string;
    permission: string;
    patterns: string[];
    /** Stable upstream entity revision when the protocol exposes one. */
    revision?: string;
  }>;
  questions: Array<{
    requestId: string;
    questions: JsonObject[];
    /** Stable upstream entity revision when the protocol exposes one. */
    revision?: string;
  }>;
  events: Array<{
    entityKey: string;
    revision: string;
    event: RuntimeEvent;
  }>;
  /** Protocol-proven links between durable Polyth operations and accepted
   * upstream entities. Adapters omit this when the backend exposes no stable
   * operation receipt; equal content is never evidence. */
  acceptedOperations?: Array<{
    operationId: string;
    mutationKind: RuntimeMutationKind;
    receipt?: string;
    entityId?: string;
    backendSessionId?: string;
  }>;
  /** Protocol-proven evidence that a specific durable operation had no
   * upstream effect. Completeness alone is not causal proof; adapters omit
   * this unless an operation lookup or pinned causally-newer snapshot contract
   * proves non-application. */
  nonAppliedOperations?: Array<{
    operationId: string;
    mutationKind: RuntimeMutationKind;
    requestId?: string;
    backendSessionId?: string;
  }>;
}

/** A protocol-neutral, semantically identified runtime observation. SSE and
 * pull/history producers use the same identity so the session store can claim
 * the canonical event batch exactly once. */
export interface RuntimeObservation {
  channel: "sse" | "pull";
  entityKey: string;
  identity: ObservationIdentity;
  reconciliationOrdinal: number;
  events: RuntimeEvent[];
  /** Explicit non-model-visible evidence that an identified upstream artifact
   * cannot be merged with the durable checkpoint without guessing. */
  uncertainty?: {
    code: "divergent-content" | "terminal-payload-changed";
    message: string;
  };
  checkpoint?: {
    stateRank?: number;
    value: JsonObject;
  };
  cursorAfter?: string;
}

/** Runtime connectivity notifications are evidence triggers, not mutation
 * outcomes. Consumers reconcile durable sessions before reopening admission. */
export type RuntimeLifecycleNotification =
  | {
      type: "stream-connected" | "stream-disconnected";
      authorityId?: string;
      generation?: number;
      reason?: string;
    }
  | {
      type: "endpoint-replaced";
      authorityId: string;
      generation: number;
      reason: "connect" | "disconnect" | "unauthorized" | "crash" | "config" | "manual";
    };

export interface ProtocolCapabilities {
  eventReplay: "none" | "contract-tested";
  pendingSnapshot: "none" | "partial" | "complete-causal";
  idempotentMutations: ReadonlySet<RuntimeMutationKind>;
}

export interface ProtocolAdapter {
  readonly protocol: "legacy" | "v2";
  capabilities(): Promise<ProtocolCapabilities>;
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  sessions(): Promise<RuntimeSession[]>;
  history(input: RuntimeSessionBinding): Promise<RuntimeSessionMessage[]>;
  eventStreamPath(): string | undefined;
  ensureSession(
    input: RuntimeSessionBinding,
    operationId: string,
    title?: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  resetSession(
    input: RuntimeSessionBinding,
    title: string | undefined,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  branchSession(
    input: {
      source: RuntimeSessionBinding;
      target: RuntimeSessionBinding;
      title?: string;
      history: ModelMessage[];
    },
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  submit(
    input: RuntimeTurnBinding,
    operationId: string,
  ): Promise<MutationOutcome<{ admissionId?: string }>>;
  steer(
    input: RuntimeTurnBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  abort(
    input: RuntimeSessionBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  deleteSession(
    input: RuntimeSessionBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyPermission(
    input: RuntimeSessionBinding,
    requestId: string,
    reply: "once" | "always" | "reject",
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyQuestion(
    input: RuntimeSessionBinding,
    requestId: string,
    answers: JsonObject,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  reconcile(input: RuntimeReconciliationBinding, after?: string): Promise<RuntimeSnapshot>;
}

// ------------------------------------------------ durable mutation/reconciliation vocabulary

export type DurableOperationState =
  | "prepared"
  | "executing"
  | "confirmed"
  | "rejected"
  | "unknown"
  | "not-applied"
  | "fenced";
export type OperationState = DurableOperationState;
export type RuntimeOperationState = DurableOperationState;

export interface DurableOperation {
  operationId: string;
  sessionId: string;
  ordinal: number;
  mutationKind: RuntimeMutationKind;
  state: DurableOperationState;
  replay: ReplayPolicy;
  createdAt: number;
  updatedAt: number;
  code?: string;
  message?: string;
  receipt?: string;
  ownerEventSeq?: number;
}

export interface CanonicalEventInput {
  type: string;
  data: JsonObject;
  ignorable?: boolean;
  surfaceOp?: "append" | "replace";
  sourceEventSeqs?: number[];
  producerPlugin?: string;
}

export interface PrepareOperationInput {
  sessionId: string;
  mutationKind: RuntimeMutationKind;
  /** Every generic preparation has one owning intent event in the same
   * transaction. Queue, create, response, and deletion use specialized APIs. */
  intentEvent: CanonicalEventInput;
  replay?: ReplayPolicy;
}

export interface PreparedOperationResult {
  operation: DurableOperation;
  intentEvent: SessionEvent;
  stateEvent: SessionEvent;
}

export interface PrepareSessionCreateInput {
  projection: SessionProjection;
  createdEvent: CanonicalEventInput;
  replay?: ReplayPolicy;
}

export interface PreparedSessionCreateResult {
  operation: DurableOperation;
  createdEvent: SessionEvent;
  stateEvent: SessionEvent;
  projection: SessionProjection;
}

/** Atomic durable half of an epoch replacement. The reset operation must
 * already be protocol-confirmed with the replacement backend session receipt.
 * Pre-reset prepared operations are rejected and executing operations become
 * unknown. Only an owned fence may then move those unknowns to fenced. */
export interface RuntimeEpochTransitionInput {
  sessionId: string;
  expectedBinding: PersistedRuntimeBinding;
  replacementBinding: PersistedRuntimeBinding;
  resetOperationId: string;
  reason: string;
  fence?: {
    authorityId: string;
    generation: number;
  };
}

export interface RuntimeEpochTransitionResult {
  marker: SessionEvent;
  projection: SessionProjection;
  fencedOperations: DurableOperation[];
  heldQueueItems: QueueItemDto[];
}

export type OperationClaimResult =
  | { kind: "claimed"; operation: DurableOperation; event?: SessionEvent }
  | { kind: "not-claimed"; operation?: DurableOperation };

export type OperationSettlement =
  | { kind: "confirmed"; receipt?: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; code?: string; message: string }
  | { kind: "not-applied"; code?: string; message: string };

export interface QueueReservation {
  queueItem: QueueItemDto;
  operation: DurableOperation;
  reservedAt: number;
}

export interface QueueReservationInput {
  sessionId: string;
  mutationKind?: "turn-submit" | "turn-steer";
  replay?: ReplayPolicy;
}

export type QueueReservationResult =
  | { kind: "empty" }
  | { kind: "reserved"; reservation: QueueReservation }
  | { kind: "blocked"; reservation: QueueReservation }
  | { kind: "held"; queueItem: QueueItemDto };

export type ObservationArtifactKind =
  | "message"
  | "part"
  | "tool"
  | "permission"
  | "question"
  | "status"
  | "turn";

/** Generation is captured for audit/fencing but deliberately excluded from
 * durable semantic uniqueness. */
export interface ObservationIdentity {
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
  artifactKind: ObservationArtifactKind;
  entityId: string;
  revision: string;
}

export interface ObservationEntityKey {
  authorityId: string;
  location: RuntimeLocation;
  backendSessionId: string;
  artifactKind: ObservationArtifactKind;
  entityId: string;
}

export interface ObservationCheckpoint {
  key: ObservationEntityKey;
  revision: string;
  stateRank?: number;
  value: JsonObject;
  updatedAt: number;
}

export interface ObservationCursorKey {
  authorityId: string;
  location: RuntimeLocation;
  backendSessionId: string;
  channel: string;
}

export interface ObservationIngestionInput {
  sessionId: string;
  identity: ObservationIdentity;
  reconciliationOrdinal: number;
  events: CanonicalEventInput[];
  checkpoint?: {
    stateRank?: number;
    value: JsonObject;
  };
  cursor?: {
    key: ObservationCursorKey;
    after: string;
  };
}

export interface SnapshotIngestionInput {
  sessionId: string;
  observations: ObservationIngestionInput[];
}

export interface SnapshotIngestionResult {
  observations: ObservationIngestionResult[];
}

export type ObservationIngestionResult =
  | { kind: "applied"; events: SessionEvent[]; checkpoint?: ObservationCheckpoint }
  | { kind: "duplicate"; events: SessionEvent[]; checkpoint?: ObservationCheckpoint };

export type DurableReconciliationState = "reconciling" | "ready" | "blocked" | "unknown";

export interface DurableReconciliation {
  sessionId: string;
  ordinal: number;
  state: DurableReconciliationState;
  reason?: string;
  updatedAt: number;
}

export interface DeletionTombstoneBinding {
  canonicalSessionId: string;
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
}

export interface DeletionTombstone {
  binding: DeletionTombstoneBinding;
  operationId: string;
  createdAt: number;
  retiredAt?: number;
  retirement?: { kind: "confirmed" } | { kind: "purged"; policy: string };
}

export interface PrepareDeletionTombstoneInput {
  binding: DeletionTombstoneBinding;
  replay?: ReplayPolicy;
}

export interface PreparedDeletionTombstoneResult {
  tombstone: DeletionTombstone;
  operation: DurableOperation;
}

export type ResponseIntentInput =
  | {
      kind: "permission";
      sessionId: string;
      requestId: string;
      reply: "once" | "always" | "reject";
      scope?: "session" | "project";
    }
  | {
      kind: "question";
      sessionId: string;
      requestId: string;
      answers: JsonObject;
      reject?: boolean;
    }
  | {
      kind: "secret";
      sessionId: string;
      requestId: string;
      action: "save" | "dismiss";
      handle?: string;
    };

export interface DurableResponseIntent {
  kind: ResponseIntentInput["kind"];
  sessionId: string;
  requestId: string;
  operationId: string;
  payload: JsonObject;
  createdAt: number;
}

export type ResponseIntentChoice =
  | { kind: "chosen"; intent: DurableResponseIntent; operation: DurableOperation }
  | { kind: "existing"; intent: DurableResponseIntent; operation: DurableOperation };

export type ResponseIntentSettlement =
  | { kind: "confirmed"; receipt?: string; completionEvent: CanonicalEventInput }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; code?: string; message: string }
  | { kind: "not-applied"; code?: string; message: string };

export interface ModelDescriptor { providerID: string; modelID: string; name: string; providerName?: string; context?: number; cost?: { input: number; output: number }; /** Normalized values include `input:text`, `output:image`, `input:none`, `toolcall`, and `attachment`. */ capabilities?: string[]; /** Named reasoning variants reported by OpenCode (for example low/medium/high). */ variants?: string[]; /** Provider has live credentials (backend `connected[]`); undefined = unknown/assume connected. */ connected?: boolean }
export interface AgentDescriptor {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  /** OpenCode's role-level system prompt, when exposed by the backend. */
  prompt?: string;
  /** Role-specific model override. */
  model?: ModelRef;
}
export interface RuntimeCapabilities { streaming: boolean; permissions: boolean; questions: boolean; compaction: boolean; subagents: boolean; steering?: boolean }
export interface RuntimeSession {
  id: string;
  title: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  /** Present only when the protocol supplies a stable create-operation
   * receipt. Used to recover an unknown create without issuing another POST. */
  operationId?: string;
}
export interface RuntimeSessionMessage { role: "user" | "assistant"; text: string; reasoning?: string }

export interface CanonicalTurnRequest {
  sessionId: string;       // canonical session id; adapter maps to backend id
  text: string;
  /** Already persisted in the user/message event before startTurn is called. */
  attachments?: AttachmentRef[];
  model?: ModelRef;
  agent?: string;
}

/** Provider-neutral exact-history branch request (UX-MSG-ACTIONS).
 *  `sourceSessionId` and `target.sessionId` are canonical ids; the server
 *  passes only the canonical effective model history and never knows a
 *  backend message id. When `target.sessionId === sourceSessionId` the
 *  adapter prepares a replacement backend for the same canonical session and
 *  swaps its mapping only after the exact prefix is verified. */
export interface RuntimeBranchRequest {
  sourceSessionId: string;
  target: CreateSessionInput & { sessionId: string; cwd: string };
  history: ModelMessage[];
}

// Runtime events the adapter yields; session service translates + persists them.
export type RuntimeEvent =
  | { type: "turn/started"; turnId: string }
  | { type: "session/title-generated"; title: string }
  | { type: "assistant/chunk"; partId: string; text: string }
  | { type: "assistant/reasoning-chunk"; partId: string; text: string }
  | { type: "assistant/message"; partId: string; text: string; reasoning?: string; tokens?: TokenUsage; cost?: number }
  | { type: "tool/call"; callId: string; tool: string; input: JsonObject; status: "pending" | "running" }
  | { type: "tool/started"; callId: string; tool: string; input: JsonObject }
  | { type: "tool/result"; callId: string; tool: string; output: string; title?: string; metadata?: JsonObject; input?: JsonObject }
  | { type: "tool/error"; callId: string; tool: string; error: string; input?: JsonObject }
  | { type: "permission/requested"; requestId: string; permission: string; patterns: string[]; metadata?: JsonObject; tool?: string }
  | { type: "question/asked"; requestId: string; questions: JsonObject[] }
  | ({ type: "secret/requested" } & SecretRequestData)
  | { type: "session/compacted"; backendEventId?: string }
  | { type: "compaction/part-recorded"; partId: string; messageId?: string; auto?: boolean }
  | { type: "turn/stopped"; reason: "completed" | "aborted" | "error"; error?: string }
  | { type: "usage/recorded"; model: ModelRef; tokens: TokenUsage; cost?: number }
  // Full revisioned snapshots (WP8): replay-deterministic task/subagent state.
  | { type: "task/snapshot"; listId: string; revision: number; items: Array<{ id: string; text: string; status: TaskItemStatus }> }
  | { type: "subagent/snapshot"; revision: number; agents: Array<{ sessionId: string; label: string; status: string; currentTask?: string }> };

export interface AgentRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  ensureSession(canonical: CreateSessionInput & { sessionId: string; cwd: string }): Promise<string>;
  /** Operation-aware create. The supplied durable ID is used for this one
   * attempt and ambiguity is returned instead of hidden replay. */
  createSessionOperation?(
    canonical: CreateSessionInput & { sessionId: string; cwd: string },
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  /** Replace one canonical session's backend history with a fresh backend session. */
  resetSession?(canonical: CreateSessionInput & { sessionId: string; cwd: string }): Promise<string>;
  resetSessionOperation?(
    canonical: CreateSessionInput & { sessionId: string; cwd: string },
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  /** Create a backend session holding EXACTLY the requested canonical history
   *  (native fork at the exact predecessor). Returns the backend child id.
   *  Rejects `history-mismatch` when the read-back child history differs and
   *  `unsupported` when the runtime cannot branch or hydrate exact history —
   *  never approximates with a hidden prompt, summary, or optimistic copy. */
  branchSession?(request: RuntimeBranchRequest): Promise<string>;
  branchSessionOperation?(
    request: RuntimeBranchRequest,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  /** Best-effort discard of an unreferenced backend branch after a failed
   *  canonical publication. Never throws for an unknown session. */
  discardSession?(sessionId: string): Promise<void>;
  discardSessionOperation?(
    sessionId: string,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  sessions(): Promise<RuntimeSession[]>;
  history(sessionId: string): Promise<RuntimeSessionMessage[]>;
  startTurn(req: CanonicalTurnRequest): Promise<void>; // events flow via onEvent
  startTurnOperation?(
    req: CanonicalTurnRequest,
    operationId: string,
  ): Promise<MutationOutcome<{ admissionId?: string }>>;
  /** Live steering of an active turn. Returns false when unsupported/rejected;
   *  callers must fall back to queueing. Optional so old fakes remain valid. */
  steer?(sessionId: string, text: string): Promise<boolean>;
  steerOperation?(
    sessionId: string,
    text: string,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  abort(sessionId: string): Promise<void>;
  abortOperation?(
    sessionId: string,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyPermissionOperation?(
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
  replyQuestionOperation?(
    sessionId: string,
    requestId: string,
    answers: JsonObject,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replySecret?(sessionId: string, requestId: string, result: SecretResolvedData): Promise<void>;
  replySecretOperation?(
    sessionId: string,
    requestId: string,
    result: SecretResolvedData,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  endpoint?(): Promise<RuntimeEndpoint>;
  protocol?(): Promise<ProtocolAdapter["protocol"]>;
  reconcile?(
    binding: RuntimeReconciliationBinding,
    after?: string,
  ): Promise<RuntimeSnapshot>;
  /** Present on runtimes that can preserve semantic upstream identity. When a
   * consumer subscribes here, identified events are delivered through this
   * seam instead of the legacy unindexed onEvent path. */
  onObservation?(cb: (sessionId: string, observation: RuntimeObservation) => void): Disposable;
  onLifecycle?(cb: (notification: RuntimeLifecycleNotification) => void): Disposable;
  onEvent(cb: (sessionId: string, ev: RuntimeEvent) => void): Disposable;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------- tools & permissions

export interface ToolDefinition {
  name: string; description: string;
  inputSchema: JsonObject;      // JSON schema
  trust: TrustClass;
}
export interface ToolExecutionContext { sessionId: string; projectId: string; cwd: string; signal?: AbortSignal }
export type ToolExecutor = (input: JsonObject, ctx: ToolExecutionContext) => Promise<{ output: string; metadata?: JsonObject }>;

export type ToolGuardVerdict =
  | { kind: "abstain" }
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "require-approval"; request: PermissionRequestData };

export interface PermissionGuard {
  id: string;
  check(call: { tool: string; input: JsonObject; sessionId: string; projectId: string }): Promise<ToolGuardVerdict> | ToolGuardVerdict;
}

// ---------------------------------------------------------------- projects

export interface ProjectDefaults {
  agentProfileId?: string;
  agent?: string | null;
  /** null explicitly inherits the browser's global session default. */
  model?: ModelRef | null;
  /** Persist composer model choices as this project's default. */
  rememberModelSelection?: boolean;
  groupingMode?: string;
  worktreeBehavior?: "project-root" | "fresh-worktree";
}

/** Binding of a project to a workspace on a remote machine. When present,
 * `Project.path` is the path ON that machine and the agent runtime runs there
 * (see `RemoteHost`); local filesystem features degrade honestly. */
export interface ProjectRemote {
  kind: "ssh";
  /** SSH connection id from the SSH connection inventory. */
  connectionId: string;
}

export interface Project {
  id: string; path: string; name: string;
  color?: string; icon?: string; createdAt: number;
  defaults?: ProjectDefaults;
  labelIds?: string[];
  remote?: ProjectRemote;
}

/** Agent-oriented project inventory with session activity counts. */
export interface AgentProjectSummaryDto {
  project: Project;
  sessionCount: number;
  activeSessionCount: number;
  archivedSessionCount: number;
  latestActivityAt?: number;
}

/** One cross-project session inventory row with a bounded recent event tail. */
export interface AgentSessionSummaryDto {
  session: SessionProjection;
  project: Project | null;
  eventCount: number;
  latestSeq: number;
  recentEvents: SessionEvent[];
}

export interface AgentSessionListDto {
  projects: AgentProjectSummaryDto[];
  sessions: AgentSessionSummaryDto[];
  total: number;
  limit: number;
  offset: number;
}

/** Complete agent read model: canonical projection, conversation, state, and
 * a bounded event window. The dedicated events endpoint pages the full log. */
export interface AgentSessionDetailDto {
  session: SessionProjection;
  project: Project | null;
  events: SessionEvent[];
  messages: ModelMessage[];
  state: SessionDebugDto;
  eventWindow: {
    total: number;
    returned: number;
    truncatedBeforeSeq?: number;
  };
  links: Record<string, string>;
}

export interface ProjectPatch {
  name?: string;
  color?: string;
  icon?: string;
  defaults?: ProjectDefaults;
}

export interface ProjectService {
  list(): Promise<Project[]>;
  add(path: string, name?: string): Promise<Project>;
  create(path: string, name?: string): Promise<Project>;
  /** Clone a Git repository into a new child of `parentPath`, then register it. */
  clone?(repository: string, parentPath: string): Promise<Project>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<Project | undefined>;
  /** PATCH metadata/defaults; optional so old fakes remain valid. */
  update?(id: string, patch: ProjectPatch): Promise<Project>;
  /** Register a project whose path lives on a remote machine — the local
   *  existence check does not apply. Optional so old fakes remain valid. */
  addRemote?(path: string, remote: ProjectRemote, name?: string): Promise<Project>;
}

// ---------------------------------------------------------------- packages

export type PackageSettingsGroup = "Workspace" | "Engineering" | "Customize" | "System";

export interface PackageDescriptorDto {
  id: string;
  name: string;
  description: string;
  core: boolean;
  enabled: boolean;
  status?: "ready" | "disabled";
  settingsGroup?: PackageSettingsGroup;
  /** Emoji or short icon label for the settings navigation. */
  icon?: string;
  hasSettings: boolean;
}

// ------------------------------------------------ package onboarding tours

/** Visual for a tour step: either a real screenshot (`kind: "image"` + `src`)
 * or a named decorative pattern (`kind: "pattern"` + `pattern`) the web app
 * draws itself, so tours need no bundled assets. */
export interface PackageOnboardingMedia {
  kind: "image" | "pattern";
  /** Image URL, required when kind is "image". */
  src?: string;
  /** Pattern key (e.g. "branches", "waveform", "tiles", "orbit", "rays"),
   * used when kind is "pattern". Unknown keys fall back to a typographic
   * treatment of the tour title. */
  pattern?: string;
}

/** Where a step's highlighted control lives, so the overlay can caption it
 * honestly ("In these settings" vs "In the workspace pane" etc.). */
export type PackageOnboardingHighlightWhere =
  | "settings"
  | "workspace"
  | "pane"
  | "composer"
  | "header";

export interface PackageOnboardingStep {
  id: string;
  title: string;
  /** Short plain-text copy; a sentence or two per step. */
  body: string;
  /** Exact UI label of the control this step explains, if any. */
  highlight?: string;
  /** Location of the highlighted control. Defaults to "settings". */
  highlightWhere?: PackageOnboardingHighlightWhere;
  media?: PackageOnboardingMedia;
}

/** A package's multi-step introduction overlay. Tours are registered
 * client-side (by the package installer or the built-in tour list) and shown
 * over the settings modal; skip/complete flags are pure UI preference state
 * and never enter the session event log. */
export interface PackageOnboardingTour {
  packageId: string;
  title: string;
  steps: PackageOnboardingStep[];
}

// ---------------------------------------------------------------- Home Assistant

export interface HomeAssistantEntitySelection {
  stateEntityId: string;
  lightEntityId: string;
  climateEntityId: string;
  sensorEntityIds: string[];
}

/** Safe, browser-visible settings. `tokenEnv` is a reference; token values are
 * write-only and never appear in this shape. */
export interface HomeAssistantConfigDto {
  baseUrl: string;
  tokenEnv: string;
  tokenConfigured: boolean;
  entities: HomeAssistantEntitySelection;
}

export interface HomeAssistantConfigInput {
  baseUrl?: string;
  tokenEnv?: string;
  /** Write-only long-lived access token. */
  token?: string;
  entities?: Partial<HomeAssistantEntitySelection>;
}

export interface HomeAssistantConnectionDto {
  status: "connected" | "unconfigured" | "unavailable";
  baseUrl: string;
  checkedAt: number;
  version?: string;
  message?: string;
}

export interface HomeAssistantEntityDto {
  entityId: string;
  state: string;
  attributes: Record<string, JsonValue>;
  lastChanged: string;
  lastUpdated: string;
}

// ---------------------------------------------------------------- SSH remotes

/** How the OpenSSH client authenticates. Password auth is intentionally not
 * supported: Polyth delegates authentication to the user's OpenSSH setup
 * (agent, default keys, ssh_config) or an explicit identity FILE PATH — no
 * secret material is ever stored or returned. */
export type SshAuthMode = "agent" | "identity-file";

export interface SshConnectionDto {
  id: string;
  name: string;
  /** Hostname, IP, or an ssh_config Host alias. */
  host: string;
  port?: number;
  user?: string;
  authMode: SshAuthMode;
  /** Private-key path on the LOCAL machine (never key content). */
  identityFile?: string;
  createdAt: number;
}

export interface SshConnectionInput {
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  authMode?: SshAuthMode;
  identityFile?: string;
}

export type SshConnectionState = "connected" | "disconnected" | "unreachable" | "auth-failed";

export interface SshConnectionStatusDto {
  id: string;
  state: SshConnectionState;
  checkedAt: number;
  /** Round-trip time of the last real probe (test), not of mux checks. */
  latencyMs?: number;
  message?: string;
}

export interface SshBrowseEntryDto { name: string; path: string }
export interface SshBrowseDto {
  path: string;
  parent: string | null;
  home: string;
  entries: SshBrowseEntryDto[];
}

/** Generic transport to a machine reachable over an established connection.
 * Implemented by the SSH feature package and consumed by backend-opencode to
 * run the agent runtime ON the remote host — the transport itself knows
 * nothing about OpenCode. */
export interface RemoteProcessHandle {
  /** Combined stdout+stderr of the remote process, as it streams in. */
  onOutput(cb: (chunk: string) => void): Disposable;
  onExit(cb: (code: number | null) => void): Disposable;
  /** Best-effort termination of the remote process. */
  kill(): Promise<void>;
}

export interface RemoteForwardHandle extends Disposable {
  localPort: number;
}

export interface RemoteHost {
  /** Human-readable identity for error messages (e.g. "user@host"). */
  label: string;
  /** Run a command to completion (bounded output, POSIX sh on the far side). */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Start a long-lived remote process whose output can be observed. */
  start(command: string): Promise<RemoteProcessHandle>;
  /** Forward a fresh local port to `remotePort` on the remote loopback. */
  forward(remotePort: number): Promise<RemoteForwardHandle>;
}

// ---------------------------------------------------------------- task trackers

export type TaskTrackerProvider = "jira" | "trello";
export type TaskTrackerProviderMode = "live" | "demo";
export type TaskTrackerBoardType = "kanban" | "scrum" | "simple" | "unknown";
export type TaskTrackerStatusCategory = "todo" | "in_progress" | "done" | "unknown";

export interface TaskTrackerProviderDto {
  provider: TaskTrackerProvider;
  /** Live uses configured credentials; demo is an in-memory credential-free sandbox. */
  mode: TaskTrackerProviderMode;
  configured: boolean;
  /** Environment-variable names only. Credential values are never returned. */
  requiredEnv: string[];
}

export interface TaskTrackerProjectDto {
  provider: TaskTrackerProvider;
  id: string;
  key: string;
  name: string;
  url?: string;
  avatarUrl?: string;
}

export interface TaskTrackerBoardDto {
  provider: TaskTrackerProvider;
  id: string;
  name: string;
  type: TaskTrackerBoardType;
  projectId?: string;
  projectKey?: string;
  url?: string;
}

export interface TaskTrackerStatusDto {
  id: string;
  name: string;
  category: TaskTrackerStatusCategory;
}

export interface TaskTrackerTaskDto {
  provider: TaskTrackerProvider;
  id: string;
  key: string;
  title: string;
  description: string;
  url?: string;
  boardId?: string;
  projectId?: string;
  projectKey?: string;
  status: TaskTrackerStatusDto;
  availableStatuses?: TaskTrackerStatusDto[];
  labels: string[];
  assignees: string[];
  dueAt?: string;
  updatedAt?: string;
}

export interface TaskTrackerTaskQuery {
  boardId?: string;
  projectId?: string;
  limit?: number;
}

/** Durable task-link projection returned for one Polyth session. */
export interface TaskTrackerSessionTaskDto {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey: string;
  title: string;
  statusId: string;
  statusName: string;
  completed: boolean;
  selectedAtSeq: number;
  updatedAtSeq: number;
}

export interface TaskTrackerService {
  providers(): TaskTrackerProviderDto[];
  listProjects(provider: TaskTrackerProvider): Promise<TaskTrackerProjectDto[]>;
  listBoards(provider: TaskTrackerProvider, projectId?: string): Promise<TaskTrackerBoardDto[]>;
  listTasks(provider: TaskTrackerProvider, query: TaskTrackerTaskQuery): Promise<TaskTrackerTaskDto[]>;
  getTask(provider: TaskTrackerProvider, taskId: string): Promise<TaskTrackerTaskDto>;
  updateStatus(
    provider: TaskTrackerProvider,
    taskId: string,
    statusId: string,
  ): Promise<TaskTrackerTaskDto>;
}

export interface TaskSelectedData {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey: string;
  title: string;
  url?: string;
  statusId: string;
  statusName: string;
}

export interface TaskStatusChangedData extends TaskSelectedData {
  previousStatusId: string;
  previousStatusName: string;
}

export interface TaskCompletedData extends TaskSelectedData {}

// ---------------------------------------------------------------- UI contributions (host + client shared shapes)

/** Canonical slot vocabulary — the runtime list backs `UiSlot` so the
 *  server-managed manifest boundary can reject unknown slot names. */
export const UI_SLOTS = [
  "app.nav", "app.header.actions", "app.window.controls", "session.header.actions", "session.list.badges",
  "sidebar.footer",
  "composer.leading", "composer.trailing", "contextRail.tabs",
  "settings.pages", "settings.footer", "commandPalette.commands",
  // Widget definitions enter through the catalog/settings seams. The six
  // workspace slots are first-class placement targets alongside panel and
  // toolbar slots, rather than a canvas-only parallel vocabulary.
  "widget.catalog", "widget.settings", "workspace.canvas",
  "workspace.header", "workspace.left", "workspace.main",
  "workspace.right", "workspace.bottom", "workspace.floating",
  // parity slots (WP1): focused seams instead of mega-component imports
  "workspace.main.tabs", "workspace.right.tabs",
  // project creation sources beyond the local folder picker (e.g. SSH remotes)
  "project.create.options",
  "session.timeline.before", "session.timeline.after", "session.composer.before",
  "session.footer",
  // Fresh-session widgets (starters, recents, or a plugin replacement). This
  // is deliberately a slot rather than a SessionHero import: idle-screen
  // information density is user-configurable and plugins can replace it.
  "session.empty.widgets",
  "session.message.actions",
  "sidebar.project.actions", "sidebar.session.actions",
  "workStatus.sections",
] as const;

export type UiSlot = (typeof UI_SLOTS)[number];

export function isUiSlot(value: string): value is UiSlot {
  return (UI_SLOTS as readonly string[]).includes(value);
}

/** Canonical locale vocabulary — every message catalog covers all of these. */
export const LOCALES = [
  "uk", "en", "de", "fr", "pl", "pt-BR", "it", "es", "zh-CN", "bg", "ar", "pt",
] as const;

export type Locale = (typeof LOCALES)[number];

/** Per-locale message catalogs a package contributes; the web app merges the
 *  bundles from every package into one catalog per locale. English is the
 *  canonical key set — `K` is derived from a package's `en` catalog so a
 *  missing or extra key in any locale fails the typecheck. */
export type LocaleBundle<K extends string = string> = Record<Locale, Record<K, string>>;

export type WidgetKind = "widget" | "mini-widget";
export type WidgetAudience = "simple" | "standard" | "power";
export type WidgetScope = "global" | "workspace" | "plugin";

export interface WidgetSize {
  w: number;
  h: number;
}

/** Serializable half of a plugin-owned widget. The client pairs `module` with
 * an allowlisted renderer. A plugin may declare zero, one, or many of these.
 * Full widgets and toolbar/panel actions share this contribution shape; `kind`
 * only controls host sizing/chrome. */
export interface WidgetContributionDescriptor {
  id: string;
  module: string;
  title: string;
  description: string;
  kind: WidgetKind;
  defaultSlot: UiSlot;
  supportedSlots: UiSlot[];
  order?: number;
  category?: string;
  capabilities?: string[];
  /** Preferred size for a newly added widget. It is guidance, not a resize
   * constraint: users may shrink the widget below this size afterward. */
  recommendedSize?: WidgetSize;
  defaultSize?: WidgetSize;
  minSize?: WidgetSize;
  maxSize?: WidgetSize;
  audience?: WidgetAudience;
  showIn?: WidgetAudience[];
  scope?: WidgetScope;
  resizable?: boolean;
  duplicatable?: boolean;
  recommended?: boolean;
  defaultVisible?: boolean;
  /** JSON Schema-shaped, browser-visible per-instance settings metadata. */
  settingsSchema?: JsonObject;
}

export interface UiSlotItem {
  id: string;
  slot: UiSlot;
  order?: number;
  module: string;             // lazy client module key resolved by the shell
  props?: JsonObject;
  requiresCapabilities?: string[];
  platforms?: Array<"web" | "desktop" | "vscode" | "mobile">;
}

export interface UiContributionRegistry {
  addSlot(item: UiSlotItem): Disposable;
  list(slot: UiSlot): UiSlotItem[];
}

// ---------------------------------------------------------------- plugin runtime

export type TrustClass = "ui-only" | "pure" | "workspace" | "network" | "device" | "privileged" | "credentialed";

export interface PluginManifest {
  id: string;
  version: string;
  trust: TrustClass;
  provides?: string[];        // capability ids
  requires?: string[];
  optionalRequires?: string[];
  /** Optional UI surface. Omitted/empty means this plugin has no widgets. */
  widgets?: WidgetContributionDescriptor[];
}

export interface PluginContext {
  provide<T>(key: CapabilityKey<T>, value: T, priority?: number): Disposable;
  inject<T>(key: CapabilityKey<T>): T;                     // throws if missing
  optional<T>(key: CapabilityKey<T>): T | undefined;
  on(event: string, cb: (payload: never) => void): Disposable;
  emit(event: string, payload: JsonObject): void;
  waterfall<T>(event: string, value: T): Promise<T>;       // serial reduce through listeners
  effect(disposer: () => void | Promise<void>): void;      // owned by plugin scope
  contribute(item: UiSlotItem): Disposable;
  config<T = JsonObject>(): T;
  scope(
    id: string,
    opts?: { config?: JsonObject; capabilities?: Array<CapabilityKey<unknown>> },
  ): PluginContext;                                        // child scope
  log(level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject): void;
}

export interface Plugin<TConfig = JsonObject> {
  manifest: PluginManifest;
  setup(ctx: PluginContext, config: TConfig): void | Promise<void>;
}

// ---------------------------------------------------------------- terminal (M3)

export interface TerminalCreateInput {
  projectId: string;
  /** override cwd; defaults to the project path (UI passes a session's worktreePath here) */
  cwd?: string;
  /** command to run; omitted = interactive shell */
  cmd?: string;
  /** when set, terminal/created|closed events are appended to this session's log */
  sessionId?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  projectId: string;
  createdAt: number;
  running: boolean;
  /** Set once the process has exited (F12: exited-but-not-closed terminals stay listed). */
  exitCode?: number | null;
}

export interface TerminalCreatedData {
  terminalId: string;
  projectId: string;
  cwd: string;
  cmd?: string;
}

export interface TerminalClosedData {
  terminalId: string;
  projectId: string;
  exitCode: number | null;
}

// ================================================================ parity contracts (WP1)
// All additions below are optional/additive: old event logs, JSON stores and
// clients keep working; unknown events stay ignorable.

// ---------------------------------------------------------------- delivery & queue (WP3)

export type DeliveryMode = "normal" | "steer" | "queue" | "interrupt";

export interface QueueItemDto {
  id: string;
  sessionId: string;
  position: number;
  text: string;
  delivery: DeliveryMode;
  createdAt: number;
  /** Preserved across queueing so deferred sends keep their attachments. */
  attachments?: AttachmentRef[];
  /** A fenced prior-epoch admission is a draft for explicit review, never dispatchable. */
  heldForReview?: boolean;
}

export interface QueueEnqueuedData { queueId: string; text: string; delivery: string }
export interface QueueDispatchedData { queueId: string }
export interface QueueEditedData { queueId: string; text: string }
export interface QueueReorderedData { ids: string[] }
export interface QueueRemovedData { queueId: string }
export interface DeliverySteeredData { text: string }
export interface DeliveryFallbackQueuedData { queueId: string; reason: string }

export interface SendResult {
  turnId?: string;
  queueId?: string;
  queued?: boolean;
}

export interface ShellTurnResult {
  callId: string;
  status: "pending" | "completed" | "rejected";
  requestId?: string;
}

// ---------------------------------------------------------------- editor & files (WP4/WP6)

export interface EditorLocation { path: string; startLine?: number; endLine?: number; column?: number }

export interface FileStatDto {
  path: string;
  kind: "file" | "dir";
  size: number;
  mime?: string;
  revision?: string;
}

export type FileRenderKind = "text" | "markdown" | "html" | "json" | "binary";

// ---------------------------------------------------------------- tasks & subagents (WP8)

export type TaskItemStatus = "pending" | "active" | "done" | "failed";
export interface TaskSnapshotData {
  listId: string;
  revision: number;
  items: Array<{ id: string; text: string; status: TaskItemStatus }>;
}
export interface SubagentSnapshotData {
  revision: number;
  agents: Array<{ sessionId: string; label: string; status: string; currentTask?: string }>;
}

// ---------------------------------------------------------------- agent profiles (WP8)

export interface AgentProfile {
  id: string;
  name: string;
  providerID: string;
  modelID: string;
  agent?: string;
  mode?: string;
  thinking?: string;
  features: Record<string, boolean>;
  notes?: string;
  icon?: string;
  color?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface AgentProfileSeed { providerID: string; modelID: string; name?: string }
export interface AgentProfileRepair { field: string; from: string; to: string; reason: string }

// ---------------------------------------------------------------- system info (WP9)

export interface SystemInfoDto {
  version: string;
  applicationUrl: string;
  tunnelUrl: string | null;
  dataDirLabel: string;
  capabilities: string[];
}

// ---------------------------------------------------------------- folders & labels (WP5/WP18)

export interface SessionFolderDto {
  id: string;
  projectId: string;
  parentId?: string;
  name: string;
  position: number;
  revision: number;
}

export interface WorkspaceLabel {
  id: string;
  name: string;
  color: string;
  position: number;
  revision: number;
}

export interface BulkSessionResult {
  succeeded: string[];
  failed: Array<{ id: string; code: string }>;
}

// ---------------------------------------------------------------- pane surfaces (WP6)

export interface WorkspaceSurface {
  id: string;
  title: string;
  icon: string;
  placement: "main" | "right" | "either";
  singleton: boolean;
  keepAlive?: boolean;
  module: string;
  requiresCapabilities?: string[];
}

export interface PaneTabState {
  instanceId: string;
  surfaceId: string;
  resource?: string;
  title?: string;
  dirty?: boolean;
}

// ---------------------------------------------------------------- schedule cadence (WP10)

export type ScheduleCadence =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMinutes: number }
  | { kind: "cron"; expression: string; timeZone: string };

export interface ScheduleTarget {
  mode: "existing-session" | "new-session-per-run" | "dedicated-session";
  sessionId?: string;
  worktreePolicy?: "project-root" | "fresh-worktree";
}

export type ScheduleOverlapPolicy = "skip" | "queue" | "parallel";

export interface ScheduleRunDto {
  runId: string;
  taskId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed" | "skipped";
  error?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------- knowledge (WP10)

export type KnowledgeKind = "note" | "spec" | "plan" | "memory";
export interface KnowledgeItem {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  source: "user" | "agent" | "import";
  sourceSessionId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface KnowledgeAttachedData {
  knowledgeId: string;
  revision: number;
  title: string;
  body: string;
  digest: string;
}

// ---------------------------------------------------------------- spec-driven tracks

export type TrackStatus = "draft" | "running" | "blocked" | "completed";
export type TrackStepStatus = "pending" | "running" | "failed" | "completed";

export interface TrackTestResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** Bounded tail of the test output. */
  output: string;
  completedAt: number;
}

export interface TrackStepDto {
  id: string;
  title: string;
  prompt: string;
  testCommand: string;
  commitMessage?: string;
  status: TrackStepStatus;
  sessionId?: string;
  scheduleTaskId?: string;
  startedAt?: number;
  completedAt?: number;
  commitSha?: string;
  test?: TrackTestResult;
  error?: string;
}

export interface TrackDto {
  id: string;
  projectId: string;
  title: string;
  status: TrackStatus;
  specKnowledgeId: string;
  planKnowledgeId: string;
  planRevision: number;
  steps: TrackStepDto[];
  currentStep: number;
  sessionId?: string;
  budgetTokens?: number;
  maxContinuations?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TrackStepInput {
  title: string;
  prompt?: string;
  testCommand: string;
  commitMessage?: string;
}

export interface TrackCreateInput {
  projectId: string;
  title: string;
  spec: string;
  steps: TrackStepInput[];
  budgetTokens?: number;
  maxContinuations?: number;
}

// ---------------------------------------------------------------- quotas (WP12)

export interface QuotaWindow {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: "tokens" | "requests" | "currency" | "percent";
  resetsAt?: number;
  periodMs?: number;
}

export interface QuotaSnapshot {
  providerId: string;
  accountLabel?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  stale: boolean;
  error?: { code: string; message: string };
}

export interface QuotaPace {
  usageFraction: number;
  timeFraction: number;
  pace: "under" | "on-track" | "over";
  predictedAtReset?: number;
  exhaustsAt?: number;
}

// ---------------------------------------------------------------- review & walkthrough (WP11)

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  path?: string;
  line?: number;
  body: string;
  confidence: number;
}
export interface ReviewAssessment {
  summary: string;
  findings: ReviewFinding[];
  riskScore: 1 | 2 | 3 | 4 | 5;
  confidenceScore: 1 | 2 | 3 | 4 | 5;
}

export type WalkthroughSource =
  | { kind: "working-tree"; projectId: string }
  | { kind: "range"; projectId: string; base: string; head: string }
  | { kind: "pull-request"; projectId: string; number: number };

export interface GeneratedWalkthroughStop {
  id: string;
  path: string;
  hunkDigest: string;
  diff: string;
  explanation: string;
}
export interface GeneratedWalkthroughStage {
  id: string;
  title: string;
  explanation: string;
  stops: GeneratedWalkthroughStop[];
}
export interface GeneratedWalkthroughDto {
  id: string;
  source: WalkthroughSource;
  sourceDigest: string;
  status: "queued" | "running" | "ready" | "failed";
  stages: GeneratedWalkthroughStage[];
  error?: string;
  createdAt: number;
}

export type CheckStatus =
  | "queued" | "in_progress" | "success" | "failure" | "cancelled"
  | "skipped" | "neutral" | "timed_out" | "action_required";
export interface PrCheck {
  id: string;
  name: string;
  workflow?: string;
  status: CheckStatus;
  startedAt?: string;
  completedAt?: string;
  url?: string;
  summary?: string;
}

export interface ReviewFlowState {
  id: string;
  sessionId: string;
  status: "idle" | "implementing" | "awaiting-review" | "reviewing" | "passed" | "changes-requested" | "failed" | "paused" | "stopped";
  iteration: number;
  maxIterations: number;
  baseDigest: string;
  latestReviewId?: string;
  stoppedReason?: string;
}

// ---------------------------------------------------------------- MCP & plugins (WP9)

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { kind: "http"; url: string; headersSecretRefs: string[] };

export type McpStatus = "disabled" | "starting" | "connected" | "error";

export interface McpServerDto {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpStatus;
  lastError?: string;
  revision: number;
}

/** One entry in OpenCode's `plugin` config array. Tuple entries carry the
 * plugin's JSON-serializable options without exposing Polyth's managed-plugin
 * installation surface. */
export type OpenCodePluginConfigEntry = string | [string, JsonObject];

export interface OpenCodePluginEntryDto {
  spec: string;
  options?: JsonObject;
}

/** Pure paste-parser result used by the settings preview. */
export interface OpenCodePluginPreviewDto {
  entries: OpenCodePluginEntryDto[];
  errors: string[];
  /** Top-level config keys intentionally not imported in this v1 flow. */
  ignoredKeys: string[];
}

export interface OpenCodePluginListResponseDto {
  plugins: OpenCodePluginEntryDto[];
}

export interface OpenCodePluginImportRequestDto {
  plugins: OpenCodePluginConfigEntry[];
}

export interface OpenCodePluginImportResponseDto extends OpenCodePluginListResponseDto {
  imported: string[];
  pendingRestart: true;
}

export interface OpenCodePluginRemoveResponseDto extends OpenCodePluginListResponseDto {
  removed: boolean;
  pendingRestart: boolean;
}

export type OpenCodePendingChangeKind =
  | "agent"
  | "behavior"
  | "mcp"
  | "plugins"
  | "provider-visibility";

export interface OpenCodePendingChangeDto {
  id: string;
  kind: OpenCodePendingChangeKind;
  label: string;
}

export interface OpenCodePendingResponseDto {
  changes: OpenCodePendingChangeDto[];
  count: number;
}

export interface OpenCodeApplyRestartResponseDto {
  applied: number;
  restarted: number;
}

// ---------------------------------------------------------------- Secure Safe (OC-22-008)

export type SecureSafeKind = "env" | "token" | "password";
export type SecureSafeScope = "global" | "project";

/** Public metadata only. Secret values never cross this contract boundary. */
export interface SecureSafeEntryDto {
  id: string;
  handle: string;
  label: string;
  purpose: string;
  kind: SecureSafeKind;
  scope: SecureSafeScope;
  projectId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SecureSafeManifest {
  version: number;
  handles: Array<{
    handle: string;
    label: string;
    purpose: string;
    kind: SecureSafeKind;
    envRef: string;
  }>;
}

export interface SecureSafeCreateInput {
  handle: string;
  label: string;
  purpose?: string;
  kind?: SecureSafeKind;
  scope?: SecureSafeScope;
  projectId?: string;
  value: string;
}

export interface SecureSafePatchInput {
  handle?: string;
  label?: string;
  purpose?: string;
  kind?: SecureSafeKind;
  scope?: SecureSafeScope;
  projectId?: string | null;
  /** Missing or blank retains the current write-only value. */
  value?: string;
}

export interface SecureSafeService {
  list(): SecureSafeEntryDto[];
  manifest(): SecureSafeManifest;
  hasHandle(handle: string): boolean;
  create(input: SecureSafeCreateInput): Promise<SecureSafeEntryDto>;
  update(id: string, patch: SecureSafePatchInput): Promise<SecureSafeEntryDto>;
  remove(id: string): Promise<boolean>;
  upsertByHandle(input: SecureSafeCreateInput): Promise<SecureSafeEntryDto>;
  syncForbiddenConfig(): Promise<SecureSafeManifest>;
}

export interface InstalledPluginDto {
  id: string;
  name: string;
  version: string;
  source: string;
  trust: TrustClass;
  enabled: boolean;
  status: "installed" | "loading" | "ready" | "error" | "disabled";
  update?: { version: string };
  capabilities: string[];
  contributions: UiSlotItem[];
  /** Widget declarations owned by this plugin; absent on older registries. */
  widgets?: WidgetContributionDescriptor[];
  /** Browser-safe URL and content hash for the install-time UI bundle. */
  ui?: { url: string; integrity: string };
  lastError?: string;
}

// ---------------------------------------------------------------- browser (WP14)

export type BrowserColorScheme = "light" | "dark" | "no-preference";

export interface BrowserSessionDto {
  id: string;
  projectId: string;
  sessionId?: string;
  url: string;
  title: string;
  status: "starting" | "ready" | "closed" | "failed";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  colorScheme: BrowserColorScheme;
  revision: number;
  /** honest engine state: "chromium" when driven, "unavailable" for fallback */
  engine: "chromium" | "fake" | "unavailable";
}

export type BrowserTarget =
  | { selector: string }
  | { text: string; exact?: boolean }
  | { role: string; name?: string; exact?: boolean }
  | { point: { x: number; y: number }; frameRevision: number };

export type BrowserAction =
  | { kind: "click"; target: BrowserTarget }
  /** Resolve the DOM element under a revisioned screenshot point without
   * interacting with it. Used by the user-facing element picker. */
  | { kind: "point"; target: Extract<BrowserTarget, { point: unknown }> }
  | { kind: "type"; target: BrowserTarget; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x?: number; y?: number; target?: BrowserTarget }
  | { kind: "select"; target: BrowserTarget; value: string }
  | { kind: "wait"; condition: "network-idle" | "selector"; value?: string; timeoutMs?: number }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "resize"; viewport: { width: number; height: number } }
  | { kind: "color-scheme"; colorScheme: BrowserColorScheme }
  | { kind: "inspect"; selector: string };

export interface BrowserObservation {
  url: string;
  title: string;
  text: string;
  accessibilityDigest?: string;
  screenshotRef?: string;
}

// ---------------------------------------------------------------- dictation (WP15)

export interface DictationSessionDto {
  id: string;
  sessionId?: string;
  status: "starting" | "recording" | "finalizing" | "done" | "failed";
  format: { encoding: "pcm_s16le"; sampleRate: number; channels: number };
  acknowledgedSeq: number;
  transcript: string;
}

// ---------------------------------------------------------------- commands / settings / shortcuts (WP9/WP13)

export interface CommandDescriptor {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  defaultShortcut?: string[];
  when?: string;
  requiresCapabilities?: string[];
}

export interface SettingsSearchItem {
  id: string;
  pageId: string;
  label: string;
  description?: string;
  keywords?: string[];
  focusTarget: string;
}

export interface SettingsPageMeta {
  label: string;
  group: PackageSettingsGroup;
  icon?: string;
  settingsItems?: SettingsSearchItem[];
  /** Links the settings page to its package enablement state. */
  packageId?: string;
}

export interface ShortcutBinding {
  commandId: string;
  sequence: string[];
  when?: string;
}

// ---------------------------------------------------------------- workspace search (WP13)

/** One row of `/api/search/workspaces`: a project or session matched on
 *  metadata only (never transcript bodies). */
export interface WorkspaceSearchItem {
  kind: "project" | "session";
  id: string;
  projectId?: string;
  title: string;
  /** Project: path. Session: "project · branch · status" fragments. */
  subtitle?: string;
  keywords?: string[];
  status?: string;
  updatedAt: number;
  archived?: boolean;
}

export interface FileSearchItem {
  path: string;
  kind: "file" | "dir";
  score: number;
  matches?: Array<[number, number]>;
}

// ---------------------------------------------------------------- notifications (WP15)

export type NotificationKind = "completed" | "failed" | "question" | "permission" | "subagent";
export interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
  kinds: NotificationKind[];
  onlyWhenHidden: boolean;
  template: string;
  summarize: boolean;
}

/** One retained notification-centre row (NTF-01). Derived server state:
 *  never a `SessionEvent`, never model-visible, never in the session log.
 *  `id` is the REST/WS merge identity and mutation handle; `key` is the
 *  stable transition key shared with the push payload (non-unique: a later
 *  identical transition legitimately produces a new row). */
export type NotificationRecord = {
  id: string;
  key: string;
  kind: NotificationKind;
  sessionId: string;
  projectId: string;
  title: string;
  body: string;
  ts: number;
  read: boolean;
};

// Well-known capability keys
export const CAP = {
  sessions: cap<SessionService>("polyth.sessions"),
  sessionPersistence: cap<SessionPersistence>("polyth.sessionPersistence"),
  runtime: cap<AgentRuntime>("polyth.agentRuntime"),
  projects: cap<ProjectService>("polyth.projects"),
  taskTrackers: cap<TaskTrackerService>("polyth.taskTrackers"),
  ui: cap<UiContributionRegistry>("polyth.ui"),
} as const;

/** Capability ids exposed by the composed server to clients and agent
 * sessions. Keeping this normative list in contracts prevents the composition
 * root from accumulating feature-specific declarations. */
export const SERVER_CAPABILITY_IDS = [
  "polyth.sessions",
  "polyth.sessionPersistence",
  "polyth.projects",
  "polyth.agentRuntime",
  "polyth.goals",
  "polyth.files",
  "polyth.commands",
  "polyth.git",
  "polyth.worktrees",
  "polyth.terminal",
  "polyth.multirun",
  "polyth.workflow",
  "polyth.fusion",
  "polyth.walkthrough",
  "polyth.schedule",
  "polyth.tracks",
  "polyth.github",
  "polyth.taskTrackers",
  "polyth.control",
  "polyth.agentProfiles",
  "polyth.settings",
  "polyth.mcp",
  "polyth.plugins",
  "polyth.knowledge",
  "polyth.review",
  "polyth.usage",
  "polyth.browser",
  "polyth.voice",
  "polyth.assist",
  "polyth.homeAssistant",
  "polyth.secureSafe",
  "polyth.ssh",
] as const;
