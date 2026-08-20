// Polyth public contracts. Type-only. No implementation imports allowed here.
// Erasable TS only (no enums/namespaces) — Node strips types at runtime.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface Disposable { dispose(): void | Promise<void> }

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
export interface UserMessageData { text: string; attachments?: AttachmentRef[] }
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
export interface TurnStartedData { turnId: string; model?: ModelRef; agent?: string }
export interface TurnStoppedData { turnId: string; reason: "completed" | "aborted" | "error"; error?: string }
export interface TokenUsage { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
export interface UsageRecordedData { model: ModelRef; tokens: TokenUsage; cost?: number }
export interface GoalAttachedData { objective: string; budgetTokens?: number; maxContinuations?: number }
export interface GoalAuditData { verdict: "keep" | "done" | "stuck"; consecutiveStuck: number; note?: string }
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
export interface ModelRef { providerID: string; modelID: string }

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
  /** Resolve model/agent/options through a stored agent profile at send time. */
  agentProfileId?: string;
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
  fork(sessionId: string, atSeq?: number): Promise<SessionRef>;
  /** Soft-rewind to a user message without mutating prior events. */
  rewind?(sessionId: string, atSeq: number): Promise<SessionEvent>;
  /** Restore the tail hidden by the active rewind marker. */
  clearRewind?(sessionId: string): Promise<SessionEvent>;
  /** Execute a composer `!` command through the shell permission family. */
  runShell?(sessionId: string, command: string): Promise<ShellTurnResult>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<void>;
  list(projectId?: string): Promise<SessionProjection[]>;
  sync(projectId: string): Promise<SessionProjection[]>;
  snapshot(sessionId: string): Promise<SessionProjection>;
  events(sessionId: string, afterSeq?: number): Promise<SessionEvent[]>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject", scope?: "session" | "project"): Promise<void>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
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

export interface SessionPersistence {
  append(sessionId: string, type: string, data: JsonObject, opts?: Partial<Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">>): Promise<SessionEvent>;
  events(sessionId: string, afterSeq?: number): Promise<SessionEvent[]>;
  latestSeq(sessionId: string): Promise<number>;
  copyTo(srcSessionId: string, dstSessionId: string, upToSeq?: number): Promise<void>;
  upsertProjection(p: SessionProjection): Promise<void>;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  projections(projectId?: string): Promise<SessionProjection[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- agent runtime (backend seam)

export interface ModelDescriptor { providerID: string; modelID: string; name: string; context?: number; cost?: { input: number; output: number }; capabilities?: string[] }
export interface AgentDescriptor { name: string; description?: string; mode: "primary" | "subagent" | "all" }
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

// Runtime events the adapter yields; session service translates + persists them.
export type RuntimeEvent =
  | { type: "turn/started"; turnId: string }
  | { type: "assistant/chunk"; partId: string; text: string }
  | { type: "assistant/reasoning-chunk"; partId: string; text: string }
  | { type: "assistant/message"; partId: string; text: string; tokens?: TokenUsage; cost?: number }
  | { type: "tool/call"; callId: string; tool: string; input: JsonObject }
  | { type: "tool/result"; callId: string; tool: string; output: string; title?: string; metadata?: JsonObject; input?: JsonObject }
  | { type: "tool/error"; callId: string; tool: string; error: string; input?: JsonObject }
  | { type: "permission/requested"; requestId: string; permission: string; patterns: string[]; metadata?: JsonObject; tool?: string }
  | { type: "question/asked"; requestId: string; questions: JsonObject[] }
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
  sessions(): Promise<RuntimeSession[]>;
  history(sessionId: string): Promise<RuntimeSessionMessage[]>;
  startTurn(req: CanonicalTurnRequest): Promise<void>; // events flow via onEvent
  /** Live steering of an active turn. Returns false when unsupported/rejected;
   *  callers must fall back to queueing. Optional so old fakes remain valid. */
  steer?(sessionId: string, text: string): Promise<boolean>;
  abort(sessionId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
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
  agent?: string;
  model?: ModelRef;
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

// ---------------------------------------------------------------- UI contributions (host + client shared shapes)

export type UiSlot =
  | "app.nav" | "session.header.actions" | "session.list.badges"
  | "composer.leading" | "composer.trailing" | "contextRail.tabs"
  | "settings.pages" | "commandPalette.commands"
  // parity slots (WP1): focused seams instead of mega-component imports
  | "workspace.main.tabs" | "workspace.right.tabs"
  | "session.timeline.before" | "session.timeline.after"
  | "session.message.actions"
  | "sidebar.project.actions" | "sidebar.session.actions"
  | "workStatus.sections";

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
  scope(id: string): PluginContext;                        // child scope
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
  lastError?: string;
}

// ---------------------------------------------------------------- browser (WP14)

export interface BrowserSessionDto {
  id: string;
  projectId: string;
  sessionId?: string;
  url: string;
  title: string;
  status: "starting" | "ready" | "closed" | "failed";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  revision: number;
  /** honest engine state: "chromium" when driven, "unavailable" for fallback */
  engine: "chromium" | "fake" | "unavailable";
}

export type BrowserTarget =
  | { selector: string }
  | { role: string; name?: string; exact?: boolean }
  | { point: { x: number; y: number }; frameRevision: number };

export type BrowserAction =
  | { kind: "click"; target: BrowserTarget }
  | { kind: "type"; target: BrowserTarget; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "select"; target: BrowserTarget; value: string }
  | { kind: "wait"; condition: "network-idle" | "selector"; value?: string; timeoutMs?: number };

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
