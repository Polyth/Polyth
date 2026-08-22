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

// Data payloads for the M1 vocabulary (all must stay JSON-serializable)
export interface CompactionRecoveryMetadata {
  compactionSeq: number;
  goalRestored?: boolean;
  pinnedSourceSeqs?: number[];
}
export interface UserMessageData {
  text: string;
  attachments?: AttachmentRef[];
  /** Model-visible recovery instructions kept separate from the visible bubble. */
  recoveryContext?: string;
  /** Durable dedup key proving this compaction was handled by this turn. */
  compactionRecovery?: CompactionRecoveryMetadata;
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
}
export interface MultirunDto { id: string; prompt: string; runs: MultirunRunDto[]; pickedRunId?: string }

export interface MultirunStartedData { multirunId: string; prompt: string; runs: Array<{ runId: string; model?: ModelRef; agent?: string }> }
export interface MultirunRunProgressData { multirunId: string; runId: string; status: MultirunRunStatus; output: string; tokens?: TokenUsage; cost?: number; error?: string }
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
  name: string;
  input: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  layers: string[][];
  nodes: WorkflowRunNodeDto[];
}

export interface WorkflowRunStartedData {
  runId: string;
  workflowId: string;
  name: string;
  input: string;
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
export type FusionStatus = "running" | "completed" | "failed";
export interface FusionDto { id: string; answer: string; weights: FusionWeightDto[]; disagreements: string[]; status: FusionStatus; error?: string }

export interface FusionStartedData { fusionId: string; prompt: string; models: string[] }
export interface FusionCompletedData { fusionId: string; status: FusionStatus; answer: string; weights: FusionWeightDto[]; disagreements: string[]; error?: string }

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

export type SessionStatus = "idle" | "working" | "waiting" | "finished" | "failed" | "archived";

/** Derived unresolved-request counters; always computed from durable events. */
export interface SessionAttention {
  questions: number;
  permissions: number;
  unread: number;
  goalStatus?: string;
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
  events(sessionId: string, afterSeq?: number): Promise<SessionEvent[]>;
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

export interface SessionPersistence {
  append(sessionId: string, type: string, data: JsonObject, opts?: Partial<Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">>): Promise<SessionEvent>;
  events(sessionId: string, afterSeq?: number): Promise<SessionEvent[]>;
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
export interface RuntimeSession { id: string; title: string; parentId?: string; createdAt: number; updatedAt: number }
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
  | { type: "assistant/chunk"; partId: string; text: string }
  | { type: "assistant/reasoning-chunk"; partId: string; text: string }
  | { type: "assistant/message"; partId: string; text: string; reasoning?: string; tokens?: TokenUsage; cost?: number }
  | { type: "tool/call"; callId: string; tool: string; input: JsonObject }
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
  /** Replace one canonical session's backend history with a fresh backend session. */
  resetSession?(canonical: CreateSessionInput & { sessionId: string; cwd: string }): Promise<string>;
  /** Create a backend session holding EXACTLY the requested canonical history
   *  (native fork at the exact predecessor). Returns the backend child id.
   *  Rejects `history-mismatch` when the read-back child history differs and
   *  `unsupported` when the runtime cannot branch or hydrate exact history —
   *  never approximates with a hidden prompt, summary, or optimistic copy. */
  branchSession?(request: RuntimeBranchRequest): Promise<string>;
  /** Best-effort discard of an unreferenced backend branch after a failed
   *  canonical publication. Never throws for an unknown session. */
  discardSession?(sessionId: string): Promise<void>;
  sessions(): Promise<RuntimeSession[]>;
  history(sessionId: string): Promise<RuntimeSessionMessage[]>;
  startTurn(req: CanonicalTurnRequest): Promise<void>; // events flow via onEvent
  /** Live steering of an active turn. Returns false when unsupported/rejected;
   *  callers must fall back to queueing. Optional so old fakes remain valid. */
  steer?(sessionId: string, text: string): Promise<boolean>;
  abort(sessionId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
  replySecret?(sessionId: string, requestId: string, result: SecretResolvedData): Promise<void>;
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
  groupingMode?: string;
  worktreeBehavior?: "project-root" | "fresh-worktree";
}

export interface Project {
  id: string; path: string; name: string;
  color?: string; icon?: string; createdAt: number;
  defaults?: ProjectDefaults;
  labelIds?: string[];
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
  remove(id: string): Promise<void>;
  get(id: string): Promise<Project | undefined>;
  /** PATCH metadata/defaults; optional so old fakes remain valid. */
  update?(id: string, patch: ProjectPatch): Promise<Project>;
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

// ---------------------------------------------------------------- UI contributions (host + client shared shapes)

/** Canonical slot vocabulary — the runtime list backs `UiSlot` so the
 *  server-managed manifest boundary can reject unknown slot names. */
export const UI_SLOTS = [
  "app.nav", "app.header.actions", "session.header.actions", "session.list.badges",
  "composer.leading", "composer.trailing", "contextRail.tabs",
  "settings.pages", "commandPalette.commands",
  // Widget definitions enter through the catalog/settings seams. The six
  // workspace slots are first-class placement targets alongside panel and
  // toolbar slots, rather than a canvas-only parallel vocabulary.
  "widget.catalog", "widget.settings", "workspace.canvas",
  "workspace.header", "workspace.left", "workspace.main",
  "workspace.right", "workspace.bottom", "workspace.floating",
  // parity slots (WP1): focused seams instead of mega-component imports
  "workspace.main.tabs", "workspace.right.tabs",
  "session.timeline.before", "session.timeline.after", "session.composer.before",
  "session.message.actions",
  "sidebar.project.actions", "sidebar.session.actions",
  "workStatus.sections",
] as const;

export type UiSlot = (typeof UI_SLOTS)[number];

export function isUiSlot(value: string): value is UiSlot {
  return (UI_SLOTS as readonly string[]).includes(value);
}

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

// ---------------------------------------------------------------- preview (M3)

export type PreviewStatus = "off" | "starting" | "running";

export interface PreviewState {
  url: string | null;
  /** Local URLs announced by the process and/or discovered from listeners.
   * `url` is the currently selected reachable candidate. */
  urls?: string[];
  status: PreviewStatus;
  port?: number;
  command?: string;
}

export interface PreviewStartInput {
  projectId: string;
  /** override detected script; run as a shell command with PORT env set */
  command?: string;
  /** explicit port; omitted = OS-assigned free port */
  port?: number;
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
}

export interface QueueEnqueuedData { queueId: string; text: string; delivery: string }
export interface QueueDispatchedData { queueId: string }
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

export type KnowledgeKind = "note" | "plan" | "memory";
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

// Well-known capability keys
export const CAP = {
  sessions: cap<SessionService>("polyth.sessions"),
  sessionPersistence: cap<SessionPersistence>("polyth.sessionPersistence"),
  runtime: cap<AgentRuntime>("polyth.agentRuntime"),
  projects: cap<ProjectService>("polyth.projects"),
  ui: cap<UiContributionRegistry>("polyth.ui"),
} as const;
