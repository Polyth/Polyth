// Typed fetch wrappers for every REST endpoint in PLAN.md §5.
import type {
  TokenUsage,
  AgentDescriptor,
  AgentProfile,
  AttachmentRef,
  AuthAttemptDto,
  AutoAcceptDto,
  AutoAcceptSetting,
  BulkSessionResult,
  ClientSettingsDto,
  ClientMutationStatusDto,
  PromptHistoryDto,
  DictationSessionDto,
  ForkResult,
  FusionDto,
  HarnessSelection,
  HarnessSnapshot,
  InstalledPluginDto,
  PackageForkStrategy,
  JsonObject,
  McpServerDto,
  McpTransport,
  ModelDescriptor,
  ModelRef,
  MultirunDto,
  NotificationRecord,
  OpenCodeApplyRestartResponseDto,
  OpenCodePendingResponseDto,
  OpenCodePluginImportRequestDto,
  OpenCodePluginImportResponseDto,
  OpenCodePluginListResponseDto,
  OpenCodePluginRemoveResponseDto,
  PackageConnectionPublicDto,
  PackageDescriptorDto,
  PackageResidueDto,
  ProviderAuthCapabilitiesDto,
  ProviderAuthView,
  SystemInfoDto,
  ReleaseDownloadsDto,
  TrackCreateInput,
  TrackDto,
  Project,
  ProjectCloneInput,
  ProjectPatch,
  ProjectPresentationSettingsDto,
  QueueItemDto,
  MemoryNarrowing,
  ResumeTurnOptions,
  RuntimeDiagnosticsDto,
  RuntimeFeaturesDto,
  RuntimeSession,
  SecureSafeCreateInput,
  SecureSafeEntryDto,
  SecureSafePatchInput,
  SendResult,
  DraftSaveResult,
  SessionDebugDto,
  SessionDeleteOptions,
  SessionEvent,
  SessionFolderDto,
  SessionProjection,
  SessionRef,
  ShellTurnResult,
  SpaceMemberDto,
  SpacesStateDto,
  SshBrowseDto,
  SshConnectionDto,
  SshConnectionInput,
  SshConnectionStatusDto,
  TerminalInfo,
  WalkthroughStepDto,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowRunOptionsDto,
  WorkflowLaunchOptionsDto,
  WorkflowPreferencesDto,
  WorkflowRetryInputDto,
  WorkspaceLabel,
  CreateIsolatedSessionInput,
  IsolationMergeInput,
  IsolationMergeResultDto,
  IsolationRetargetInput,
  IsolationPushResultDto,
  IsolateSessionResultDto,
  IsolationStatusDto
} from "@polyth/contracts";
import { errorBodyText, readErrorDiagnostics } from "@polyth/contracts";
import { fetchWithReadRetry } from "@polyth/contracts/transport-retry";
import type { SourceControlProfileState } from "@polyth/contracts/source-control";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { ChangeRequest, ChangeRequestComment, ChangeRequestDetail, ChangeRequestFile, HostingIssue, HostingIssueComment, HostingIssueDetail, HostingRepository, HostingResult, HostingStatus } from "@polyth/code-hosting/types";

export type { AuthAttemptDto, ProviderAuthCapabilitiesDto, ProviderAuthView };

export interface BrowserSessionDto {
  id: string;
  projectId: string;
  sessionId?: string;
  url: string;
  title: string;
  status: "starting" | "ready" | "closed" | "failed";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  colorScheme: "light" | "dark" | "no-preference";
  revision: number;
  engine: "chromium" | "fake" | "unavailable";
  agentPaused?: boolean;
  controller?: "user" | "agent";
  viewportMode?: "responsive" | "preset" | "custom";
}

/** User navigation can intentionally pause for an origin approval. */
export type BrowserNavigateResponse = BrowserSessionDto | {
  session: BrowserSessionDto | null;
  approval: { origin: string; message: string };
};

export interface BrowserVaultFillRequestDto {
  id: string;
  spaceId?: string;
  browserSessionId: string;
  sessionId: string;
  projectId: string;
  handle: string;
  label: string;
  origin: string;
  selector: string;
  submit: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserVaultFillApprovalDto {
  spaceId: string;
  projectId: string;
  handle: string;
  origin: string;
  grantedAt: number;
}

export type BrowserTargetDto =
  | { selector: string }
  | { text: string; exact?: boolean }
  | { role: string; name?: string; exact?: boolean }
  | { point: { x: number; y: number }; frameRevision: number };

export type BrowserActionDto =
  | { kind: "click"; target: BrowserTargetDto }
  | { kind: "point"; target: Extract<BrowserTargetDto, { point: unknown }> }
  | { kind: "type"; target: BrowserTargetDto; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x?: number; y?: number; target?: BrowserTargetDto }
  | { kind: "select"; target: BrowserTargetDto; value: string }
  | { kind: "wait"; condition: "network-idle" | "selector"; value?: string; timeoutMs?: number }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "resize"; viewport: { width: number; height: number }; mode?: "responsive" | "preset" | "custom" }
  | { kind: "color-scheme"; colorScheme: "light" | "dark" | "no-preference" }
  | { kind: "inspect"; selector: string };

export interface WorkspaceSearchItemDto {
  kind: "project" | "session";
  id: string;
  projectId: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  status?: string;
  archived?: boolean;
  updatedAt: number;
}

export interface FileSearchHitDto {
  repositoryId?: string;
  repositoryAlias?: string;
  path: string;
  kind: "file" | "dir";
  score: number;
  matches: Array<[number, number]>;
}

export type SessionSearchField = "title" | "branch" | "label" | "message";

/** `GET /api/sessions/create-operations/:clientOperationId`. `absent`: nothing
 *  was created under the key yet, so resending the same key is safe. */
export interface SessionCreateOperationStatusDto {
  state: "absent" | "created" | "failed";
  sessionId?: string;
}

export interface SessionSearchMatch {
  field: SessionSearchField;
  snippet: string;
  /** `[start, end)` highlight ranges inside `snippet` (message hits only). */
  ranges?: Array<[number, number]>;
  /** Canonical event seq of a message hit — the reveal target. */
  seq?: number;
  role?: "user" | "assistant";
  time?: number;
}

export interface SessionSearchResult {
  sessionId: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt: number;
  matches: SessionSearchMatch[];
  /** Total ranked transcript hits for this session (may exceed `matches`). */
  messageHits: number;
}

export interface SessionSearchOptions {
  projectId?: string;
  role?: "user" | "assistant";
  limit?: number;
}

// ---- host directory browsing (project folder picker; server-host route) ------
export interface BrowseEntryDto {
  name: string;
  path: string;
  modifiedAt?: number;
  hidden: boolean;
}
export interface BrowseResultDto {
  path: string;
  parent: string | null;
  home: string;
  entries: BrowseEntryDto[];
}

// ---- provider/model visibility (Providers & Models settings) ----------------
export interface ProviderCatalogModelDto {
  providerID: string;
  modelID: string;
  key: string;
  name: string;
  providerName?: string;
  context?: number;
  cost?: { input: number; output: number };
  capabilities?: string[];
  variants?: string[];
  connected: boolean;
  enabled: boolean;
}
export interface ProviderCatalogDto {
  id: string;
  name: string;
  origin?: "builtin" | "custom" | "externally-configured";
  connected: boolean;
  enabled: boolean;
  configured?: boolean;
  editable?: boolean;
  removable?: boolean;
  status?: "ready" | "needs-setup" | "disabled";
  hasCredential?: boolean;
  models: ProviderCatalogModelDto[];
  custom?: {
    protocol: "openai-compatible" | "openai-responses";
    baseURL: string;
    authMode?: "api-key" | "none";
    hasHeaders: boolean;
    headerNames?: string[];
    modelIDs?: string[];
  };
}
export interface VisibilityStateDto {
  ok: boolean;
  disabledProviders: string[];
  disabledModels: string[];
  addedProviders: Array<{ id: string; name?: string; origin?: "builtin" | "custom" | "externally-configured" }>;
}
export interface AvailableProviderDto {
  id: string;
  name: string;
}

export async function sessionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // A read that lost its socket (phone back from the background) asks again
  // before surfacing "connection lost"; mutations are still sent exactly once.
  const res = await fetchWithReadRetry(fetch, path, init);
  if (!res.ok) {
    // A 401 outside the auth endpoints means the device session is gone
    // (revoked, expired, or a password was just set) — surface the lock screen.
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
    const body = await res.text().catch(() => "");
    // Typed server errors ({error, message}) keep their code and message so
    // callers can explain conflicts/history mismatches without regexing HTML.
    let code: string | undefined;
    let message: string | undefined;
    let details: string | undefined;
    let field: string | undefined;
    let changes: number | undefined;
    let sessionId: string | undefined;
    let diagnostics = {};
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; details?: unknown; field?: unknown; changes?: unknown; sessionId?: unknown };
      diagnostics = readErrorDiagnostics(parsed);
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") message = parsed.message;
      if (typeof parsed.details === "string") details = parsed.details;
      if (typeof parsed.field === "string") field = parsed.field;
      if (typeof parsed.changes === "number") changes = parsed.changes;
      if (typeof parsed.sessionId === "string") sessionId = parsed.sessionId;
    } catch {
      // non-JSON error body
    }
    // A gateway/proxy body is an HTML page; never embed its tag soup. Use its
    // own summary text, and fall back to the status line when the page carries
    // no readable text.
    const bodyDetail = errorBodyText(body);
    const fallback = bodyDetail
      // A gateway page title already carries the status ("504 Gateway
      // Time-out"); prefixing it again just repeats the code.
      ? bodyDetail.startsWith(String(res.status))
        ? bodyDetail
        : tr("api.httpErrorValueValueValue", {
          status: res.status,
          statusText: res.statusText,
          body: bodyDetail,
        })
      : tr("api.httpStatusValue", { status: res.status });
    throw Object.assign(
      new Error(message ?? fallback),
      {
        ...diagnostics,
        status: res.status,
        ...(code !== undefined ? { code } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(field !== undefined ? { field } : {}),
        ...(changes !== undefined ? { changes } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const jfetch = sessionFetch;

export const httpStatusOf = (err: unknown): number =>
  typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 0;

/** Typed error code from a server error body (e.g. "conflict", "history-mismatch"). */
export const errorCodeOf = (err: unknown): string =>
  typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";

// Read-only Git lists degrade to an empty catalog when the optional route or
// project is gone; mutations still reject so a failed action cannot look safe.
const emptyOnNotFound = <T>(request: Promise<T>, empty: T): Promise<T> =>
  request.catch((error) => httpStatusOf(error) === 404 || errorCodeOf(error) === "not-found"
    ? empty
    : Promise.reject(error));

/** Dirty-worktree refusal may include a porcelain change count for the confirm copy. */
export const errorChangesOf = (err: unknown): number =>
  typeof (err as { changes?: unknown }).changes === "number"
    ? (err as { changes: number }).changes
    : 0;

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const pendingMutation = <T>(request: Promise<T>): Promise<T> =>
  request.then((value) => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("polyth:opencode-pending"));
    return value;
  });

export interface Health {
  ok: boolean;
  version: string;
  capabilities: string[];
}

// ---- git types (§12) -------------------------------------------------------
export interface GitFileEntry {
  path: string;
  status: string;
  staged: boolean;
  origPath?: string;
}
/** A checkout's own Git identity as Polyth manages it (`/api/git/identity`). */
export interface GitCheckoutIdentity {
  name: string;
  email: string;
  /** Private key Polyth set as `core.sshCommand`, if any. */
  sshKey?: string | null;
  /** SSH public key Polyth set up for commit signing, if any. */
  signingKey?: string | null;
  /** Polyth hid the host's credential helpers and SSH keys from this checkout. */
  anonymous?: boolean;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  /** Configured tracking ref, when the branch has one. */
  upstream?: string;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  clean?: boolean;
  /** Explicit false for plain folders; omitted by older servers. */
  isRepo?: boolean;
}
export interface GitDiffResult { path: string; diff: string; snapshotDigest?: string }
export interface GitBranches {
  current: string | null;
  branches: Array<{ name: string; current: boolean; remote?: string }>;
}
export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}
export interface GitGraphEntry extends GitLogEntry {
  parents: string[];
  refs: string[];
}
export interface GitStash {
  ref: string;
  sha: string;
  message: string;
  date: string;
}

// ---- worktree types --------------------------------------------------------
export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  /** Present only for `listWorktrees(projectId, { status: true })`, and only
   *  for checkouts Git could describe. Absent means unknown, never zero. */
  ahead?: number;
  behind?: number;
  changed?: number;
  conflicted?: number;
  upstream?: string;
}

export type GitMergeResult =
  | { ok: true; alreadyUpToDate: boolean; fastForward: boolean; head: string }
  | { ok: false; conflicted: string[] };

/** Which checkout a Git call acts on. A session scopes to that session's
 *  worktree; `worktreePath` names a checkout of the same project directly and
 *  is validated server-side against Git's own worktree list. */
export interface GitScope {
  sessionId?: string;
  worktreePath?: string;
  repositoryId?: string;
}

const scoped = (scope?: GitScope): Record<string, string> => ({
  ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
  ...(scope?.worktreePath ? { worktreePath: scope.worktreePath } : {}),
  ...(scope?.repositoryId ? { repositoryId: scope.repositoryId } : {}),
});

// ---- file types (§12) ------------------------------------------------------
export interface FileContentSearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface FileContentSearchResult {
  hits: FileContentSearchHit[];
  truncated: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  /** Last modification time (epoch ms); absent from older or remote servers. */
  mtime?: number;
  /** Git-ignored (advisory; the tree may hide these rows). */
  ignored?: boolean;
}
export interface FileReadResult {
  path: string;
  content: string;
  truncated: boolean;
  tooLarge?: boolean;
  revision?: string;
}

// ---- command / snippet types (§12) -----------------------------------------
export interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
  agent?: string;
  model?: string;
  scope: "user" | "project" | "builtin";
  id?: string;
  owner?: "builtin" | "user" | "project";
  kind?: "command" | "skill";
  skillScope?: import("@polyth/contracts/capability-installations").SkillScope;
}
export interface SnippetDef {
  alias: string;
  text: string;
  scope: "user" | "project";
}
export interface CommandListResult {
  commands: SlashCommand[];
  snippets: SnippetDef[];
}
export type SkillScope = "project-opencode" | "user-opencode" | "project-claude" | "user-claude" | "project-agents" | "user-agents";
export interface AgentSkillDef {
  name: string;
  description: string;
  instructions: string;
  scope: SkillScope;
}

/** Strict list outcome: a request failure is never
 *  presented as a successful empty list. */
export type StrictListResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; reason: string };

export interface ComposerCatalogResult {
  commands: StrictListResult<SlashCommand>;
  snippets: StrictListResult<SnippetDef>;
}

// ---- schedule types --------------------------------------------------------
export type ScheduleCadenceDto =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMinutes: number }
  | { kind: "cron"; expression: string; timeZone: string };

export interface ScheduleTargetDto {
  mode: "existing-session" | "new-session-per-run" | "dedicated-session";
  sessionId?: string;
  worktreePolicy?: "project-root" | "fresh-worktree";
}

export interface ScheduleRunDto {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  /** `running` lasts until the agent's turn really stops; `unknown` = the
   *  outcome could not be confirmed and the run is never replayed. */
  status: "running" | "ok" | "failed" | "skipped" | "unknown";
  error?: string;
  sessionId?: string;
  /** Fired after its due time passed while Polyth was not running. */
  late?: boolean;
  trigger?: "schedule" | "manual" | "event" | "heartbeat";
  /** The person's words (only theirs). */
  input?: string;
  /** Event wakes: the wake script's note. It may quote event data, so it is
   *  never shown or treated as the person's words. */
  note?: string;
  /** Event wakes: one line per event that started this run. */
  events?: string[];
  chainDepth?: number;
  /** Approval requests in this run's session that wait for a person. */
  waiting?: Array<{ requestId: string; kind: "permission" | "question"; title: string; since: number }>;
  /** Journal note: the agent's final message of this run (bounded). */
  summary?: string;
  tokens?: TokenUsage;
  cost?: number;
  /** Why a rolling agent started a new session for this run. */
  rotated?: "instructions-changed" | "context-full" | "compacted";
  /** What the run's report says: quiet (filed silently), update, alert. */
  signal?: AgentSignalDto;
  headline?: string;
  /** Notes this run added to the notebook. */
  remembered?: string[];
  /** The person's verdict on this run's report. */
  feedback?: { verdict: "up" | "down"; note?: string; at: number; delivered?: boolean };
  /** The person stopped this run. */
  stopped?: boolean;
  /** 1-based backup model that served the run when the main one could not. */
  backup?: number;
  /** The run went on in a session an earlier run already used: the rolling
   *  conversation, or the exchange the person's message follows up. */
  continued?: boolean;
  /** The run carried the person's words (or rotated a rolling agent) yet
   *  started a new session: why. */
  fresh?: AgentFreshReasonDto;
  /** Files the person attached to the message that started this run. */
  attachments?: AgentRunAttachmentDto[];
  /** While running: the newest step the agent took, read from its session. */
  activity?: AgentRunActivityDto;
  /** Tool steps taken: so far while running, in all once finished. */
  steps?: number;
}

/** What the person asked for with a message: `auto` lets the agent judge. */
export type AgentContinuationDto = "auto" | "continue" | "new";
/** Why a run started a new session when it could have continued one. */
export type AgentFreshReasonDto =
  | "asked" | "idle" | "instructions-changed" | "context-full" | "compacted" | "unavailable" | "none";
export interface AgentRunAttachmentDto {
  name: string;
  mime: string;
  size: number;
  kind?: "file" | "image";
  /** Project-relative path of the uploaded copy (under `_inbox/`). */
  path?: string;
}
/** A run's newest step. `tool`: the tool and a bounded copy of its input
 *  (strings clipped, large values dropped); `text`/`thinking`: the newest
 *  line the agent wrote. */
export interface AgentRunActivityDto {
  kind: "tool" | "text" | "thinking";
  /** Stable for one step (its tool call or message part) while its words
   *  grow; a new step has a new id. */
  id?: string;
  /** When the step began. */
  at: number;
  tool?: string;
  input?: Record<string, string | number | boolean>;
  text?: string;
}
/** Where the person's next message goes. With `sessionId`, it continues that
 *  conversation (until `until`, when one applies); without, it starts a new
 *  one for `reason`. */
export interface AgentFollowUpDto {
  sessionId?: string;
  /** When that conversation last moved. */
  at?: number;
  /** After this the next message starts a new conversation; null = no limit. */
  until?: number | null;
  reason?: AgentFreshReasonDto;
}
/** A message from the person waiting for the run in progress. */
export interface AgentQueuedMessageDto {
  text: string;
  at: number;
  attachments?: number;
  /** The person chose where it goes; absent = the agent judges (`followUp`). */
  continuation?: Exclude<AgentContinuationDto, "auto">;
  /** The conversation the waiting run will go on in, fixed when the message
   *  queued (what the page promised then); absent = it starts a new one. */
  sessionId?: string;
}

export type AgentSignalDto = "quiet" | "update" | "alert";
export type AgentNotifyPolicyDto = "alerts" | "updates" | "off";
/** Light, frequent checks inside the agent's rolling conversation. Active
 *  hours are minutes after local midnight (end exclusive; may wrap). */
export interface AgentHeartbeatDto {
  everyMinutes: number;
  activeFrom?: number;
  activeTo?: number;
  timeZone: string;
  checklist: string;
}

export type AgentColorDto = "neutral" | "blue" | "green" | "amber" | "purple" | "red";
export interface AgentBudgetDto {
  runsPerDay?: number;
  tokensPerDay?: number;
  costPerDay?: number;
}
/** Planner tasks are agents: `title` is the name, `prompt` the charter and
 *  `target.mode` the context policy (new-session-per-run = fresh,
 *  dedicated-session = rolling, existing-session = one chosen session). */
/** How much an agent's sessions may do unasked; absent = inherited. */
export type AgentPermissionLevelDto = "ask" | "routine" | "all";
export interface AgentFieldsDto {
  description?: string;
  icon?: string;
  color?: AgentColorDto;
  manualOnly?: boolean;
  rotateAt?: number;
  budget?: AgentBudgetDto;
  pauseAfterFailures?: number;
  eventTriggers?: AgentEventTriggerDto[];
  approvals?: AgentApprovalPolicyDto;
  whenFull?: "new-session" | "compact";
  keepWarm?: "off" | "auto";
  warmPings?: number[];
  heartbeat?: AgentHeartbeatDto;
  /** Durable notes the agent keeps; the person may edit them. */
  notebook?: string;
  /** Which finished runs notify the person. Absent = alerts only. */
  notify?: AgentNotifyPolicyDto;
}
export interface AgentContextDto {
  mode: "rolling" | "session" | "fresh";
  rotateAt: number;
  whenFull: "new-session" | "compact";
  session: null | {
    id: string;
    title: string;
    status: string;
    fraction?: number;
    usedTokens?: number;
    limitTokens?: number;
    compactedAt?: number;
    telemetry: string;
  };
  layers: { charter: number; journal: number; wake: number };
  cache: {
    telemetry: "measured" | "none" | "unknown";
    runs: Array<{ runId: string; at: number; input: number; read: number; write: number; ratio: number | null }>;
    ttlMs: number | null;
    lastActivityAt: number | null;
  };
  warm: {
    reason: "off" | "not-rolling" | "no-schedule" | "no-telemetry" | "unknown-ttl" | "within-ttl" | "too-far" | "wait" | "due";
    ttlMs?: number;
    pings?: number;
    pingCost?: number;
    coldCost?: number;
    nextPingAt?: number;
    pings24h: number;
  };
}
export interface AgentEventFilterDto {
  field: string;
  op: "equals" | "not-equals" | "contains" | "not-contains";
  value: string;
}
export interface AgentPaceDto {
  quietMs: number;
  coalesce: "latest" | "batch";
  maxPerHour: number;
}
/** `script`: optional body of `function (events, agent)` run in a sandbox
 *  after the pace; returns { action: "run" | "skip" | "pause" }. */
interface AgentTriggerBaseDto { id: string; filters?: AgentEventFilterDto[]; pace?: AgentPaceDto; script?: string }
export type AgentEventTriggerDto =
  | AgentTriggerBaseDto & { kind: "session"; on: Array<"completed" | "failed" | "stopped"> }
  | AgentTriggerBaseDto & { kind: "agent"; agentId: string; on: Array<"ok" | "failed"> }
  /** `hasToken`: the server holds this wake's URL (shown only once, on creation). */
  | AgentTriggerBaseDto & { kind: "webhook"; hasToken?: boolean }
  | AgentTriggerBaseDto & { kind: "integration"; source: string; on: string[] };
export interface AgentScriptTestDto {
  /** Recent matching events the script was given; 0 = nothing to test with. */
  events: number;
  result?: { ok: true; decision: { action: "run"; note?: string } | { action: "skip" | "pause"; reason?: string }; ms: number } | { ok: false; error: string; ms: number };
}
export interface AgentEventSourceDto {
  id: string;
  label: string;
  types: Array<{ id: string; label: string }>;
}
export interface AgentApprovalPolicyDto {
  timeoutMinutes: number;
  onTimeout: "wait" | "reject" | "stop";
}
export interface AgentEventLogEntryDto {
  at: number;
  triggerId: string;
  outcome: "fired" | "rate-limited" | "chain-limit" | "budget" | "busy" | "overlap" | "script-skip" | "script-pause" | "script-error";
  count: number;
  text?: string;
}
export interface AgentTriggerPreviewDto {
  events: number;
  wakes: number;
  samples: Array<{ at: number; text: string }>;
  /** Dry run: the latest events of this kind and why each would (not) wake the agent. */
  recent?: Array<{ at: number; text: string; matched: boolean; reason?: "own" | "source" | "outcome" | "filter"; filter?: AgentEventFilterDto }>;
}
export interface AgentDraftDto {
  name: string;
  description: string;
  charter: string;
  icon: string;
  schedule: ScheduleCadenceDto | null;
  context: "fresh" | "rolling";
}

export interface ScheduleTaskDto extends AgentFieldsDto {
  id: string;
  projectId: string;
  sessionId?: string;
  title?: string;
  prompt: string;
  kind: "at" | "every" | "cron";
  at?: number;
  everyMinutes?: number;
  cadence?: ScheduleCadenceDto;
  target?: ScheduleTargetDto;
  overlapPolicy?: "skip" | "queue" | "parallel";
  /** A run missed while Polyth was not running: fire once late (default) or skip. */
  catchUp?: "once" | "skip";
  /** Harness-qualified execution model chosen for the run. */
  model?: ModelRef & { harnessId?: string };
  /** Explicit execution harness. Absent inherits the target/default route. */
  harness?: HarnessSelection;
  /** Harness-qualified backups, highest priority first. */
  fallbackModels?: Array<ModelRef & { harnessId: string }>;
  permissions?: AgentPermissionLevelDto;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastError?: string;
  lastSessionId?: string;
  nextRunAt: number | null;
  runs: number;
  source?: "ui" | "loop-file";
  sourcePath?: string;
  parseError?: string;
  loopId?: string;
  tripped?: { reason: "budget" | "failures"; message: string; at: number };
  eventLog?: AgentEventLogEntryDto[];
  /** Newest-first bounded run history (journal). */
  history?: ScheduleRunDto[];
  nextBeatAt?: number | null;
  lastBeatAt?: number;
  notebookUpdatedAt?: number;
  notebookEditedBy?: "user" | "agent";
  /** The person last read the diary at this time. */
  seenAt?: number;
  /** Owner view only: where the person's next message goes. */
  followUp?: AgentFollowUpDto;
  /** Owner view only: the person's messages waiting for the run in progress. */
  queued?: AgentQueuedMessageDto[];
}
export interface ScheduleLoopErrorDto {
  path: string;
  error: string;
}
export type ScheduleListResponseDto =
  | ScheduleTaskDto[]
  | {
      tasks: ScheduleTaskDto[];
      loopErrors?: ScheduleLoopErrorDto[];
      errors?: ScheduleLoopErrorDto[];
    };
export interface ScheduleTaskInputDto extends Omit<AgentFieldsDto, "budget" | "pauseAfterFailures" | "approvals" | "warmPings" | "heartbeat"> {
  heartbeat?: AgentHeartbeatDto | null;
  approvals?: AgentApprovalPolicyDto | null;
  budget?: AgentBudgetDto | null;
  pauseAfterFailures?: number | null;
  projectId: string;
  prompt: string;
  kind?: "at" | "every" | "cron";
  at?: number;
  everyMinutes?: number;
  cadence?: ScheduleCadenceDto;
  target?: ScheduleTargetDto;
  overlapPolicy?: "skip" | "queue" | "parallel";
  catchUp?: "once" | "skip";
  sessionId?: string;
  title?: string;
  enabled?: boolean;
  model?: (ModelRef & { harnessId?: string }) | null;
  harness?: HarnessSelection | null;
  fallbackModels?: Array<ModelRef & { harnessId: string }> | null;
  permissions?: AgentPermissionLevelDto | null;
}

// ---- knowledge types ---------------------------------------------------------
export type KnowledgeKindDto = "note" | "spec" | "plan" | "memory";
export interface KnowledgeListItemDto {
  id: string; projectId: string; kind: KnowledgeKindDto;
  title: string; snippet: string; bodyBytes: number; tags: string[];
  source: "user" | "agent" | "import"; sourceSessionId?: string;
  revision: number; createdAt: number; updatedAt: number;
}
export interface KnowledgeItemDto extends Omit<KnowledgeListItemDto, "snippet" | "bodyBytes"> {
  body: string;
}

// ---- github types ----------------------------------------------------------
export type GithubRepoDto = HostingRepository;
export type GithubIssueDto = HostingIssue;
export type GithubIssueDetailDto = HostingIssueDetail;
export type GithubIssueCommentDto = HostingIssueComment;
export type GithubPrDto = ChangeRequest;
export interface CurrentPrSummaryDto {
  number: number; title: string; url: string;
  changedFiles: number; additions: number; deletions: number;
}
export type GithubStatusDto = HostingStatus;
export type GhListResult<T> = HostingResult<T>;

// ---- voice engines --------------------------------------------------------
export interface VoiceSettingsDto {
  stt: { baseUrl: string; model: string; language: string; apiKeyEnv: string };
  tts: {
    /** Absent on older servers, which only speak to an OpenAI-compatible server. */
    provider?: "openai-compatible" | "openai" | "elevenlabs" | "google" | "polly" | "gradium";
    baseUrl: string; model: string; voice: string; apiKeyEnv: string;
    secretKeyEnv?: string; region?: string;
  };
  sttConfigured: boolean;
  ttsConfigured: boolean;
  /** Key slots (`tts:<provider>`, `dictation:<provider>`, …) holding a key typed
   *  in Settings; values are write-only. Absent on older servers. */
  storedKeys?: string[];
}

// ---- explicit assist actions ----------------------------------------------------
export interface AssistSuggestionDto { suggestion: string; atSeq: number }
export interface TaskBriefDto { brief: string }

// ---- PR detail + checks -----------------------------------------------------
export type PrDetailDto = ChangeRequestDetail;
export type PrFileDto = ChangeRequestFile;
export type CheckStatusDto =
  | "queued" | "in_progress" | "success" | "failure" | "cancelled"
  | "skipped" | "neutral" | "timed_out" | "action_required";
export interface PrCheckDto {
  id: string; name: string; workflow?: string; status: CheckStatusDto;
  startedAt?: string; completedAt?: string; url?: string; summary?: string;
}
export interface ChecksSummaryDto {
  total: number; headline: string; state: "failure" | "pending" | "success" | "none";
  counts: Partial<Record<CheckStatusDto, number>>;
  groups: Array<{ id: string; label: string; checks: PrCheckDto[] }>;
}
export type PrCommentDto = ChangeRequestComment;

// ---- generated walkthrough + review ------------------------------------------
export type WalkthroughSourceDto =
  | { kind: "working-tree"; projectId: string }
  | { kind: "range"; projectId: string; base: string; head: string }
  | { kind: "pull-request"; projectId: string; number: number };
export interface GeneratedWalkthroughDto {
  id: string; source: WalkthroughSourceDto; sourceDigest: string;
  status: "queued" | "running" | "ready" | "failed";
  stages: Array<{
    id: string; title: string; explanation: string;
    stops: Array<{ id: string; path: string; hunkDigest: string; diff: string; explanation: string }>;
  }>;
  error?: string; createdAt: number;
}
export interface ReviewFindingDto {
  severity: "critical" | "high" | "medium" | "low"; path?: string; line?: number; body: string; confidence: number;
}
export interface ReviewAssessmentDto {
  summary: string; findings: ReviewFindingDto[]; riskScore: number; confidenceScore: number;
}
export type ReviewResultDto =
  | { ok: true; reviewId: string; sourceDigest: string; assessment: ReviewAssessmentDto }
  | { ok: false; reason: string };
export interface ReviewFlowStateDto {
  id: string; sessionId: string; status: string; iteration: number; maxIterations: number;
  baseDigest: string; latestReviewId?: string; stoppedReason?: string;
}

export interface SessionRetentionDto {
  days: number;
  cutoff: number;
  eligibleCount: number;
}
export type SessionRetentionAction = "archive" | "delete";
export type SessionRetentionTarget = "sessions" | "archives";
export interface SessionRetentionResultDto {
  eligibleCount: number;
  succeeded: string[];
  failed: Array<{ id: string; code: string }>;
}

// ---- goal types (§12) ------------------------------------------------------
export type GoalVerdict = "keep" | "done" | "stuck";
export interface GoalState {
  objective: string;
  status: "active" | "paused" | "completed" | "stuck" | "stopped";
  continuations: number;
  maxContinuations: number;
  tokensUsed: number;
  budgetTokens: number;
  lastVerdict?: GoalVerdict;
  lastReason?: string;
  stuckStreak: number;
  updatedAt: number;
  waitingFor?: string[];
  auditRevision?: string;
}

export const api = {
  health: () => jfetch<Health>("/api/health"),
  packagesList: (): Promise<{ packages: PackageDescriptorDto[] }> =>
    jfetch<{ packages: PackageDescriptorDto[] }>("/api/packages"),
  packagesSetEnabled: (id: string, enabled: boolean): Promise<PackageDescriptorDto> =>
    jfetch<PackageDescriptorDto>(`/api/packages/${encodeURIComponent(id)}`, json("PATCH", { enabled })),
  packageResidue: (): Promise<{ residue: PackageResidueDto[] }> =>
    jfetch<{ residue: PackageResidueDto[] }>("/api/packages/residue"),
  packageResiduePurge: (id: string): Promise<{ removed: PackageResidueDto }> =>
    jfetch<{ removed: PackageResidueDto }>(`/api/packages/residue/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- spaces (tenancy) --------------------------------------------------
  // The active Space is server-side state: switching is a POST, not a query
  // parameter, and every other call is answered inside whatever Space the
  // server resolved for this device.
  spaces: () => jfetch<SpacesStateDto>("/api/spaces"),
  createSpace: (input: { name: string; color?: string; icon?: string }) =>
    jfetch<SpacesStateDto>("/api/spaces", json("POST", input)),
  patchSpace: (id: string, patch: { name?: string; color?: string; icon?: string }) =>
    jfetch<SpacesStateDto>(`/api/spaces/${encodeURIComponent(id)}`, json("PATCH", patch)),
  deleteSpace: (id: string) =>
    jfetch<SpacesStateDto>(`/api/spaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
  activateSpace: (id: string) =>
    jfetch<SpacesStateDto>(`/api/spaces/${encodeURIComponent(id)}/activate`, json("POST")),
  spaceMembers: (id: string) =>
    jfetch<SpaceMemberDto[]>(`/api/spaces/${encodeURIComponent(id)}/members`),

  // Large uploaded icons arrive as cacheable refs instead of inline base64.
  listProjects: () => jfetch<Project[]>("/api/projects?iconRefs=1"),
  addProject: (path: string, name?: string) =>
    jfetch<Project>("/api/projects", json("POST", { path, name })),
  createProject: (path: string, name?: string) =>
    jfetch<Project>("/api/projects/create", json("POST", { path, name })),
  /** The first-run personal project; the server chooses its folder. */
  ensurePersonalProject: (name?: string) =>
    jfetch<Project>("/api/projects/personal", json("POST", { name })),
  cloneProject: (input: ProjectCloneInput | string, parentPath?: string) =>
    jfetch<Project>("/api/projects/clone", json("POST", typeof input === "string"
      ? { repository: input, parentPath: parentPath ?? "" }
      : input)),
  deleteProject: (id: string) => jfetch<void>(`/api/projects/${id}`, { method: "DELETE" }),
  patchProject: (id: string, patch: ProjectPatch) =>
    jfetch<Project>(`/api/projects/${id}`, json("PATCH", patch)),
  projectPresentationSettings: (projectId: string) =>
    jfetch<ProjectPresentationSettingsDto>(`/api/projects/${encodeURIComponent(projectId)}/settings`),
  projectPresentationSettingsSave: (
    projectId: string,
    settings: Record<string, unknown>,
    opts?: { keepalive?: boolean; expectedRevision?: number },
  ) => jfetch<ProjectPresentationSettingsDto>(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
    ...json("PUT", { settings, expectedRevision: opts?.expectedRevision }),
    ...(opts?.keepalive ? { keepalive: true } : {}),
  }),

  listSessions: (projectId: string, init?: RequestInit) => jfetch<SessionProjection[]>(`/api/sessions?projectId=${encodeURIComponent(projectId)}`, init),
  listSessionSummaries: (input: import("@polyth/contracts").SessionSummaryQuery, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const key of ["projectId", "worktreePath", "revision", "query", "limit", "archived", "attentionOnly", "pinned", "fromTime", "toTime"] as const) {
      if (input[key] !== undefined) query.set(key, String(input[key]));
    }
    if (input.cursor) { query.set("cursorId", input.cursor.id); query.set("cursorTime", String(input.cursor.updatedAt)); }
    return jfetch<import("@polyth/contracts").SessionSummaryPage>(`/api/sessions/summaries?${query}`, { signal });
  },
  updateSessionWorkspace: (sessionId: string, selection: import("@polyth/contracts").SessionWorkspaceSelection) =>
    jfetch<SessionProjection>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, json("PUT", selection)),
  /** `clientOperationId` makes the create idempotent: a resend with the same
   *  key returns the session the first request made instead of a second one. */
  createSession: (input: { projectId: string; repositoryIds?: readonly string[]; harness?: HarnessSelection; title?: string; purpose?: string; model?: ModelRef; agent?: string; worktreePath?: string; clientOperationId?: string }) =>
    jfetch<SessionRef>("/api/sessions", json("POST", input)),
  /** Outcome of one keyed create whose response was lost. Servers without
   *  idempotent create answer 404, which callers must treat as unresolvable. */
  sessionCreateOperation: (clientOperationId: string) =>
    jfetch<SessionCreateOperationStatusDto>(`/api/sessions/create-operations/${encodeURIComponent(clientOperationId)}`),
  getSession: (id: string, init?: RequestInit) => jfetch<SessionProjection>(`/api/sessions/${id}`, init),
  sessionDebug: (id: string) =>
    jfetch<{ debug: SessionDebugDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/debug`),
  /** `page` (beforeSeq/limit) keyset-pages the NEWEST events in the window —
   *  the deep-log hydration path fetches a recent window first and backfills
   *  older history in chunks (beforeSeq = oldest loaded seq). */
  getEvents: (id: string, afterSeq = 0, page?: { beforeSeq?: number; limit?: number; prefetch?: boolean }, init?: RequestInit) =>
    jfetch<SessionEvent[]>(`/api/sessions/${id}/events?afterSeq=${afterSeq}`
      + (page?.beforeSeq !== undefined ? `&beforeSeq=${page.beforeSeq}` : "")
      + (page?.limit !== undefined ? `&limit=${page.limit}` : "")
      + (page?.prefetch !== undefined ? `&prefetch=${page.prefetch ? "1" : "0"}` : ""), init),
  getReplayPage: (id: string, afterSeq = 0, highWater?: number, signal?: AbortSignal) =>
    jfetch<import("@polyth/contracts").SessionReplayPage>(`/api/sessions/${encodeURIComponent(id)}/events/forward?afterSeq=${afterSeq}`
      + (highWater === undefined ? "" : `&highWater=${highWater}`), { signal }),
  activateSession: (id: string, intent?: "open" | "warm") =>
    jfetch<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/activate`, json("POST", intent ? { intent } : {})),
  clientMutationStatus: (id: string, clientOperationId: string) =>
    jfetch<ClientMutationStatusDto>(`/api/sessions/${encodeURIComponent(id)}/client-mutations/${encodeURIComponent(clientOperationId)}`),

  // agentProfileId: string selects a profile, null explicitly clears the
  // session's stored profile, omitted inherits it.
  sendMessage: (id: string, body: { text: string; clientOperationId?: string; command?: { id: string; args?: string }; autoTitle?: boolean; hiddenUserMessage?: boolean; memory?: MemoryNarrowing; attachments?: AttachmentRef[]; model?: JsonObject; agent?: string; harness?: HarnessSelection; delivery?: string; dismissPending?: boolean; agentProfileId?: string | null }) =>
    jfetch<SendResult>(`/api/sessions/${id}/message`, json("POST", body)),
  memoryPolicyGet: (id: string) =>
    jfetch<{ setting: MemoryNarrowing }>(`/api/sessions/${id}/memory-policy`),
  memoryPolicySet: (id: string, setting: MemoryNarrowing) =>
    jfetch<{ setting: MemoryNarrowing }>(`/api/sessions/${id}/memory-policy`, json("PUT", { memory: setting })),
  runtimeFeatures: (id: string) =>
    jfetch<RuntimeFeaturesDto>(`/api/harnesses/sessions/${encodeURIComponent(id)}/features`),
  abort: (id: string, source?: string) => jfetch<void>(
    `/api/sessions/${id}/abort`,
    json("POST", source ? { source } : { source: "http" }),
  ),
  /** Pause the running turn: interrupted like Stop, but recorded as paused
   *  (projection.paused) until Continue or Stop ends it. */
  pause: (id: string, source?: string) => jfetch<{ ok: true }>(
    `/api/sessions/${id}/pause`,
    json("POST", { source: source ?? "http" }),
  ),
  /** Continue a paused session on the same history. */
  continuePaused: (id: string, source?: string) => jfetch<SendResult>(
    `/api/sessions/${id}/continue`,
    json("POST", { source: source ?? "http" }),
  ),
  compact: (id: string) => jfetch<{ ok: true }>(`/api/sessions/${id}/compact`, { method: "POST" }),
  /** Drop a pending rate-limit auto-resume; the session stays failed. */
  cancelResume: (id: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/resume/cancel`, { method: "POST" }),
  /** Compact the native context before the pending rate-limit resume runs. */
  setResumeCompact: (id: string, compact: boolean) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/resume/compact`, json("POST", { compact })),
  /** Run the pending rate-limit resume now on an optional model and harness
   *  route. The server switches that route before admitting the new turn. */
  resumeNow: (id: string, options?: ResumeTurnOptions) =>
    jfetch<SendResult>(`/api/sessions/${id}/resume/now`, json("POST", options ?? {})),
  taskBrief: (id: string) => jfetch<TaskBriefDto>(`/api/sessions/${encodeURIComponent(id)}/task-brief`, json("POST", {})),
  confirmBorrowedRuntimeEpoch: (id: string) =>
    jfetch<SessionProjection>(`/api/sessions/${id}/runtime-epoch`, json("POST", { confirm: true })),
  renameSession: (id: string, title: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/rename`, json("POST", { title })),
  /** Advance the user's read cursor so navigator unread bold clears. */
  markSessionRead: (id: string, seq: number) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/read`, json("POST", { seq })),
  saveDraft: (id: string, text: string, expectedDraftUpdatedAt?: number | null) =>
    jfetch<DraftSaveResult>(`/api/sessions/${id}/draft`, json("PATCH", {
      text,
      ...(expectedDraftUpdatedAt !== undefined ? { expectedDraftUpdatedAt } : {}),
    })),

  // ---- delivery queue --------------------------------------------------------
  queueList: (id: string) =>
    jfetch<QueueItemDto[]>(`/api/sessions/${id}/queue`).catch((): QueueItemDto[] => []),
  queueEditStart: (id: string, queueId: string) =>
    jfetch<QueueItemDto>(`/api/sessions/${id}/queue/${encodeURIComponent(queueId)}/edit`, { method: "POST" }),
  queueEdit: (id: string, queueId: string, text: string) =>
    jfetch<QueueItemDto>(`/api/sessions/${id}/queue/${encodeURIComponent(queueId)}`, json("PATCH", { text })),
  queueSendNow: (id: string, queueId: string, text: string) =>
    jfetch<SendResult>(`/api/sessions/${id}/queue/${encodeURIComponent(queueId)}/edit/send-now`, json("POST", { text })),
  queueEditCancel: (id: string, queueId: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/queue/${encodeURIComponent(queueId)}/edit`, { method: "DELETE" }),
  queueReorder: (id: string, ids: string[]) =>
    jfetch<QueueItemDto[]>(`/api/sessions/${id}/queue/order`, json("PATCH", { ids })),
  queueRemove: (id: string, queueId: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/queue/${encodeURIComponent(queueId)}`, { method: "DELETE" }),
  fork: (id: string, atSeq?: number) =>
    jfetch<ForkResult>(`/api/sessions/${id}/fork`, json("POST", atSeq === undefined ? {} : { atSeq })),
  rewind: (id: string, atSeq: number) =>
    jfetch<SessionEvent>(`/api/sessions/${id}/rewind`, json("POST", { atSeq })),
  clearRewind: (id: string) =>
    jfetch<SessionEvent>(`/api/sessions/${id}/rewind/clear`, { method: "POST" }),
  pinContext: (id: string, sourceEventSeq: number) =>
    jfetch<SessionEvent>(`/api/sessions/${id}/context/pins/${sourceEventSeq}`, { method: "POST" }),
  unpinContext: (id: string, sourceEventSeq: number) =>
    jfetch<SessionEvent>(`/api/sessions/${id}/context/pins/${sourceEventSeq}`, { method: "DELETE" }),
  runShell: (id: string, command: string) =>
    jfetch<ShellTurnResult>(`/api/sessions/${id}/shell`, json("POST", { command })),
  archive: (id: string) => jfetch<void>(`/api/sessions/${id}/archive`, { method: "POST" }),
  restore: (id: string) => jfetch<void>(`/api/sessions/${id}/restore`, { method: "POST" }),
  /** Hard delete — destructive; callers confirm running/pending sessions first. */
  deleteSession: (id: string, options?: SessionDeleteOptions) => jfetch<{ ok: true }>(
    `/api/sessions/${id}${options?.expectedLastEventSeq !== undefined ? `?expectedLastEventSeq=${options.expectedLastEventSeq}` : ""}`,
    { method: "DELETE" },
  ),

  // ---- organization ----------------------------------------------------------
  organizeSession: (id: string, patch: { folderId?: string | null; labelIds?: string[]; pinned?: { position: number } | null }) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/organize`, json("PATCH", patch)),
  bulkSessions: (op: "archive" | "restore", ids: string[]) =>
    jfetch<BulkSessionResult>(`/api/sessions/bulk`, json("POST", { op, ids })),
  listFolders: (projectId: string) =>
    jfetch<SessionFolderDto[]>(`/api/folders?projectId=${encodeURIComponent(projectId)}`).catch(
      (): SessionFolderDto[] => [],
    ),
  createFolder: (projectId: string, name: string, parentId?: string) =>
    jfetch<SessionFolderDto>(`/api/folders`, json("POST", { projectId, name, parentId })),
  updateFolder: (id: string, patch: { name?: string; parentId?: string | null; position?: number }, revision: number) =>
    jfetch<SessionFolderDto>(`/api/folders/${encodeURIComponent(id)}`, json("PATCH", { ...patch, revision })),
  deleteFolder: (id: string) =>
    jfetch<{ ok: true }>(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listLabels: () =>
    jfetch<WorkspaceLabel[]>(`/api/labels`).catch((): WorkspaceLabel[] => []),
  createLabel: (name: string, color: string) =>
    jfetch<WorkspaceLabel>(`/api/labels`, json("POST", { name, color })),
  updateLabel: (id: string, patch: { name?: string; color?: string; position?: number }, revision: number) =>
    jfetch<WorkspaceLabel>(`/api/labels/${encodeURIComponent(id)}`, json("PATCH", { ...patch, revision })),
  deleteLabel: (id: string) =>
    jfetch<{ ok: true }>(`/api/labels/${encodeURIComponent(id)}`, { method: "DELETE" }),
  searchSessions: (q: string, opts: SessionSearchOptions = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams({ q, limit: String(opts.limit ?? 30) });
    if (opts.projectId) params.set("projectId", opts.projectId);
    if (opts.role) params.set("role", opts.role);
    return jfetch<SessionSearchResult[]>(`/api/search/sessions?${params.toString()}`, { signal });
  },

  // ---- agent profiles --------------------------------------------------------
  // An unavailable profile service is not an authoritative empty account.
  // Keep the failure observable so profile caches can preserve their last
  // confirmed snapshot and retry after transport recovery.
  listProfiles: () => jfetch<AgentProfile[]>(`/api/agent-profiles`),
  createProfile: (input: Partial<AgentProfile> & { name: string; providerID: string; modelID: string }) =>
    jfetch<AgentProfile>(`/api/agent-profiles`, json("POST", input)),
  updateProfile: (id: string, patch: Partial<AgentProfile>, expectedRevision: number) =>
    jfetch<AgentProfile>(`/api/agent-profiles/${encodeURIComponent(id)}`, json("PATCH", { ...patch, expectedRevision })),
  deleteProfile: (id: string) =>
    jfetch<{ ok: true }>(`/api/agent-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  validateProfile: (id: string) =>
    jfetch<{ valid: boolean; checked: boolean; repairs: Array<{ field: string; from: string; to: string; reason: string }> }>(
      `/api/agent-profiles/${encodeURIComponent(id)}/validate`, json("POST", {}),
    ),

  // ---- behavior / system / MCP / managed plugins ----------------------------
  behaviorGet: () => jfetch<{ text: string; revision: string; pathLabel: string }>("/api/settings/behavior"),
  behaviorPut: (text: string, expectedRevision: string) =>
    jfetch<{ text: string; revision: string; pathLabel: string }>("/api/settings/behavior", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, expectedRevision }) }),
  subagentPolicyGet: () => jfetch<{ enabled: boolean }>("/api/settings/behavior/subagents"),
  subagentPolicyPut: (enabled: boolean) =>
    jfetch<{ enabled: boolean }>("/api/settings/behavior/subagents", json("PUT", { enabled })),
  workspaceInstructionsPolicyGet: () => jfetch<{ enabled: boolean }>("/api/settings/behavior/workspace-instructions"),
  workspaceInstructionsPolicyPut: (enabled: boolean) =>
    jfetch<{ enabled: boolean }>("/api/settings/behavior/workspace-instructions", json("PUT", { enabled })),
  systemInfo: () => jfetch<SystemInfoDto>("/api/system/info"),
  /** Latest published installers; disabled when no release repository is configured. */
  releaseDownloads: () => jfetch<ReleaseDownloadsDto>("/api/system/releases"),
  mcpList: () => jfetch<McpServerDto[]>("/api/mcp/servers").catch((): McpServerDto[] => []),
  mcpCreate: (input: { name: string; transport: McpTransport; secrets?: Record<string, string>; enabled?: boolean }) =>
    pendingMutation(jfetch<McpServerDto>("/api/mcp/servers", json("POST", input))),
  mcpUpdate: (id: string, patch: { name?: string; transport?: McpTransport; secrets?: Record<string, string>; enabled?: boolean }, expectedRevision: number) =>
    pendingMutation(jfetch<McpServerDto>(`/api/mcp/servers/${encodeURIComponent(id)}`, json("PATCH", { ...patch, expectedRevision }))),
  mcpRemove: (id: string) => pendingMutation(jfetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" })),
  mcpTest: (id: string) => jfetch<{ ok: boolean; message: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, json("POST", {})),
  /** Spec-named probe — same reachability check, stores status/lastError. */
  mcpProbe: (id: string) => jfetch<{ ok: boolean; message: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/probe`, json("POST", {})),
  pluginsList: () => jfetch<InstalledPluginDto[]>("/api/plugins").catch((): InstalledPluginDto[] => []),
  pluginsInstall: (source: string, options: { fork?: { strategy: PackageForkStrategy }; autoUpdate?: boolean } = {}) =>
    jfetch<InstalledPluginDto>("/api/plugins/install", json("POST", { source, ...options })),
  /** Uploaded .zip archive (base64). Installing an id that is already present
   *  stages the uploaded release as an update instead of failing. */
  pluginsInstallArchive: (archive: string, filename: string) =>
    jfetch<InstalledPluginDto>("/api/plugins/install", json("POST", { archive, filename })),
  pluginsOp: (id: string, op: "enable" | "disable" | "reload") =>
    jfetch<InstalledPluginDto>(`/api/plugins/${encodeURIComponent(id)}/${op}`, json("POST", {})),
  pluginsRemove: (id: string) => jfetch<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
  pluginsLogs: (id: string, after = 0) =>
    jfetch<Array<{ at: number; line: string }>>(`/api/plugins/${encodeURIComponent(id)}/logs?after=${after}`),
  pluginsGrant: (id: string, capabilities?: string[], connections?: string[]) =>
    jfetch<InstalledPluginDto>(`/api/plugins/${encodeURIComponent(id)}/grants`, json("POST", {
      ...(capabilities ? { capabilities } : {}),
      ...(connections ? { connections } : {}),
    })),
  pluginsUpdate: (id: string) =>
    jfetch<InstalledPluginDto>(`/api/plugins/${encodeURIComponent(id)}/update`, json("POST", {})),
  pluginsCheckUpdate: (id: string) =>
    jfetch<InstalledPluginDto>(`/api/plugins/${encodeURIComponent(id)}/check-update`, json("POST", {})),
  pluginsCheckUpdates: () => jfetch<InstalledPluginDto[]>("/api/plugins/check-updates", json("POST", {})),
  pluginsUpdateSettings: (id: string, settings: { autoUpdate?: boolean; forkStrategy?: PackageForkStrategy }) =>
    jfetch<InstalledPluginDto>(`/api/plugins/${encodeURIComponent(id)}/update-settings`, json("POST", settings)),
  pluginsRollback: (id: string, version?: string) =>
    jfetch<InstalledPluginDto>(`/api/plugins/${encodeURIComponent(id)}/rollback`, json("POST", version ? { version } : {})),
  pluginsRpc: (id: string, method: string, payload?: unknown, ctx?: { sessionId?: string; projectId?: string }) =>
    jfetch<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }>(
      `/api/plugins/${encodeURIComponent(id)}/rpc`,
      json("POST", { method, payload, ...(ctx ?? {}) }),
    ),
  pluginsSetConnectionToken: (id: string, connectionId: string, token: string) =>
    jfetch<PackageConnectionPublicDto>(
      `/api/plugins/${encodeURIComponent(id)}/connections/${encodeURIComponent(connectionId)}`,
      json("POST", { token }),
    ),
  pluginsStartOauth: (id: string, connectionId: string) =>
    jfetch<PackageConnectionPublicDto & { url?: string }>(
      `/api/plugins/${encodeURIComponent(id)}/connections/${encodeURIComponent(connectionId)}/oauth`,
      json("POST", {}),
    ),

  replyPermission: (id: string, requestId: string, reply: "once" | "always" | "reject", scope?: "session" | "project") =>
    jfetch<void>(`/api/sessions/${id}/permission/${encodeURIComponent(requestId)}`, json("POST", { reply, ...(scope ? { scope } : {}) })),
  /** Hand a subagent's open request to its parent session's agent. */
  delegatePermission: (id: string, requestId: string) =>
    jfetch<void>(`/api/sessions/${id}/permission/${encodeURIComponent(requestId)}/delegate`, json("POST", {})),
  answerQuestion: (id: string, requestId: string, answers: JsonObject) =>
    jfetch<void>(`/api/sessions/${id}/question/${encodeURIComponent(requestId)}`, json("POST", { answers })),
  rejectQuestion: (id: string, requestId: string) =>
    jfetch<void>(`/api/sessions/${id}/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }),
  replySecret: (id: string, requestId: string, action: "save" | "dismiss", value?: string) =>
    jfetch<void>(
      `/api/sessions/${encodeURIComponent(id)}/secrets/${encodeURIComponent(requestId)}`,
      json("POST", action === "save" ? { action, value: value ?? "" } : { action }),
    ),

  // ---- Secure Safe (metadata reads; values are write-only) ------------------
  listSecureSafe: () => jfetch<SecureSafeEntryDto[]>("/api/secure-safe"),
  saveSecureSafe: (input: SecureSafeCreateInput) =>
    jfetch<SecureSafeEntryDto>("/api/secure-safe", json("POST", input)),
  updateSecureSafe: (id: string, input: SecureSafePatchInput) =>
    jfetch<SecureSafeEntryDto>(`/api/secure-safe/${encodeURIComponent(id)}`, json("PATCH", input)),
  deleteSecureSafe: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/secure-safe/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listModels: (signal?: AbortSignal) => jfetch<ModelDescriptor[]>("/api/models", { signal }),
  listAgents: () => jfetch<AgentDescriptor[]>("/api/agents"),
  /** Why the catalog is empty. Asked only when it is. */
  runtimeDiagnostics: (signal?: AbortSignal) =>
    jfetch<RuntimeDiagnosticsDto>("/api/runtime/diagnostics", { signal }),

  // ---- provider/model visibility (Providers & Models settings) --------------
  listProviders: () => jfetch<ProviderCatalogDto[]>("/api/providers"),
  setProviderEnabled: (id: string, enabled: boolean) =>
    pendingMutation(jfetch<VisibilityStateDto>(`/api/providers/${encodeURIComponent(id)}/enabled`, json("POST", { enabled }))),
  setModelEnabled: (key: string, enabled: boolean) =>
    pendingMutation(jfetch<VisibilityStateDto>(`/api/models/enabled`, json("POST", { key, enabled }))),
  /** ?refresh=1 busts the server-side model cache — use while polling for a
   *  connect/OAuth flow to finish; prefer listProviders() otherwise. */
  refreshProviders: () => jfetch<ProviderCatalogDto[]>("/api/providers?refresh=1"),
  listAvailableProviders: () => jfetch<AvailableProviderDto[]>("/api/providers/available"),
  providerAuthCapabilities: (signal?: AbortSignal) =>
    jfetch<ProviderAuthCapabilitiesDto>("/api/providers/auth-capabilities", { signal }),
  providerAuthView: (id: string, signal?: AbortSignal) =>
    jfetch<ProviderAuthView>(`/api/providers/${encodeURIComponent(id)}/auth`, { signal }),
  startProviderAuthAttempt: (id: string, methodId: string, inputs?: Record<string, string>, revision?: string) =>
    pendingMutation(jfetch<AuthAttemptDto>(
      `/api/providers/${encodeURIComponent(id)}/auth/attempts`,
      json("POST", { methodId, ...(inputs ? { inputs } : {}), ...(revision ? { revision } : {}) }),
    )),
  providerAuthAttempt: (attemptId: string, signal?: AbortSignal) =>
    jfetch<AuthAttemptDto>(`/api/providers/auth/attempts/${encodeURIComponent(attemptId)}`, { signal }),
  completeProviderAuthAttempt: (attemptId: string, code?: string) =>
    pendingMutation(jfetch<AuthAttemptDto>(
      `/api/providers/auth/attempts/${encodeURIComponent(attemptId)}/complete`,
      json("POST", code ? { code } : {}),
    )),
  cancelProviderAuthAttempt: (attemptId: string) =>
    pendingMutation(jfetch<AuthAttemptDto>(
      `/api/providers/auth/attempts/${encodeURIComponent(attemptId)}`,
      { method: "DELETE" },
    )),
  previewWellKnownAuth: (origin: string) =>
    pendingMutation(jfetch<{ origin: string; hash: string; command: string[]; env: string }>(
      "/api/providers/auth/well-known/preview",
      json("POST", { origin }),
    )),
  executeWellKnownAuth: (origin: string, hash: string) =>
    pendingMutation(jfetch<{ ok: true }>(
      "/api/providers/auth/well-known/execute",
      json("POST", { origin, hash, confirm: true }),
    )),
  harnessSnapshots: (projectId?: string, detail = false, harnessId?: string) => {
    const query = new URLSearchParams();
    if (projectId) query.set("projectId", projectId);
    if (detail) query.set("detail", "1");
    if (harnessId) query.set("harnessId", harnessId);
    return jfetch<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`);
  },
  addProvider: (id: string, name?: string) =>
    pendingMutation(jfetch<VisibilityStateDto>(`/api/providers/${encodeURIComponent(id)}/add`, json("POST", name ? { name } : {}))),
  removeProvider: (id: string) =>
    pendingMutation(jfetch<VisibilityStateDto>(`/api/providers/${encodeURIComponent(id)}/remove`, json("POST", {}))),
  disconnectProvider: (id: string) =>
    pendingMutation(jfetch<{ ok: true; remaining?: ProviderAuthView["credential"] }>(`/api/providers/${encodeURIComponent(id)}/disconnect`, json("POST", {}))),
  createCustomProvider: (input: {
    id?: string;
    name: string;
    baseURL: string;
    protocol: "openai-compatible" | "openai-responses";
    authMode: "api-key" | "none";
    apiKey?: string;
    headers?: Record<string, string>;
    headerPatch?: { set?: Record<string, string>; unset?: string[]; clear?: boolean };
  }) =>
    pendingMutation(jfetch<{ ok: true; id: string; discovered?: number }>("/api/providers/custom", json("POST", input))),
  updateCustomProvider: (id: string, input: {
    name: string;
    baseURL: string;
    protocol: "openai-compatible" | "openai-responses";
    authMode: "api-key" | "none";
    apiKey?: string;
    headers?: Record<string, string>;
    headerPatch?: { set?: Record<string, string>; unset?: string[]; clear?: boolean };
  }) =>
    pendingMutation(jfetch<{ ok: true; id: string }>(
      `/api/providers/custom/${encodeURIComponent(id)}`,
      json("PATCH", input),
    )),
  removeCustomProvider: (id: string, deleteCredentials = true) =>
    pendingMutation(jfetch<{ ok: true; id: string }>(
      `/api/providers/custom/${encodeURIComponent(id)}`,
      json("DELETE", { deleteCredentials }),
    )),
  discoverCustomProviderModels: (id: string, apiKey?: string) =>
    pendingMutation(jfetch<{
      ok: true;
      models: Array<{ id: string; name?: string }>;
      unsupported?: boolean;
      message?: string;
    }>(
      `/api/providers/custom/${encodeURIComponent(id)}/discover`,
      json("POST", apiKey ? { apiKey } : {}),
    )),
  addCustomProviderModel: (id: string, model: { id: string; name?: string; context?: number; output?: number }) =>
    pendingMutation(jfetch<{ ok: true; id: string; modelID: string }>(
      `/api/providers/custom/${encodeURIComponent(id)}/models`,
      json("POST", model),
    )),
  removeCustomProviderModel: (id: string, modelId: string) =>
    pendingMutation(jfetch<{ ok: true; id: string; modelID: string }>(
      `/api/providers/custom/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
      { method: "DELETE" },
    )),
  saveRole: (name: string, input: { prompt?: string; model?: ModelRef; mode: AgentDescriptor["mode"] }) =>
    pendingMutation(jfetch<AgentDescriptor>(`/api/settings/roles/${encodeURIComponent(name)}`, json("PUT", input))),
  opencodePluginsList: () =>
    jfetch<OpenCodePluginListResponseDto>("/api/plugins/opencode"),
  opencodePluginsImport: (input: OpenCodePluginImportRequestDto) =>
    pendingMutation(jfetch<OpenCodePluginImportResponseDto>("/api/plugins/opencode/import", json("POST", input))),
  opencodePluginRemove: (spec: string) =>
    pendingMutation(jfetch<OpenCodePluginRemoveResponseDto>(
      `/api/plugins/opencode/${encodeURIComponent(spec)}`,
      { method: "DELETE" },
    )),
  opencodePending: () =>
    jfetch<OpenCodePendingResponseDto>("/api/opencode/pending"),
  opencodeApplyRestart: () =>
    jfetch<OpenCodeApplyRestartResponseDto>("/api/opencode/apply-restart", json("POST", {})),

  // ---- host directory browsing (folder picker; server-host route) -----------
  browseHost: (path?: string, hidden?: boolean) =>
    jfetch<BrowseResultDto>(`/api/browse?${new URLSearchParams({
      ...(path ? { path } : {}),
      ...(hidden ? { hidden: "true" } : {}),
    })}`),
  discoverRepositories: (path: string) =>
    jfetch<{ repositories: Array<{ name: string; path: string; linked: boolean }>; truncated: boolean }>(`/api/browse?${new URLSearchParams({ path, repositories: "true" })}`),
  browseMkdir: (path: string) =>
    jfetch<{ path: string }>(`/api/browse/mkdir`, json("POST", { path })),

  // ---- git (§12) -----------------------------------------------------------
  gitStatus: (projectId: string, sessionId?: string, repositoryId?: string) =>
    jfetch<GitStatus>(`/api/git/status?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
  gitIdentity: (projectId: string) =>
    jfetch<GitCheckoutIdentity>(`/api/git/identity?projectId=${encodeURIComponent(projectId)}`),
  /** Omitted fields stay untouched; null removes what Polyth set up. */
  gitIdentitySet: (projectId: string, identity: { name: string; email: string; sshKey?: string | null; signingKey?: string | null; anonymous?: boolean }) =>
    jfetch<GitCheckoutIdentity>(`/api/git/identity`, json("POST", { projectId, ...identity })),
  gitSourceControlProfiles: () =>
    jfetch<{ state: SourceControlProfileState; revision: number }>(`/api/git/source-control-profiles`),
  gitSourceControlProfilesSave: (state: SourceControlProfileState, expectedRevision: number) =>
    jfetch<{ state: SourceControlProfileState; revision: number }>(`/api/git/source-control-profiles`, json("PUT", { state, expectedRevision })),
  gitSshKeys: () => jfetch<{ keys: Array<{ path: string; name: string; comment?: string }> }>(`/api/git/ssh-keys`),
  gitSshKeyTest: (path: string, host?: string) =>
    jfetch<{ ok: boolean; account?: string; message: string }>(`/api/git/ssh-keys/test`, json("POST", { path, host })),
  gitDiff: (projectId: string, filePath: string, staged?: boolean, ignoreWhitespace?: boolean, sessionId?: string, repositoryId?: string) =>
    jfetch<GitDiffResult>(
      `/api/git/diff?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}${staged ? "&staged=true" : ""}${ignoreWhitespace ? "&ignoreWhitespace=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
    ),
  gitShow: (projectId: string, sha: string, ignoreWhitespace?: boolean, sessionId?: string, repositoryId?: string) =>
    jfetch<{ sha: string; diff: string }>(
      `/api/git/show?projectId=${encodeURIComponent(projectId)}&sha=${encodeURIComponent(sha)}${ignoreWhitespace ? "&ignoreWhitespace=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
    ),
  gitStage: (projectId: string, paths: string[], sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/stage`, json("POST", { projectId, paths, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitUnstage: (projectId: string, paths: string[], sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/unstage`, json("POST", { projectId, paths, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitDiscard: (projectId: string, paths: string[], sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/discard`, json("POST", { projectId, paths, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitCommit: (projectId: string, message: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ sha: string }>(`/api/git/commit`, json("POST", { projectId, message, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitCommitMessage: (projectId: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ message: string }>(`/api/git/commit-message`, json("POST", { projectId, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitBranches: (projectId: string, sessionId?: string, repositoryId?: string) =>
    emptyOnNotFound(
      jfetch<GitBranches>(`/api/git/branches?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
      { current: "", branches: [] },
    ),
  gitBranch: (projectId: string, name: string, from?: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/branch`, json("POST", { projectId, name, from, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitCheckout: (projectId: string, name: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/checkout`, json("POST", { projectId, name, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitLog: (projectId: string, limit = 20, sessionId?: string, repositoryId?: string) =>
    jfetch<GitLogEntry[]>(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
  gitGraph: (projectId: string, limit = 40, skip = 0, sessionId?: string, repositoryId?: string) =>
    jfetch<GitGraphEntry[]>(`/api/git/graph?projectId=${encodeURIComponent(projectId)}&limit=${limit}&skip=${skip}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
  gitFolder: (projectId: string, folder: string, op: "stage" | "unstage" | "discard", sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/folder`, json("POST", { projectId, folder, op, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitStashes: (projectId: string, sessionId?: string, repositoryId?: string) =>
    jfetch<GitStash[]>(`/api/git/stashes?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
  gitStashPush: (projectId: string, message?: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ created: boolean }>(`/api/git/stash`, json("POST", { projectId, message, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitStashApply: (projectId: string, ref: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/stash/apply`, json("POST", { projectId, ref, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitStashDrop: (projectId: string, ref: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/git/stash/drop`, json("POST", { projectId, ref, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  gitFetch: (projectId: string, remote = "origin", sessionId?: string, scope?: GitScope) =>
    jfetch<{ ok: true }>(`/api/git/fetch`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}), ...scoped(scope) })),
  gitPull: (projectId: string, remote = "origin", sessionId?: string, scope?: GitScope) =>
    jfetch<{ ok: true }>(`/api/git/pull`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}), ...scoped(scope) })),
  gitRebase: (projectId: string, remote = "origin", sessionId?: string, scope?: GitScope) =>
    jfetch<{ ok: true }>(`/api/git/rebase`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}), ...scoped(scope) })),
  gitPush: (projectId: string, remote = "origin", sessionId?: string, scope?: GitScope) =>
    jfetch<{ ok: true }>(`/api/git/push`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}), ...scoped(scope) })),
  gitSync: (projectId: string, remote = "origin", sessionId?: string, scope?: GitScope) =>
    jfetch<{ ok: true }>(`/api/git/sync`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}), ...scoped(scope) })),
  gitConflictPrompt: (input: {
    projectId: string;
    target: "new-session" | "current-session";
    prompt: string;
    sessionId?: string;
    problem?: string;
  }) =>
    jfetch<GhListResult<{ prompt: string }>>(
      `/api/git/conflict-prompt`,
      json("POST", input),
    ),
  /** Merge `ref` into whatever is checked out by `scope`. Resolves with
   *  `ok: false` when Git stopped on conflicts — the checkout stays conflicted
   *  until the caller resolves it or calls `gitMergeAbort`. */
  gitMerge: (projectId: string, ref: string, scope?: GitScope) =>
    jfetch<GitMergeResult>(`/api/git/merge`, json("POST", { projectId, ref, ...scoped(scope) })),
  gitMergeAbort: (projectId: string, scope?: GitScope) =>
    jfetch<{ ok: true }>(`/api/git/merge/abort`, json("POST", { projectId, ...scoped(scope) })),
  /** Local-conflict sibling of githubConflictAgent: hands a diverged pull or an
   *  in-progress merge/rebase to an agent session with a default prompt. */
  gitResolveConflictAgent: (input: {
    projectId: string;
    target: "new-session" | "current-session";
    prompt: string;
    sessionId?: string;
    problem?: string;
  }) =>
    jfetch<GhListResult<{ sessionId: string }>>(
      `/api/git/resolve-conflict-agent`,
      json("POST", input),
    ),

  // ---- worktrees (§12) -----------------------------------------------------
  listWorktrees: (projectId: string, options?: { status?: boolean }) =>
    emptyOnNotFound(
      jfetch<Worktree[]>(`/api/worktrees?projectId=${encodeURIComponent(projectId)}${options?.status ? "&status=1" : ""}`),
      [],
    ),
  createWorktree: (projectId: string, branch: string, wtPath?: string, base?: string, newBranchOnly?: boolean) =>
    jfetch<Worktree>(`/api/worktrees`, json("POST", {
      projectId, branch, path: wtPath, base,
      ...(newBranchOnly ? { newBranchOnly: true } : {}),
    })),
  /** Rejects with code `worktree-dirty` when uncommitted changes would be lost; pass `force` after the user confirms.
   *  `ok: true` means Git removal (or an already-absent worktree) succeeded. `metadataCleanupFailed` /
   *  `branchCleanupFailed` are follow-up warnings: session rows may still need `worktreeState: missing`
   *  reconciliation, or the dedicated branch may still exist. */
  removeWorktree: (projectId: string, wtPath: string, deleteBranch?: boolean, force?: boolean) =>
    jfetch<{ ok: true; metadataCleanupFailed?: boolean; branchCleanupFailed?: boolean }>(`/api/worktrees/remove`, json("POST", { projectId, path: wtPath, deleteBranch, ...(force ? { force: true } : {}) })),

  /** Keyed like `createSession`: a resend with the same `clientOperationId`
   *  returns the first session and its managed checkouts. */
  createIsolatedSession: (input: CreateIsolatedSessionInput & { clientOperationId?: string }) =>
    jfetch<SessionRef>(`/api/isolation/sessions`, json("POST", input)),
  isolationStatus: (sessionId: string) =>
    jfetch<IsolationStatusDto>(`/api/isolation/${encodeURIComponent(sessionId)}`),
  /** `input.target` integrates into another checked-out branch from the
   *  status's `targets` instead of the recorded one. */
  isolationMerge: (sessionId: string, input: IsolationMergeInput = {}) =>
    jfetch<IsolationMergeResultDto>(`/api/isolation/${encodeURIComponent(sessionId)}/merge`, json("POST", input)),
  /** Choose where the work will be integrated, without integrating yet. */
  isolationRetarget: (sessionId: string, input: IsolationRetargetInput) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/retarget`, json("POST", input)),
  isolationKeep: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/keep`, json("POST", {})),
  isolationDiscard: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/discard`, json("POST", {})),
  isolationRecover: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/recover`, json("POST", {})),
  isolationAbandon: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/abandon`, json("POST", {})),
  /** Leave an isolation with no commits or uncommitted changes; the server
   *  refuses (409) when the checkout holds anything to integrate. */
  isolationReturn: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/return`, json("POST", {})),
  /** Move an ordinary session into its own isolated checkout, branched from
   *  the checkout it works in; merge-back later returns there. */
  isolationIsolate: (sessionId: string) =>
    jfetch<IsolateSessionResultDto>(`/api/isolation/${encodeURIComponent(sessionId)}/isolate`, json("POST", {})),
  isolationResolve: (sessionId: string) =>
    jfetch<{ sessionId: string }>(`/api/isolation/${encodeURIComponent(sessionId)}/resolve`, json("POST", {})),
  isolationPush: (sessionId: string, input: { remote?: string; branch?: string; message?: string } = {}) =>
    jfetch<IsolationPushResultDto>(`/api/isolation/${encodeURIComponent(sessionId)}/push`, json("POST", input)),

  // ---- files (§12) ---------------------------------------------------------
  // Every files call carries an optional sessionId so the server resolves the
  // active session's worktree, not the project root.
  filesTree: (projectId: string, relPath?: string, hidden?: boolean, sessionId?: string, repositoryId?: string) =>
    jfetch<FileEntry[]>(`/api/files/tree?projectId=${encodeURIComponent(projectId)}${relPath ? `&path=${encodeURIComponent(relPath)}` : ""}${hidden ? "&hidden=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
  /** `editable` asks for the file's complete contents (up to the editable cap)
   *  instead of the cheaper preview slice — pass it whenever the result will
   *  back a buffer that can be saved. */
  filesRead: (projectId: string, relPath: string, sessionId?: string, opts?: { editable?: boolean }, repositoryId?: string) =>
    jfetch<FileReadResult>(`/api/files/read?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}${opts?.editable ? "&editable=true" : ""}`),
  filesWrite: (projectId: string, relPath: string, content: string, baseRevision?: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true; revision: string }>(`/api/files/write`, json("POST", {
      projectId, path: relPath, content,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}),
    })),
  filesMkdir: (projectId: string, relPath: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/files/mkdir`, json("POST", { projectId, path: relPath, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  filesDelete: (projectId: string, relPath: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/files/delete`, json("POST", { projectId, path: relPath, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  filesRename: (projectId: string, from: string, to: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ ok: true }>(`/api/files/rename`, json("POST", { projectId, from, to, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })),
  filesUpload: (projectId: string, relPath: string, bytes: Uint8Array, sessionId?: string, repositoryId?: string) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return jfetch<{ ok: true }>(`/api/files/upload`, json("POST", { projectId, path: relPath, base64: btoa(bin), ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) }));
  },
  filesStat: (projectId: string, relPath: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ path: string; kind: "file" | "dir"; size: number; mime?: string; revision?: string }>(
      `/api/files/stat?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
    ),
  /** File stat for polling surfaces where an absent file is an expected state. */
  filesStatOptional: (projectId: string, relPath: string, sessionId?: string, repositoryId?: string) =>
    jfetch<{ path: string; kind: "file" | "dir"; size: number; mime?: string; revision?: string } | null>(
      `/api/files/stat?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}&optional=true${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
    ),
  /** URL of the sanitized raw-bytes endpoint (images in Markdown, previews). */
  filesRawUrl: (projectId: string, relPath: string, sessionId?: string, repositoryId?: string) =>
    `/api/files/raw?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
  /** Legacy string results; accepts old (string[]) and new (scored) payloads. */
  filesSearch: async (projectId: string, q: string, limit = 50, sessionId?: string, repositoryId?: string): Promise<string[]> => {
    const hits = await api.filesSearchScored(projectId, q, limit, false, sessionId, repositoryId);
    return hits.map((h) => h.path);
  },
  /** Scored file search. Migration-safe: plain strings are upgraded. */
  filesSearchScored: (projectId: string, q: string, limit = 50, includeDirs = false, sessionId?: string, repositoryId?: string) =>
    jfetch<Array<string | FileSearchHitDto>>(
      `/api/files/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=${limit}${includeDirs ? "&includeDirs=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
    )
      .then((rows): FileSearchHitDto[] =>
        rows.map((r) => (typeof r === "string" ? { path: r, kind: "file", score: 0, matches: [] } : r)),
      )
      .catch((): FileSearchHitDto[] => []),
  filesSearchContent: (projectId: string, q: string, limit = 100, sessionId?: string, repositoryId?: string, include?: string, exclude?: string) =>
    jfetch<FileContentSearchResult>(`/api/files/search-content?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=${limit}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}${include?.trim() ? `&include=${encodeURIComponent(include)}` : ""}${exclude?.trim() ? `&exclude=${encodeURIComponent(exclude)}` : ""}`),
  filesInlineAiSettingsGet: () =>
    jfetch<{ explainPrompt: string; fixPrompt: string; modelOverride?: string }>("/api/files/inline-ai/settings"),
  filesInlineAiSettingsPut: (settings: {
    explainPrompt?: string;
    fixPrompt?: string;
    modelOverride?: string;
  }) => jfetch<{ explainPrompt: string; fixPrompt: string; modelOverride?: string }>(
    "/api/files/inline-ai/settings",
    json("PUT", settings),
  ),
  filesInlineAi: (input: {
    action: "explain" | "fix";
    projectId: string;
    path: string;
    selection: string;
    language?: string;
    sessionId?: string;
    repositoryId?: string;
  }) => jfetch<{ text: string }>("/api/files/inline-ai", json("POST", input)),

  /** Palette project/session search; metadata only. */
  searchWorkspaces: (q: string, limit = 10, archived = false) =>
    jfetch<{ items: WorkspaceSearchItemDto[] }>(
      `/api/search/workspaces?q=${encodeURIComponent(q)}&limit=${limit}&archived=${archived}`,
    )
      .then((r) => r.items)
      .catch((): WorkspaceSearchItemDto[] => []),

  // ---- commands + snippets (§12) --------------------------------------------
  // Strict catalog read for the composer. Command and
  // snippet outcomes stay independent and an HTTP/transport failure is an
  // explicit `ok: false` — never coerced into an empty array.
  composerCatalog: async (projectId: string): Promise<ComposerCatalogResult> => {
    const strict = async <T>(path: string): Promise<StrictListResult<T>> => {
      try {
        const items = await jfetch<T[]>(path);
        return { ok: true, items: Array.isArray(items) ? items : [] };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    };
    const [commands, snippets] = await Promise.all([
      strict<SlashCommand>(`/api/commands?projectId=${encodeURIComponent(projectId)}`),
      strict<SnippetDef>(`/api/snippets?projectId=${encodeURIComponent(projectId)}`),
    ]);
    return { commands, snippets };
  },
  // PLAN §12: /api/commands and /api/snippets each return a flat array.
  // Convenience callers keep the fail-soft empty-array fallback; Composer
  // must use composerCatalog above instead.
  listCommands: async (projectId: string): Promise<CommandListResult> => {
    const [commands, snippets] = await Promise.all([
      jfetch<SlashCommand[]>(`/api/commands?projectId=${encodeURIComponent(projectId)}`).catch(
        (): SlashCommand[] => [],
      ),
      jfetch<SnippetDef[]>(`/api/snippets?projectId=${encodeURIComponent(projectId)}`).catch(
        (): SnippetDef[] => [],
      ),
    ]);
    return { commands, snippets };
  },
  listSnippets: (projectId: string) =>
    jfetch<SnippetDef[]>(`/api/snippets?projectId=${encodeURIComponent(projectId)}`).catch(
      (): SnippetDef[] => [],
    ),
  listSkills: (projectId: string) =>
    jfetch<AgentSkillDef[]>(`/api/skills?projectId=${encodeURIComponent(projectId)}`).catch((): AgentSkillDef[] => []),

  // ---- session goal (§12) ---------------------------------------------------
  goalAttach: (sessionId: string, objective: string, budgetTokens?: number, maxContinuations?: number) =>
    jfetch<GoalState>(
      `/api/sessions/${sessionId}/goal`,
      json("POST", { objective, budgetTokens, maxContinuations }),
    ),
  goalGet: (sessionId: string) =>
    jfetch<GoalState | null>(`/api/sessions/${sessionId}/goal`).catch((): GoalState | null => null),
  goalPause: (sessionId: string) =>
    jfetch<GoalState>(`/api/sessions/${sessionId}/goal/pause`, { method: "POST" }),
  goalResume: (sessionId: string) =>
    jfetch<GoalState>(`/api/sessions/${sessionId}/goal/resume`, { method: "POST" }),
  goalStop: (sessionId: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${sessionId}/goal/stop`, { method: "POST" }),

  // ---- M3: multirun --------------------------------------------------------
  startMultirun: (sessionId: string, text: string, runs: Array<{ model?: ModelRef; agent?: string }>) =>
    jfetch<{ multirunId: string }>(`/api/sessions/${sessionId}/multirun`, json("POST", { text, runs })),
  getMultirun: (multirunId: string) =>
    jfetch<MultirunDto>(`/api/multiruns/${multirunId}`),
  pickMultirun: (multirunId: string, runId: string) =>
    jfetch<{ ok: true }>(`/api/multiruns/${multirunId}/pick`, json("POST", { runId })),

  // ---- workflow orchestration -----------------------------------------------
  listWorkflows: (projectId: string) =>
    jfetch<WorkflowDto[]>(`/api/workflows?projectId=${encodeURIComponent(projectId)}`),
  createWorkflow: (input: Omit<WorkflowDto, "id" | "createdAt" | "updatedAt">) =>
    jfetch<WorkflowDto>("/api/workflows", json("POST", input)),
  getWorkflow: (id: string) =>
    jfetch<WorkflowDto>(`/api/workflows/${encodeURIComponent(id)}`),
  updateWorkflow: (id: string, patch: Partial<Pick<WorkflowDto, "name" | "description" | "category" | "profile" | "nodes" | "edges" | "defaults">> & { expectedRevision?: number }) =>
    jfetch<WorkflowDto>(`/api/workflows/${encodeURIComponent(id)}`, json("PATCH", patch)),
  deleteWorkflow: (id: string) =>
    jfetch<{ ok: true }>(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getWorkflowPreferences: (projectId: string) =>
    jfetch<WorkflowPreferencesDto>(`/api/workflows/preferences?projectId=${encodeURIComponent(projectId)}`),
  updateWorkflowPreferences: (projectId: string, patch: Partial<WorkflowPreferencesDto>) =>
    jfetch<WorkflowPreferencesDto>(`/api/workflows/preferences?projectId=${encodeURIComponent(projectId)}`, json("PATCH", patch)),
  runWorkflow: (id: string, sessionId: string, input: string, options?: WorkflowRunOptionsDto, launch?: WorkflowLaunchOptionsDto) =>
    jfetch<WorkflowRunDto>(`/api/workflows/${encodeURIComponent(id)}/run`, json("POST", {
      sessionId,
      input,
      ...(options ? { options } : {}),
      ...(launch ? { launch } : {}),
    })),
  listWorkflowRuns: (projectId: string) =>
    jfetch<WorkflowRunDto[]>(`/api/workflow-runs?projectId=${encodeURIComponent(projectId)}`),
  getWorkflowRun: (runId: string) =>
    jfetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}`),
  stopWorkflowRun: (runId: string) =>
    jfetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }),
  retryWorkflowRun: (runId: string, input: WorkflowRetryInputDto) =>
    jfetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}/retry`, json("POST", input)),

  // ---- M3: fusion ----------------------------------------------------------
  startFusion: (sessionId: string, text: string, models: string[]) =>
    jfetch<{ fusionId: string }>(`/api/sessions/${sessionId}/fuse`, json("POST", { text, models })),
  getFusion: (fusionId: string) =>
    jfetch<FusionDto>(`/api/fusions/${fusionId}`),

  // ---- M3: walkthrough -----------------------------------------------------
  getWalkthrough: (sessionId: string) =>
    jfetch<{ steps: WalkthroughStepDto[] }>(`/api/sessions/${sessionId}/walkthrough`).catch(
      (): { steps: WalkthroughStepDto[] } => ({ steps: [] }),
    ),
  walkthroughDecide: (sessionId: string, stepIndex: number, decision: "approve" | "reject") =>
    jfetch<{ ok: true }>(`/api/sessions/${sessionId}/walkthrough/${stepIndex}/${decision}`, { method: "POST" }),

  // ---- M3: terminal (FIXED protocol; POST :id is the live input seam — /input is aliased in comments) ----
  listTerminals: (projectId: string) =>
    jfetch<TerminalInfo[]>(`/api/terminals?projectId=${encodeURIComponent(projectId)}`).catch(
      (): TerminalInfo[] => [],
    ),
  createTerminal: (projectId: string, opts?: { sessionId?: string; repositoryId?: string; cwd?: string; cmd?: string; cols?: number; rows?: number }) =>
    jfetch<{ terminalId: string }>(`/api/terminals`, json("POST", { projectId, ...opts })),
  terminalInput: (terminalId: string, data: string) =>
    jfetch<{ ok: true }>(`/api/terminals/${terminalId}`, json("POST", { data })),
  closeTerminal: (terminalId: string) =>
    jfetch<{ ok: true }>(`/api/terminals/${terminalId}`, { method: "DELETE" }),
  renameTerminal: (terminalId: string, title: string) =>
    jfetch<TerminalInfo>(`/api/terminals/${terminalId}`, json("PATCH", { title })),

  // ---- schedule --------------------------------------------------------------
  scheduleList: (projectId?: string) =>
    jfetch<ScheduleListResponseDto>(`/api/schedule${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  /** `webhookTokens`: URL tokens minted for new webhook wakes, by wake id. Shown once. */
  scheduleCreate: (input: ScheduleTaskInputDto) =>
    jfetch<ScheduleTaskDto & { webhookTokens?: Record<string, string> }>(`/api/schedule`, json("POST", input)),
  scheduleUpdate: (id: string, patch: Partial<ScheduleTaskInputDto>) =>
    jfetch<ScheduleTaskDto & { webhookTokens?: Record<string, string> }>(`/api/schedule/${encodeURIComponent(id)}`, json("PATCH", patch)),
  scheduleDelete: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/schedule/${encodeURIComponent(id)}`, { method: "DELETE" }),
  schedulePause: (id: string, pause: boolean) =>
    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/${pause ? "pause" : "resume"}`, { method: "POST" }),
  /** Run the agent now. With `input`, the person's message: `continuation`
   *  says whether it goes on in the agent's current conversation (`auto`
   *  lets the agent judge, as `followUp` previews) or starts a new one;
   *  `attachments` are files already uploaded into the project's `_inbox/`. */
  scheduleRun: (id: string, input?: string, options?: { continuation?: AgentContinuationDto; attachments?: AttachmentRef[] }) =>
    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/run`, input || options?.attachments?.length
      ? json("POST", {
        ...(input ? { input } : {}),
        ...(options?.continuation ? { continuation: options.continuation } : {}),
        ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      })
      : { method: "POST" }),
  scheduleContext: (id: string) => jfetch<AgentContextDto>(`/api/schedule/${encodeURIComponent(id)}/context`),
  scheduleContextAction: (id: string, action: "new-session" | "compact") =>
    jfetch<unknown>(`/api/schedule/${encodeURIComponent(id)}/context`, json("POST", { action })),
  /** export: write an app agent to `.agents/agents/<id>.md`; convert: replace a trusted loop file. */
  scheduleFileAction: (id: string, action: "export" | "convert") =>
    jfetch<ScheduleTaskDto & { filePath: string }>(`/api/schedule/${encodeURIComponent(id)}/file`, json("POST", { action })),
  scheduleScriptTest: (input: { projectId: string; agentId?: string; trigger: AgentEventTriggerDto }) =>
    jfetch<AgentScriptTestDto>(`/api/schedule/script-test`, json("POST", input)),
  scheduleSources: () => jfetch<AgentEventSourceDto[]>(`/api/schedule/sources`),
  scheduleTriggerPreview: (input: { projectId: string; agentId?: string; trigger: AgentEventTriggerDto }) =>
    jfetch<AgentTriggerPreviewDto>(`/api/schedule/trigger-preview`, json("POST", input)),
  scheduleDraft: (input: { projectId: string; description?: string; sessionId?: string; timeZone: string }) =>
    jfetch<AgentDraftDto>(`/api/schedule/draft`, json("POST", input)),
  schedulePreview: (cadence: ScheduleCadenceDto, count = 5) =>
    jfetch<{ runs: number[]; description: string }>(`/api/schedule/preview`, json("POST", { cadence, count })),
  scheduleRuns: (id: string, limit = 50) =>
    jfetch<ScheduleRunDto[]>(`/api/schedule/${encodeURIComponent(id)}/runs?limit=${limit}`),
  scheduleSeen: (id: string, at?: number) =>
    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/seen`, json("POST", at !== undefined ? { at } : {})),
  scheduleStop: (id: string) =>
    jfetch<{ stopped: number }>(`/api/schedule/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  scheduleFeedback: (id: string, runId: string, verdict: "up" | "down" | null, note?: string) =>
    jfetch<ScheduleTaskDto>(
      `/api/schedule/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/feedback`,
      json("POST", { verdict, ...(note ? { note } : {}) }),
    ),
  scheduleLoopsRescan: (projectId: string) =>
    jfetch<{ tasks: ScheduleTaskDto[]; errors: ScheduleLoopErrorDto[] }>(
      `/api/schedule/loops/rescan`, json("POST", { projectId }),
    ),
  scheduleLoopErrorDismiss: (projectId: string, path: string) =>
    jfetch<{ ok: boolean }>(`/api/schedule/loops/errors/dismiss`, json("POST", { projectId, path })),

  // ---- knowledge ---------------------------------------------------------------
  knowledgeList: (projectId: string, opts: { kind?: KnowledgeKindDto; q?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams({ projectId });
    if (opts.kind) p.set("kind", opts.kind);
    if (opts.q) p.set("q", opts.q);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.offset) p.set("offset", String(opts.offset));
    return jfetch<{ items: KnowledgeListItemDto[]; total: number }>(`/api/knowledge?${p}`).catch(
      () => ({ items: [] as KnowledgeListItemDto[], total: 0 }),
    );
  },
  knowledgeGet: (id: string) => jfetch<KnowledgeItemDto>(`/api/knowledge/${encodeURIComponent(id)}`),
  knowledgeCreate: (input: { projectId: string; kind: KnowledgeKindDto; title: string; body: string; tags?: string[]; sourceSessionId?: string }) =>
    jfetch<KnowledgeItemDto>(`/api/knowledge`, json("POST", input)),
  knowledgeUpdate: (id: string, patch: { title?: string; body?: string; tags?: string[]; kind?: KnowledgeKindDto }, expectedRevision: number) =>
    jfetch<KnowledgeItemDto>(`/api/knowledge/${encodeURIComponent(id)}`, json("PATCH", { ...patch, expectedRevision })),
  knowledgeDelete: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }),
  knowledgeAttach: (sessionId: string, knowledgeId: string, revision: number) =>
    jfetch<{ ok: true; eventSeq: number; revision: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/knowledge`, json("POST", { knowledgeId, revision }),
    ),

  // ---- spec-driven tracks ------------------------------------------------------
  trackList: (projectId: string) =>
    jfetch<TrackDto[]>(`/api/tracks?projectId=${encodeURIComponent(projectId)}`).catch(
      (): TrackDto[] => [],
    ),
  trackGet: (id: string) =>
    jfetch<TrackDto>(`/api/tracks/${encodeURIComponent(id)}`),
  trackCreate: (input: TrackCreateInput) =>
    jfetch<TrackDto>("/api/tracks", json("POST", input)),
  trackStart: (id: string, sessionId: string) =>
    jfetch<TrackDto>(`/api/tracks/${encodeURIComponent(id)}/start`, json("POST", { sessionId })),
  trackRetry: (id: string, sessionId?: string) =>
    jfetch<TrackDto>(`/api/tracks/${encodeURIComponent(id)}/retry`, json("POST", { sessionId })),
  trackCompleteStep: (id: string) =>
    jfetch<TrackDto>(`/api/tracks/${encodeURIComponent(id)}/complete-step`, { method: "POST" }),

  // ---- github (gh CLI; fail-soft) --------------------------------------------
  githubStatus: (projectId: string, passive = false) =>
    jfetch<GithubStatusDto>(`/api/github/status?projectId=${encodeURIComponent(projectId)}${passive ? "&passive=true" : ""}`).catch(
      (): GithubStatusDto => ({
        installed: false,
        authenticated: false,
        user: null,
        repo: null,
        reason: tr("settings.pages.serverUnreachable"),
      }),
    ),
  githubRepo: (projectId: string) =>
    jfetch<GhListResult<GithubRepoDto>>(`/api/github/repo?projectId=${encodeURIComponent(projectId)}`).catch(
      (): GhListResult<GithubRepoDto> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubIssues: (projectId: string, limit = 30) =>
    jfetch<GhListResult<GithubIssueDto[]>>(`/api/github/issues?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GhListResult<GithubIssueDto[]> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubIssueDetail: (projectId: string, number: number) =>
    jfetch<GhListResult<GithubIssueDetailDto>>(`/api/github/issue?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<GithubIssueDetailDto> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubIssueComments: (projectId: string, number: number) =>
    jfetch<GhListResult<GithubIssueCommentDto[]>>(`/api/github/issue/comments?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<GithubIssueCommentDto[]> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubPrs: (projectId: string, limit = 30) =>
    jfetch<GhListResult<GithubPrDto[]>>(`/api/github/prs?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GhListResult<GithubPrDto[]> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubCurrentPrSummary: (projectId: string) =>
    jfetch<GhListResult<CurrentPrSummaryDto>>(
      `/api/github/pr/current?projectId=${encodeURIComponent(projectId)}`,
    ).catch((): GhListResult<CurrentPrSummaryDto> => ({
      ok: false,
      reason: tr("settings.pages.serverUnreachable"),
    })),

  // ---- PR detail surfaces (fail-soft) ------------------------------------------
  githubPrDetail: (projectId: string, number: number) =>
    jfetch<GhListResult<PrDetailDto>>(`/api/github/pr?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<PrDetailDto> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubPrFiles: (projectId: string, number: number) =>
    jfetch<GhListResult<PrFileDto[]>>(`/api/github/pr/files?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<PrFileDto[]> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubPrChecks: (projectId: string, number: number) =>
    jfetch<GhListResult<{ checks: PrCheckDto[]; summary: ChecksSummaryDto }>>(
      `/api/github/pr/checks?projectId=${encodeURIComponent(projectId)}&number=${number}`,
    ).catch((): GhListResult<{ checks: PrCheckDto[]; summary: ChecksSummaryDto }> => ({
      ok: false,
      reason: tr("settings.pages.serverUnreachable"),
    })),
  githubPrComments: (projectId: string, number: number) =>
    jfetch<GhListResult<PrCommentDto[]>>(`/api/github/pr/comments?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<PrCommentDto[]> => ({ ok: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  githubPrDiff: (projectId: string, number: number) =>
    jfetch<GhListResult<string>>(`/api/github/pr/diff?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<string> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubSubmitReview: (number: number, input: {
    projectId: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string;
    comments?: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; startLine?: number; body: string }>;
    commitSha?: string; confirm?: boolean; sessionId?: string;
  }) =>
    jfetch<GhListResult<{ id: string; url?: string }>>(`/api/github/pr/${number}/reviews`, json("POST", input)),
  githubAddComment: (kind: "issue" | "pr", number: number, input: {
    projectId: string; body: string; sessionId?: string;
  }) =>
    jfetch<GhListResult<{ url: string }>>(`/api/github/${kind}/${number}/comments`, json("POST", input)),
  githubAddLabels: (number: number, projectId: string, labels: string[]) =>
    jfetch<GhListResult<{ labels: string[] }>>(`/api/github/pr/${number}/labels`, json("POST", { projectId, labels })),

  // ---- PR lifecycle: explicit external writes + AI describe ----------------
  githubPrCreate: (input: { projectId: string; title: string; body: string; base?: string; draft?: boolean; sessionId?: string }) =>
    jfetch<GhListResult<{ number: number; url: string }>>(`/api/github/pr/create`, json("POST", input)),
  githubPrUpdate: (input: { projectId: string; number: number; title?: string; body?: string; base?: string; sessionId?: string }) =>
    jfetch<GhListResult<{ number: number }>>(`/api/github/pr/update`, json("POST", input)),
  githubPrMerge: (input: { projectId: string; number: number; strategy: "squash" | "merge" | "rebase"; sessionId?: string }) =>
    jfetch<GhListResult<{ number: number; strategy: string }>>(`/api/github/pr/merge`, json("POST", { ...input, confirm: true })),
  githubConflictAgent: (input: {
    projectId: string;
    number: number;
    prompt: string;
    target: "new-session" | "current-session";
    sessionId?: string;
  }) =>
    jfetch<GhListResult<{ sessionId: string }>>(`/api/github/pr/conflict-agent`, json("POST", input)),
  githubPrDescribe: (projectId: string, base?: string) =>
    jfetch<GhListResult<{ title: string; body: string }>>(`/api/github/pr/describe`, json("POST", { projectId, ...(base ? { base } : {}) })).catch(
      (e: unknown): GhListResult<{ title: string; body: string }> => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }),
    ),

  // ---- generated walkthroughs + reviews -----------------------------------------
  walkthroughGenerate: (source: WalkthroughSourceDto, sessionId?: string) =>
    jfetch<GeneratedWalkthroughDto>(`/api/walkthroughs`, json("POST", { source, ...(sessionId ? { sessionId } : {}) })),
  walkthroughJob: (id: string) =>
    jfetch<GeneratedWalkthroughDto>(`/api/walkthroughs/${encodeURIComponent(id)}`),
  walkthroughCancel: (id: string) =>
    jfetch<GeneratedWalkthroughDto>(`/api/walkthroughs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  walkthroughSourceStatus: (id: string) =>
    jfetch<{ stale: boolean; sourceDigest: string; currentDigest: string }>(
      `/api/walkthroughs/${encodeURIComponent(id)}/source-status`,
    ),
  reviewGenerate: (sessionId: string, source: WalkthroughSourceDto) =>
    jfetch<ReviewResultDto>(`/api/sessions/${encodeURIComponent(sessionId)}/review/generate`, json("POST", { source })),
  reviewFlowCreate: (sessionId: string, maxIterations?: number) =>
    jfetch<ReviewFlowStateDto>(`/api/sessions/${encodeURIComponent(sessionId)}/review-flow`, json("POST", maxIterations ? { maxIterations } : {})),
  reviewFlowGet: (sessionId: string) =>
    jfetch<ReviewFlowStateDto>(`/api/sessions/${encodeURIComponent(sessionId)}/review-flow`).catch(() => null),
  reviewFlowAction: (sessionId: string, action: "pause" | "resume" | "stop") =>
    jfetch<ReviewFlowStateDto>(`/api/sessions/${encodeURIComponent(sessionId)}/review-flow/${action}`, { method: "POST" }),


  sessionRetention: (days: number, target: SessionRetentionTarget = "sessions") =>
    jfetch<SessionRetentionDto>(
      `/api/session-retention?days=${encodeURIComponent(days)}&target=${encodeURIComponent(target)}`,
    ),
  runSessionRetention: (days: number, action: SessionRetentionAction = "archive") =>
    jfetch<SessionRetentionResultDto>(
      "/api/session-retention",
      json("POST", { days, action }),
    ),
  deleteArchivedSessions: (days: number) =>
    jfetch<SessionRetentionResultDto>(
      "/api/session-retention",
      json("POST", { target: "archives", days }),
    ),
  deleteAllArchivedSessions: () =>
    jfetch<SessionRetentionResultDto>(
      "/api/session-retention",
      json("POST", { target: "archives", all: true }),
    ),

  // ---- session control ---------------------------------------------------------
  controlSessions: (projectId?: string) =>
    jfetch<SessionProjection[]>(`/api/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  controlNew: (projectId: string, title?: string) =>
    jfetch<SessionRef>(`/api/sessions`, json("POST", { projectId, title })),
  controlFork: (sessionId: string, atSeq?: number) =>
    jfetch<SessionRef>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, json("POST", atSeq === undefined ? {} : { atSeq })),
  controlAbort: (sessionId: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, json("POST", { source: "control" })),

  // ---- commands + snippets CRUD ------------------------------------------------
  saveCommand: (projectId: string, scope: "user" | "project", cmd: { name: string; prompt: string; description?: string; agent?: string; model?: string }) =>
    jfetch<{ ok: true }>(`/api/commands`, json("POST", { projectId, scope, ...cmd })),
  deleteCommand: (projectId: string, scope: "user" | "project", name: string) =>
    jfetch<{ ok: boolean }>(`/api/commands`, json("DELETE", { projectId, scope, name })),
  saveSnippet: (projectId: string, scope: "user" | "project", snippet: { alias: string; text: string }) =>
    jfetch<{ ok: true }>(`/api/snippets`, json("POST", { projectId, scope, ...snippet })),
  deleteSnippet: (projectId: string, scope: "user" | "project", alias: string) =>
    jfetch<{ ok: boolean }>(`/api/snippets`, json("DELETE", { projectId, scope, alias })),
  saveSkill: (projectId: string, scope: SkillScope, skill: { name: string; description: string; instructions: string }) =>
    jfetch<{ ok: true }>(`/api/skills`, json("POST", { projectId, scope, ...skill })),
  deleteSkill: (projectId: string, scope: SkillScope, name: string) =>
    jfetch<{ ok: boolean }>(`/api/skills`, json("DELETE", { projectId, scope, name })),

  // ---- shared internal browser ------------------------------------------------
  browserCapability: () =>
    jfetch<{ available: boolean; engine: "chromium" | "fake" | null; reason?: string }>(`/api/browser/capability`).catch(
      () => ({ available: false, engine: null, reason: tr("settings.pages.serverUnreachable") }),
    ),
  browserCreate: (input: {
    projectId: string;
    sessionId?: string;
    url?: string;
    viewport?: { width: number; height: number };
    colorScheme?: "light" | "dark" | "no-preference";
  }) =>
    jfetch<BrowserSessionDto>(`/api/browser/sessions`, json("POST", input)),
  browserGet: (id: string) =>
    jfetch<BrowserSessionDto>(`/api/browser/sessions/${encodeURIComponent(id)}`),
  browserList: (projectId?: string) =>
    jfetch<BrowserSessionDto[]>(`/api/browser/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`).catch(
      (): BrowserSessionDto[] => [],
    ),
  browserNavigate: (id: string, url: string, actor: "user" | "agent" = "user") =>
    jfetch<BrowserNavigateResponse>(`/api/browser/sessions/${encodeURIComponent(id)}/navigate`, json("POST", { url, actor })),
  browserAction: (id: string, action: BrowserActionDto, actor: "user" | "agent" = "user") =>
    jfetch<{ actionId: string; session: BrowserSessionDto; result?: JsonObject }>(
      `/api/browser/sessions/${encodeURIComponent(id)}/actions`, json("POST", { action, actor }),
    ),
  browserObserve: (id: string, includeScreenshot = false, selector?: string) =>
    jfetch<{
      url: string;
      title: string;
      text: string;
      accessibilityDigest: string;
      screenshotRef?: string;
      screenshot?: { mime: string; data: string };
    }>(
      `/api/browser/sessions/${encodeURIComponent(id)}/observe`, json("POST", {
        includeScreenshot,
        ...(selector ? { selector } : {}),
      }),
    ),
  browserCaptureContext: (id: string, input: import("@polyth/contracts").BrowserContextCaptureInput) =>
    jfetch<{ context: import("@polyth/contracts").BrowserContext }>(
      `/api/browser/sessions/${encodeURIComponent(id)}/context`,
      json("POST", input as unknown as JsonObject),
    ),
  browserArtifactUrl: (artifactId: string) =>
    `/api/browser/artifacts?id=${encodeURIComponent(artifactId)}`,
  browserClose: (id: string) =>
    jfetch<{ ok: true }>(`/api/browser/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  browserPauseAgent: (id: string, paused: boolean) =>
    jfetch<{ ok: true; paused: boolean }>(`/api/browser/sessions/${encodeURIComponent(id)}/pause-agent`, json("POST", { paused })),
  browserConsole: (id: string) =>
    jfetch<Array<{ at: number; level: string; message: string }>>(`/api/browser/sessions/${encodeURIComponent(id)}/console`).catch(
      (): Array<{ at: number; level: string; message: string }> => [],
    ),
  browserApprove: (origin: string, browserSessionId: string) =>
    jfetch<{ origins: string[] }>(`/api/browser/approvals`, json("POST", { origin, browserSessionId })),
  browserAgentAutoApproveGet: () =>
    jfetch<{ enabled: boolean }>(`/api/browser/agent-auto-approve`),
  browserAgentAutoApproveSet: (enabled: boolean) =>
    jfetch<{ enabled: boolean }>(`/api/browser/agent-auto-approve`, json("PATCH", { enabled })),
  browserVaultFillRequests: (browserSessionId: string) =>
    jfetch<BrowserVaultFillRequestDto[]>(
      `/api/browser/vault-fill-requests?browserSessionId=${encodeURIComponent(browserSessionId)}`,
    ).catch((): BrowserVaultFillRequestDto[] => []),
  browserVaultFillDecision: (requestId: string, decision: "allow" | "allow-always" | "deny") =>
    jfetch<{ ok: true }>(
      `/api/browser/vault-fill-requests/${encodeURIComponent(requestId)}`,
      json("POST", { decision }),
    ),
  browserVaultFillApprovals: () =>
    jfetch<BrowserVaultFillApprovalDto[]>("/api/browser/vault-fill-approvals").catch(
      (): BrowserVaultFillApprovalDto[] => [],
    ),
  browserVaultFillApprovalsClear: () =>
    jfetch<{ ok: true }>("/api/browser/vault-fill-approvals", { method: "DELETE" }),

  // ---- streaming dictation (audio itself travels over /ws) ---------------------
  dictationCapability: () =>
    jfetch<{ available: boolean; engine?: string; reason?: string }>(`/api/dictation/capability`).catch(
      () => ({ available: false, reason: tr("settings.pages.serverUnreachable") }),
    ),
  dictationCreate: (input: { sessionId?: string; language?: string }) =>
    jfetch<DictationSessionDto>(`/api/dictation`, json("POST", input as JsonObject)),
  dictationGet: (id: string) =>
    jfetch<DictationSessionDto>(`/api/dictation/${encodeURIComponent(id)}`),
  dictationFinalize: (id: string) =>
    jfetch<DictationSessionDto>(`/api/dictation/${encodeURIComponent(id)}/finalize`, { method: "POST" }),
  dictationCancel: (id: string) =>
    jfetch<{ ok: true }>(`/api/dictation/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- voice engines: server settings + TTS proxy ---------------------------
  voiceSettings: () => jfetch<VoiceSettingsDto>(`/api/settings/voice`),
  voiceSettingsSave: (next: {
    stt: { baseUrl: string; model: string; language: string; apiKeyEnv: string };
    tts: { baseUrl: string; model: string; voice: string; apiKeyEnv: string };
    /** Write-only keys by slot; null forgets a stored key. */
    keys?: Record<string, string | null>;
  }) => jfetch<VoiceSettingsDto>(`/api/settings/voice`, json("PUT", next)),
  /** Buffered clip from the configured OpenAI-compatible TTS server. */
  ttsSpeak: async (text: string, opts: { model?: string; voice?: string } = {}): Promise<ArrayBuffer> => {
    const res = await fetch(`/api/tts/speak`, json("POST", { text, ...opts }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(body.message ?? tr("api.ttsFailedHttpValue", { status: res.status }));
    }
    return res.arrayBuffer();
  },
  ttsSummarize: (text: string) => jfetch<{ text: string }>(`/api/tts/summarize`, json("POST", { text })),

  // ---- SSH remotes ---------------------------------------------------------------
  sshConnections: () =>
    jfetch<{ items: SshConnectionWithStatus[] }>("/api/ssh/connections"),
  sshCreateConnection: (input: SshConnectionInput) =>
    jfetch<SshConnectionDto>("/api/ssh/connections", json("POST", input)),
  sshUpdateConnection: (id: string, input: SshConnectionInput) =>
    jfetch<SshConnectionDto>(`/api/ssh/connections/${encodeURIComponent(id)}`, json("PATCH", input)),
  sshDeleteConnection: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/ssh/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  sshConnect: (id: string) =>
    jfetch<SshConnectionStatusDto>(`/api/ssh/connections/${encodeURIComponent(id)}/connect`, json("POST", {})),
  sshDisconnect: (id: string) =>
    jfetch<SshConnectionStatusDto>(`/api/ssh/connections/${encodeURIComponent(id)}/disconnect`, json("POST", {})),
  sshStatus: (id: string) =>
    jfetch<SshConnectionStatusDto>(`/api/ssh/connections/${encodeURIComponent(id)}/status`),
  sshTest: (id: string) =>
    jfetch<SshTestResultDto>(`/api/ssh/connections/${encodeURIComponent(id)}/test`, json("POST", {})),
  sshInstallOpenCode: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/ssh/connections/${encodeURIComponent(id)}/install`, json("POST", {})),
  /** Enabled harnesses for one host; `probe` reaches the host to check them. */
  sshHarnesses: (id: string, probe = false) =>
    jfetch<import("@polyth/contracts").SshRemoteHarnessesDto>(
      `/api/ssh/connections/${encodeURIComponent(id)}/harnesses${probe ? "?probe=1" : ""}`,
    ),
  sshInstallHarness: (id: string, harnessId: string) =>
    jfetch<import("@polyth/contracts").SshRemoteHarnessDto>(
      `/api/ssh/connections/${encodeURIComponent(id)}/harnesses/${encodeURIComponent(harnessId)}/install`,
      json("POST", {}),
    ),
  sshBrowse: (connectionId: string, path?: string) =>
    jfetch<SshBrowseDto>(
      `/api/ssh/browse?connectionId=${encodeURIComponent(connectionId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
    ),
  sshCreateProject: (input: { connectionId: string; path: string; name?: string; createDirectory?: boolean }) =>
    jfetch<Project>("/api/ssh/projects", json("POST", input)),

  promptHistory: (opts: { scope: "session" | "space"; sessionId?: string; limit: number }) => {
    const q = new URLSearchParams({ scope: opts.scope, limit: String(opts.limit) });
    if (opts.sessionId) q.set("sessionId", opts.sessionId);
    return jfetch<PromptHistoryDto>(`/api/prompt-history?${q}`);
  },
  sessionPrompts: (sessionId: string, beforeSeq?: number, init?: RequestInit) => {
    const q = new URLSearchParams({ sessionId, limit: "40" });
    if (beforeSeq !== undefined) q.set("beforeSeq", String(beforeSeq));
    return jfetch<import("@polyth/contracts").SessionPromptPageDto>(`/api/prompt-history/navigation?${q}`, init);
  },

  // ---- shared client preferences (Appearance, chat, notifications, …) ----------
  /** Server copy of this workspace's client settings; `revision` 0 means the
   *  server has never been written and the local record should seed it. */
  clientSettings: () => jfetch<ClientSettingsDto>(`/api/settings/client`),
  clientSettingsSave: (settings: Record<string, unknown>, opts?: { keepalive?: boolean; expectedRevision?: number }) =>
    jfetch<ClientSettingsDto>(`/api/settings/client`, {
      ...json("PUT", { settings, expectedRevision: opts?.expectedRevision }),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    }),

  // ---- explicit suggestion/chat→note --------------------------------------------
  /** Explicit ephemeral composer draft; it is never saved to the session. */
  assistSuggestion: (sessionId: string, draft?: string) =>
    jfetch<AssistSuggestionDto>(
      `/api/sessions/${encodeURIComponent(sessionId)}/assist/suggestion`,
      json("POST", draft ? { draft } : {}),
    ),
  assistPrompt: (projectId: string, draft: string) =>
    jfetch<AssistSuggestionDto>(
      `/api/projects/${encodeURIComponent(projectId)}/assist/prompt`,
      json("POST", { draft }),
    ),
  /** Small-model chat→note DRAFT; saving still goes through knowledgeCreate. */
  assistNote: (sessionId: string) =>
    jfetch<{ title: string; body: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/assist/note`, json("POST", {})),

  // ---- backend session import -----------------------------------------------
  backendSessions: (projectId: string) =>
    jfetch<{ items: RuntimeSession[]; total: number }>(
      `/api/agent/backend-sessions?projectId=${encodeURIComponent(projectId)}`,
    ),
  importBackendSessions: (projectId: string, ids: string[]) =>
    jfetch<SessionProjection[]>(`/api/agent/backend-sessions/import`, json("POST", { projectId, ids })),

  // ---- auto-accept policy ---------------------------------------------------
  autoAcceptGet: (sessionId: string) =>
    jfetch<AutoAcceptDto>(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/auto-accept`),
  autoAcceptSet: (sessionId: string, setting: AutoAcceptSetting) =>
    jfetch<AutoAcceptDto>(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/auto-accept`, json("PATCH", { setting })),

  // ---- web push --------------------------------------------------------------
  pushKey: () => jfetch<{ publicKey: string; subscriptions: number }>(`/api/push/key`),
  pushSubscribe: (sub: unknown) => jfetch<{ ok: boolean }>(`/api/push/subscribe`, json("POST", sub)),
  pushUnsubscribe: (endpoint: string) => jfetch<{ ok: boolean }>(`/api/push/subscribe`, json("DELETE", { endpoint })),
  pushTest: (endpoint?: string) => jfetch<{ sent: number; dropped: number; failed: number; ownDropped: boolean }>(
    `/api/push/test`, json("POST", endpoint ? { endpoint } : {}),
  ),

  // ---- notification centre (NTF-01) -----------------------------------------------
  listNotifications: (after?: number) =>
    jfetch<{ items: NotificationRecord[]; unread: number }>(
      `/api/notifications${after && after > 0 ? `?after=${after}` : ""}`,
    ),
  notificationsRead: (ids: string[]) =>
    jfetch<{ updated: number; unread: number }>(`/api/notifications/read`, json("POST", { ids })),
  notificationsReadAll: () =>
    jfetch<{ updated: number; unread: number }>(`/api/notifications/read-all`, json("POST", {})),
  notificationsClear: () =>
    jfetch<{ cleared: number; unread: number }>(`/api/notifications/clear`, json("POST", {})),

  // ---- access control -------------------------------------------------------
  authStatus: () => jfetch<AuthStatusDto>(`/api/auth/status`),
  /** Never throws on auth failures: the lock screen needs the structured body
   *  (retryAfterSec) and must not trigger the global 401 handler. */
  authLogin: async (password: string): Promise<AuthLoginResult> => {
    const res = await fetch(`/api/auth/login`, json("POST", { password }));
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string; retryAfterSec?: number };
    return {
      ok: false,
      error: body.error ?? `http-${res.status}`,
      message: body.message ?? tr("api.httpStatusValue", { status: res.status }),
      ...(typeof body.retryAfterSec === "number" ? { retryAfterSec: body.retryAfterSec } : {}),
    };
  },
  authLogout: () => jfetch<{ ok: boolean }>(`/api/auth/logout`, json("POST", {})),
  authLogoutAll: () => jfetch<{ ok: boolean }>(`/api/auth/logout-all`, json("POST", {})),
  authSessions: () => jfetch<AuthDeviceDto[]>(`/api/auth/sessions`),
  authRevoke: (id: string) => jfetch<{ ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// ---- SSH remotes DTOs -----------------------------------------------------------
export type SshConnectionWithStatus = SshConnectionDto & { status?: SshConnectionStatusDto };
export type SshTestResultDto = SshConnectionStatusDto & {
  /** Agent-runtime availability on the remote (probed only on success). */
  runtime?: { ok: boolean; version?: string; message?: string; installable?: boolean };
};

// ---- access control DTOs ---------------------------------------------------
export interface AuthStatusDto {
  required: boolean;
  authorized: boolean;
}

export interface AuthDeviceDto {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  label: string;
  current: boolean;
}

export type AuthLoginResult =
  | { ok: true }
  | { ok: false; error: string; message: string; retryAfterSec?: number };
