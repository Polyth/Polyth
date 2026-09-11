// Typed fetch wrappers for every REST endpoint in PLAN.md §5.
import type {
  AgentDescriptor,
  AgentProfile,
  AttachmentRef,
  AuthAttemptDto,
  AutoAcceptDto,
  AutoAcceptSetting,
  BulkSessionResult,
  ClientSettingsDto,
  PromptHistoryDto,
  DictationSessionDto,
  ForkResult,
  FusionDto,
  HomeAssistantConfigDto,
  HomeAssistantConfigInput,
  HomeAssistantConnectionDto,
  HomeAssistantEntityDto,
  HarnessSelection,
  HarnessSnapshot,
  InstalledPluginDto,
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
  PackageCapabilityRequestDto,
  PackageConnectionPublicDto,
  PackageDescriptorDto,
  ProviderAuthCapabilitiesDto,
  ProviderAuthView,
  SystemInfoDto,
  TrackCreateInput,
  TrackDto,
  Project,
  ProjectCloneInput,
  ProjectPatch,
  QueueItemDto,
  RuntimeDiagnosticsDto,
  RuntimeFeaturesDto,
  RuntimeSession,
  SecureSafeCreateInput,
  SecureSafeEntryDto,
  SendResult,
  SessionDebugDto,
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
  WorkspaceLabel,
  CreateIsolatedSessionInput,
  IsolationMergeResultDto,
  IsolationStatusDto,
} from "@polyth/contracts";
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
  path: string;
  kind: "file" | "dir";
  score: number;
  matches: Array<[number, number]>;
}

export interface SessionSearchResult {
  sessionId: string;
  title: string;
  status: string;
  updatedAt: number;
  matches: Array<{ field: string; snippet: string }>;
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

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    // F16: a 401 outside the auth endpoints means the device session is gone
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
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; details?: unknown; field?: unknown; changes?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") message = parsed.message;
      if (typeof parsed.details === "string") details = parsed.details;
      if (typeof parsed.field === "string") field = parsed.field;
      if (typeof parsed.changes === "number") changes = parsed.changes;
    } catch {
      // non-JSON error body
    }
    throw Object.assign(
      new Error(message ?? tr("api.httpErrorValueValueValue", {
        status: res.status,
        statusText: res.statusText,
        body,
      })),
      {
        status: res.status,
        ...(code !== undefined ? { code } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(field !== undefined ? { field } : {}),
        ...(changes !== undefined ? { changes } : {}),
      },
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const httpStatusOf = (err: unknown): number =>
  typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 0;

/** Typed error code from a server error body (e.g. "conflict", "history-mismatch"). */
export const errorCodeOf = (err: unknown): string =>
  typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";

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
export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  clean?: boolean;
  /** Explicit false for plain folders; omitted by older servers. */
  isRepo?: boolean;
}
export interface GitDiffResult { path: string; diff: string }
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
}

// ---- file types (§12) ------------------------------------------------------
export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
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

/** Strict list outcome (UX-COMPOSER-DISC): a request failure is never
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
  status: "running" | "ok" | "failed" | "skipped";
  error?: string;
  sessionId?: string;
}

export interface ScheduleTaskDto {
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
export interface ScheduleTaskInputDto {
  projectId: string;
  prompt: string;
  kind?: "at" | "every" | "cron";
  at?: number;
  everyMinutes?: number;
  cadence?: ScheduleCadenceDto;
  target?: ScheduleTargetDto;
  overlapPolicy?: "skip" | "queue" | "parallel";
  sessionId?: string;
  title?: string;
  enabled?: boolean;
}

// ---- knowledge types (WP10) --------------------------------------------------
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

// ---- voice engines (F8) -------------------------------------------------------
export interface VoiceSettingsDto {
  stt: { baseUrl: string; model: string; language: string; apiKeyEnv: string };
  tts: { baseUrl: string; model: string; voice: string; apiKeyEnv: string };
  sttConfigured: boolean;
  ttsConfigured: boolean;
}

// ---- idle assist (F9) ----------------------------------------------------------
export interface AssistSettingsDto { enabled: boolean; idleSeconds: number }
export interface AssistDto { recap: string; suggestion: string; atSeq: number; generatedAt: number }
export interface AssistSuggestionDto { suggestion: string; atSeq: number }
export interface TaskBriefDto { brief: string }

// ---- PR detail + checks (WP11) ----------------------------------------------
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

// ---- generated walkthrough + review (WP11) -----------------------------------
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

// ---- quota types (WP12) ------------------------------------------------------
export interface QuotaWindowDto {
  id: string; label: string; used: number; limit: number;
  unit: "tokens" | "requests" | "currency" | "percent";
  resetsAt?: number; periodMs?: number;
}
export interface QuotaPaceDto {
  usageFraction: number; timeFraction: number; pace: "under" | "on-track" | "over";
  predictedAtReset?: number; exhaustsAt?: number;
}
export interface QuotaSnapshotDto {
  providerId: string; accountLabel?: string; windows: QuotaWindowDto[];
  fetchedAt: number; stale: boolean; error?: { code: string; message: string };
  pace: Record<string, QuotaPaceDto | null>;
  overview?: {
    providerId: string;
    accountLabel?: string;
    stale: boolean;
    windows: Array<QuotaWindowDto & { usedFraction: number; remainingFraction: number }>;
    highestUsedFraction: number;
  };
}

export interface SessionRetentionDto {
  days: number;
  cutoff: number;
  eligibleCount: number;
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
}

export const api = {
  health: () => jfetch<Health>("/api/health"),
  packagesList: (): Promise<{ packages: PackageDescriptorDto[] }> =>
    jfetch<{ packages: PackageDescriptorDto[] }>("/api/packages"),
  packagesSetEnabled: (id: string, enabled: boolean): Promise<PackageDescriptorDto> =>
    jfetch<PackageDescriptorDto>(`/api/packages/${encodeURIComponent(id)}`, json("PATCH", { enabled })),

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

  listProjects: () => jfetch<Project[]>("/api/projects"),
  addProject: (path: string, name?: string) =>
    jfetch<Project>("/api/projects", json("POST", { path, name })),
  createProject: (path: string, name?: string) =>
    jfetch<Project>("/api/projects/create", json("POST", { path, name })),
  cloneProject: (input: ProjectCloneInput | string, parentPath?: string) =>
    jfetch<Project>("/api/projects/clone", json("POST", typeof input === "string"
      ? { repository: input, parentPath: parentPath ?? "" }
      : input)),
  deleteProject: (id: string) => jfetch<void>(`/api/projects/${id}`, { method: "DELETE" }),
  patchProject: (id: string, patch: ProjectPatch) =>
    jfetch<Project>(`/api/projects/${id}`, json("PATCH", patch)),

  listSessions: (projectId: string) => jfetch<SessionProjection[]>(`/api/sessions?projectId=${encodeURIComponent(projectId)}`),
  createSession: (input: { projectId: string; harness?: HarnessSelection; title?: string; model?: ModelRef; agent?: string; worktreePath?: string }) =>
    jfetch<SessionRef>("/api/sessions", json("POST", input)),
  getSession: (id: string) => jfetch<SessionProjection>(`/api/sessions/${id}`),
  sessionDebug: (id: string) =>
    jfetch<{ debug: SessionDebugDto }>(`/api/agent/sessions/${encodeURIComponent(id)}/debug`),
  /** `page` (beforeSeq/limit) keyset-pages the NEWEST events in the window —
   *  the deep-log hydration path fetches a recent window first and backfills
   *  older history in chunks (beforeSeq = oldest loaded seq). */
  getEvents: (id: string, afterSeq = 0, page?: { beforeSeq?: number; limit?: number; prefetch?: boolean }) =>
    jfetch<SessionEvent[]>(`/api/sessions/${id}/events?afterSeq=${afterSeq}`
      + (page?.beforeSeq !== undefined ? `&beforeSeq=${page.beforeSeq}` : "")
      + (page?.limit !== undefined ? `&limit=${page.limit}` : "")
      + (page?.prefetch !== undefined ? `&prefetch=${page.prefetch ? "1" : "0"}` : "")),

  // agentProfileId: string selects a profile, null explicitly clears the
  // session's stored profile, omitted inherits it (UX-COMPOSER-DISC).
  sendMessage: (id: string, body: { text: string; command?: { id: string; args?: string }; autoTitle?: boolean; attachments?: AttachmentRef[]; model?: JsonObject; agent?: string; harness?: HarnessSelection; delivery?: string; dismissPending?: boolean; agentProfileId?: string | null }) =>
    jfetch<SendResult>(`/api/sessions/${id}/message`, json("POST", body)),
  runtimeFeatures: (id: string) =>
    jfetch<RuntimeFeaturesDto>(`/api/harnesses/sessions/${encodeURIComponent(id)}/features`),
  abort: (id: string) => jfetch<void>(`/api/sessions/${id}/abort`, { method: "POST" }),
  /** Drop a pending rate-limit auto-resume; the session stays failed. */
  cancelResume: (id: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/resume/cancel`, { method: "POST" }),
  /** Run the pending rate-limit resume now, optionally on a different model
   *  (which also becomes the session's model going forward). */
  resumeNow: (id: string, model?: ModelRef) =>
    jfetch<SendResult>(`/api/sessions/${id}/resume/now`, json("POST", model ? { model } : {})),
  taskBrief: (id: string) => jfetch<TaskBriefDto>(`/api/sessions/${encodeURIComponent(id)}/task-brief`, json("POST", {})),
  confirmBorrowedRuntimeEpoch: (id: string) =>
    jfetch<SessionProjection>(`/api/sessions/${id}/runtime-epoch`, json("POST", { confirm: true })),
  renameSession: (id: string, title: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/rename`, json("POST", { title })),
  /** Advance the user's read cursor so navigator unread bold clears. */
  markSessionRead: (id: string, seq: number) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/read`, json("POST", { seq })),
  saveDraft: (id: string, text: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/draft`, json("PATCH", { text })),

  // ---- delivery queue (WP3) -------------------------------------------------
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
  deleteSession: (id: string) => jfetch<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),

  // ---- organization (WP5) ----------------------------------------------------
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
  searchSessions: (q: string, projectId?: string, limit = 30, signal?: AbortSignal) =>
    jfetch<SessionSearchResult[]>(
      `/api/search/sessions?q=${encodeURIComponent(q)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}&limit=${limit}`,
      { signal },
    ),

  // ---- agent profiles (WP8) --------------------------------------------------
  listProfiles: () => jfetch<AgentProfile[]>(`/api/agent-profiles`).catch((): AgentProfile[] => []),
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

  // ---- behavior / system / MCP / managed plugins (WP9) ----------------------
  behaviorGet: () => jfetch<{ text: string; revision: string; pathLabel: string }>("/api/settings/behavior"),
  behaviorPut: (text: string, expectedRevision: string) =>
    jfetch<{ text: string; revision: string; pathLabel: string }>("/api/settings/behavior", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, expectedRevision }) }),
  subagentPolicyGet: () => jfetch<{ enabled: boolean }>("/api/settings/behavior/subagents"),
  subagentPolicyPut: (enabled: boolean) =>
    jfetch<{ enabled: boolean }>("/api/settings/behavior/subagents", json("PUT", { enabled })),
  systemInfo: () => jfetch<SystemInfoDto>("/api/system/info"),
  mcpList: () => jfetch<McpServerDto[]>("/api/mcp/servers").catch((): McpServerDto[] => []),
  mcpCreate: (input: { name: string; transport: McpTransport; secrets?: Record<string, string>; enabled?: boolean }) =>
    pendingMutation(jfetch<McpServerDto>("/api/mcp/servers", json("POST", input))),
  mcpUpdate: (id: string, patch: { name?: string; transport?: McpTransport; secrets?: Record<string, string>; enabled?: boolean }, expectedRevision: number) =>
    pendingMutation(jfetch<McpServerDto>(`/api/mcp/servers/${encodeURIComponent(id)}`, json("PATCH", { ...patch, expectedRevision }))),
  mcpRemove: (id: string) => pendingMutation(jfetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" })),
  mcpTest: (id: string) => jfetch<{ ok: boolean; message: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, json("POST", {})),
  /** F10: spec-named probe — same reachability check, stores status/lastError. */
  mcpProbe: (id: string) => jfetch<{ ok: boolean; message: string }>(`/api/mcp/servers/${encodeURIComponent(id)}/probe`, json("POST", {})),
  pluginsList: () => jfetch<InstalledPluginDto[]>("/api/plugins").catch((): InstalledPluginDto[] => []),
  pluginsInstall: (source: string) => jfetch<InstalledPluginDto>("/api/plugins/install", json("POST", { source })),
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
  browseMkdir: (path: string) =>
    jfetch<{ path: string }>(`/api/browse/mkdir`, json("POST", { path })),

  // ---- git (§12) -----------------------------------------------------------
  gitStatus: (projectId: string, sessionId?: string) =>
    jfetch<GitStatus>(`/api/git/status?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  gitIdentity: (projectId: string) =>
    jfetch<{ name: string; email: string }>(`/api/git/identity?projectId=${encodeURIComponent(projectId)}`),
  gitIdentitySet: (projectId: string, identity: { name: string; email: string }) =>
    jfetch<{ name: string; email: string }>(`/api/git/identity`, json("POST", { projectId, ...identity })),
  gitDiff: (projectId: string, filePath: string, staged?: boolean, ignoreWhitespace?: boolean, sessionId?: string) =>
    jfetch<GitDiffResult>(
      `/api/git/diff?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}${staged ? "&staged=true" : ""}${ignoreWhitespace ? "&ignoreWhitespace=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  gitShow: (projectId: string, sha: string, ignoreWhitespace?: boolean, sessionId?: string) =>
    jfetch<{ sha: string; diff: string }>(
      `/api/git/show?projectId=${encodeURIComponent(projectId)}&sha=${encodeURIComponent(sha)}${ignoreWhitespace ? "&ignoreWhitespace=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  gitStage: (projectId: string, paths: string[], sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/stage`, json("POST", { projectId, paths, ...(sessionId ? { sessionId } : {}) })),
  gitUnstage: (projectId: string, paths: string[], sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/unstage`, json("POST", { projectId, paths, ...(sessionId ? { sessionId } : {}) })),
  gitDiscard: (projectId: string, paths: string[], sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/discard`, json("POST", { projectId, paths, ...(sessionId ? { sessionId } : {}) })),
  gitCommit: (projectId: string, message: string, sessionId?: string) =>
    jfetch<{ sha: string }>(`/api/git/commit`, json("POST", { projectId, message, ...(sessionId ? { sessionId } : {}) })),
  gitCommitMessage: (projectId: string, sessionId?: string) =>
    jfetch<{ message: string }>(`/api/git/commit-message`, json("POST", { projectId, ...(sessionId ? { sessionId } : {}) })),
  gitBranches: (projectId: string, sessionId?: string) =>
    jfetch<GitBranches>(`/api/git/branches?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  gitBranch: (projectId: string, name: string, from?: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/branch`, json("POST", { projectId, name, from, ...(sessionId ? { sessionId } : {}) })),
  gitCheckout: (projectId: string, name: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/checkout`, json("POST", { projectId, name, ...(sessionId ? { sessionId } : {}) })),
  gitLog: (projectId: string, limit = 20, sessionId?: string) =>
    jfetch<GitLogEntry[]>(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  gitGraph: (projectId: string, limit = 40, skip = 0, sessionId?: string) =>
    jfetch<GitGraphEntry[]>(`/api/git/graph?projectId=${encodeURIComponent(projectId)}&limit=${limit}&skip=${skip}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  gitFolder: (projectId: string, folder: string, op: "stage" | "unstage" | "discard", sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/folder`, json("POST", { projectId, folder, op, ...(sessionId ? { sessionId } : {}) })),
  gitStashes: (projectId: string, sessionId?: string) =>
    jfetch<GitStash[]>(`/api/git/stashes?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  gitStashPush: (projectId: string, message?: string, sessionId?: string) =>
    jfetch<{ created: boolean }>(`/api/git/stash`, json("POST", { projectId, message, ...(sessionId ? { sessionId } : {}) })),
  gitStashApply: (projectId: string, ref: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/stash/apply`, json("POST", { projectId, ref, ...(sessionId ? { sessionId } : {}) })),
  gitStashDrop: (projectId: string, ref: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/stash/drop`, json("POST", { projectId, ref, ...(sessionId ? { sessionId } : {}) })),
  gitFetch: (projectId: string, remote = "origin", sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/fetch`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}) })),
  gitPull: (projectId: string, remote = "origin", sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/pull`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}) })),
  gitPush: (projectId: string, remote = "origin", sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/push`, json("POST", { projectId, remote, ...(sessionId ? { sessionId } : {}) })),
  /** Local-conflict sibling of githubConflictAgent: hands a diverged pull or an
   *  in-progress merge/rebase to an agent session with a default prompt. */
  gitResolveConflictAgent: (input: {
    projectId: string;
    target: "new-session" | "current-session";
    prompt: string;
    sessionId?: string;
  }) =>
    jfetch<GhListResult<{ sessionId: string }>>(
      `/api/git/resolve-conflict-agent`,
      json("POST", input),
    ),

  // ---- worktrees (§12) -----------------------------------------------------
  listWorktrees: (projectId: string) =>
    jfetch<Worktree[]>(`/api/worktrees?projectId=${encodeURIComponent(projectId)}`),
  createWorktree: (projectId: string, branch: string, wtPath?: string, base?: string) =>
    jfetch<Worktree>(`/api/worktrees`, json("POST", { projectId, branch, path: wtPath, base })),
  /** Rejects with code `worktree-dirty` when uncommitted changes would be lost; pass `force` after the user confirms.
   *  `ok: true` means Git removal (or an already-absent worktree) succeeded. `metadataCleanupFailed` /
   *  `branchCleanupFailed` are follow-up warnings: session rows may still need `worktreeState: missing`
   *  reconciliation, or the dedicated branch may still exist. */
  removeWorktree: (projectId: string, wtPath: string, deleteBranch?: boolean, force?: boolean) =>
    jfetch<{ ok: true; metadataCleanupFailed?: boolean; branchCleanupFailed?: boolean }>(`/api/worktrees/remove`, json("POST", { projectId, path: wtPath, deleteBranch, ...(force ? { force: true } : {}) })),

  createIsolatedSession: (input: CreateIsolatedSessionInput) =>
    jfetch<SessionRef>(`/api/isolation/sessions`, json("POST", input)),
  isolationStatus: (sessionId: string) =>
    jfetch<IsolationStatusDto>(`/api/isolation/${encodeURIComponent(sessionId)}`),
  isolationMerge: (sessionId: string) =>
    jfetch<IsolationMergeResultDto>(`/api/isolation/${encodeURIComponent(sessionId)}/merge`, json("POST", {})),
  isolationKeep: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/keep`, json("POST", {})),
  isolationDiscard: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/discard`, json("POST", {})),
  isolationRecover: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/recover`, json("POST", {})),
  isolationAbandon: (sessionId: string) =>
    jfetch<SessionProjection>(`/api/isolation/${encodeURIComponent(sessionId)}/abandon`, json("POST", {})),
  isolationResolve: (sessionId: string) =>
    jfetch<{ sessionId: string }>(`/api/isolation/${encodeURIComponent(sessionId)}/resolve`, json("POST", {})),

  // ---- files (§12) ---------------------------------------------------------
  // Every files call carries an optional sessionId so the server resolves the
  // active session's worktree, not the project root (UX-FIXTURE-VISUAL P0).
  filesTree: (projectId: string, relPath?: string, hidden?: boolean, sessionId?: string) =>
    jfetch<FileEntry[]>(`/api/files/tree?projectId=${encodeURIComponent(projectId)}${relPath ? `&path=${encodeURIComponent(relPath)}` : ""}${hidden ? "&hidden=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  filesRead: (projectId: string, relPath: string, sessionId?: string) =>
    jfetch<FileReadResult>(`/api/files/read?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  filesWrite: (projectId: string, relPath: string, content: string, baseRevision?: string, sessionId?: string) =>
    jfetch<{ ok: true; revision: string }>(`/api/files/write`, json("POST", {
      projectId, path: relPath, content,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      ...(sessionId ? { sessionId } : {}),
    })),
  filesMkdir: (projectId: string, relPath: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/files/mkdir`, json("POST", { projectId, path: relPath, ...(sessionId ? { sessionId } : {}) })),
  filesDelete: (projectId: string, relPath: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/files/delete`, json("POST", { projectId, path: relPath, ...(sessionId ? { sessionId } : {}) })),
  filesRename: (projectId: string, from: string, to: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/files/rename`, json("POST", { projectId, from, to, ...(sessionId ? { sessionId } : {}) })),
  filesUpload: (projectId: string, relPath: string, bytes: Uint8Array, sessionId?: string) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return jfetch<{ ok: true }>(`/api/files/upload`, json("POST", { projectId, path: relPath, base64: btoa(bin), ...(sessionId ? { sessionId } : {}) }));
  },
  filesStat: (projectId: string, relPath: string, sessionId?: string) =>
    jfetch<{ path: string; kind: "file" | "dir"; size: number; mime?: string; revision?: string }>(
      `/api/files/stat?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  /** URL of the sanitized raw-bytes endpoint (images in Markdown, previews). */
  filesRawUrl: (projectId: string, relPath: string, sessionId?: string) =>
    `/api/files/raw?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
  /** Legacy string results; accepts old (string[]) and new (scored) payloads. */
  filesSearch: async (projectId: string, q: string, limit = 50, sessionId?: string): Promise<string[]> => {
    const hits = await api.filesSearchScored(projectId, q, limit, false, sessionId);
    return hits.map((h) => h.path);
  },
  /** Scored file search (WP13). Migration-safe: plain strings are upgraded. */
  filesSearchScored: (projectId: string, q: string, limit = 50, includeDirs = false, sessionId?: string) =>
    jfetch<Array<string | FileSearchHitDto>>(
      `/api/files/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=${limit}${includeDirs ? "&includeDirs=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    )
      .then((rows): FileSearchHitDto[] =>
        rows.map((r) => (typeof r === "string" ? { path: r, kind: "file", score: 0, matches: [] } : r)),
      )
      .catch((): FileSearchHitDto[] => []),
  /** Palette project/session search (WP13); metadata only. */
  searchWorkspaces: (q: string, limit = 10, archived = false) =>
    jfetch<{ items: WorkspaceSearchItemDto[] }>(
      `/api/search/workspaces?q=${encodeURIComponent(q)}&limit=${limit}&archived=${archived}`,
    )
      .then((r) => r.items)
      .catch((): WorkspaceSearchItemDto[] => []),

  // ---- commands + snippets (§12) --------------------------------------------
  // UX-COMPOSER-DISC: strict catalog read for the composer. Command and
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
  updateWorkflow: (id: string, patch: Partial<Pick<WorkflowDto, "name" | "nodes" | "edges" | "defaults">>) =>
    jfetch<WorkflowDto>(`/api/workflows/${encodeURIComponent(id)}`, json("PATCH", patch)),
  deleteWorkflow: (id: string) =>
    jfetch<{ ok: true }>(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  runWorkflow: (id: string, sessionId: string, input: string, options?: WorkflowRunOptionsDto) =>
    jfetch<WorkflowRunDto>(`/api/workflows/${encodeURIComponent(id)}/run`, json("POST", {
      sessionId,
      input,
      ...(options ? { options } : {}),
    })),
  listWorkflowRuns: (projectId: string) =>
    jfetch<WorkflowRunDto[]>(`/api/workflow-runs?projectId=${encodeURIComponent(projectId)}`),
  getWorkflowRun: (runId: string) =>
    jfetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}`),
  stopWorkflowRun: (runId: string) =>
    jfetch<WorkflowRunDto>(`/api/workflow-runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }),

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
  createTerminal: (projectId: string, opts?: { sessionId?: string; cwd?: string; cmd?: string; cols?: number; rows?: number }) =>
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
  scheduleCreate: (input: ScheduleTaskInputDto) =>
    jfetch<ScheduleTaskDto>(`/api/schedule`, json("POST", input)),
  scheduleUpdate: (id: string, patch: Partial<ScheduleTaskInputDto>) =>
    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}`, json("PATCH", patch)),
  scheduleDelete: (id: string) =>
    jfetch<{ ok: boolean }>(`/api/schedule/${encodeURIComponent(id)}`, { method: "DELETE" }),
  schedulePause: (id: string, pause: boolean) =>
    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/${pause ? "pause" : "resume"}`, { method: "POST" }),
  scheduleRun: (id: string) =>
    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/run`, { method: "POST" }),
  schedulePreview: (cadence: ScheduleCadenceDto, count = 5) =>
    jfetch<{ runs: number[]; description: string }>(`/api/schedule/preview`, json("POST", { cadence, count })),
  scheduleRuns: (id: string, limit = 50) =>
    jfetch<ScheduleRunDto[]>(`/api/schedule/${encodeURIComponent(id)}/runs?limit=${limit}`).catch((): ScheduleRunDto[] => []),
  scheduleLoopsRescan: (projectId: string) =>
    jfetch<{ tasks: ScheduleTaskDto[]; errors: ScheduleLoopErrorDto[] }>(
      `/api/schedule/loops/rescan`, json("POST", { projectId }),
    ),
  scheduleLoopErrorDismiss: (projectId: string, path: string) =>
    jfetch<{ ok: boolean }>(`/api/schedule/loops/errors/dismiss`, json("POST", { projectId, path })),

  // ---- knowledge (WP10) --------------------------------------------------------
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

  // ---- PR detail surfaces (WP11; fail-soft) ------------------------------------
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

  // ---- PR lifecycle (F7): explicit external writes + AI describe ---------------
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

  // ---- generated walkthroughs + reviews (WP11) ----------------------------------
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

  // ---- provider quotas (WP12; telemetry, never session data) --------------------
  usageQuotas: () =>
    jfetch<QuotaSnapshotDto[]>(`/api/usage/quotas`),
  usageQuotasRefresh: (providerId: string) =>
    jfetch<QuotaSnapshotDto>(`/api/usage/quotas/refresh`, json("POST", { providerId })),

  sessionRetention: (days: number) =>
    jfetch<SessionRetentionDto>(`/api/session-retention?days=${encodeURIComponent(days)}`),
  runSessionRetention: (days: number) =>
    jfetch<{ eligibleCount: number; succeeded: string[]; failed: Array<{ id: string; code: string }> }>(
      "/api/session-retention",
      json("POST", { days }),
    ),

  // ---- session control ---------------------------------------------------------
  controlSessions: (projectId?: string) =>
    jfetch<SessionProjection[]>(`/api/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  controlNew: (projectId: string, title?: string) =>
    jfetch<SessionRef>(`/api/sessions`, json("POST", { projectId, title })),
  controlFork: (sessionId: string, atSeq?: number) =>
    jfetch<SessionRef>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, json("POST", atSeq === undefined ? {} : { atSeq })),
  controlAbort: (sessionId: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }),

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

  // ---- streaming dictation (WP15; audio itself travels over /ws) ---------------
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

  // ---- voice engines (F8): server settings + TTS proxy --------------------------
  voiceSettings: () => jfetch<VoiceSettingsDto>(`/api/settings/voice`),
  voiceSettingsSave: (next: {
    stt: { baseUrl: string; model: string; language: string; apiKeyEnv: string };
    tts: { baseUrl: string; model: string; voice: string; apiKeyEnv: string };
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

  // ---- Home Assistant plugin ---------------------------------------------------
  homeAssistantConfig: () =>
    jfetch<HomeAssistantConfigDto>("/api/home-assistant/config"),
  homeAssistantConfigure: (input: HomeAssistantConfigInput) =>
    jfetch<HomeAssistantConfigDto>("/api/home-assistant/config", json("PUT", input)),
  homeAssistantStatus: () =>
    jfetch<HomeAssistantConnectionDto>("/api/home-assistant/status"),
  homeAssistantEntities: (entityIds: readonly string[] = []) => {
    const params = new URLSearchParams();
    for (const entityId of entityIds) params.append("entityId", entityId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return jfetch<HomeAssistantEntityDto[]>(`/api/home-assistant/entities${query}`);
  },
  homeAssistantToggle: (entityId: string) =>
    jfetch<HomeAssistantEntityDto>("/api/home-assistant/toggle", json("POST", { entityId })),
  homeAssistantSetTemperature: (entityId: string, temperature: number) =>
    jfetch<HomeAssistantEntityDto>(
      "/api/home-assistant/climate/temperature",
      json("POST", { entityId, temperature }),
    ),

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

  // ---- shared client preferences (Appearance, chat, notifications, …) ----------
  /** Server copy of this workspace's client settings; `revision` 0 means the
   *  server has never been written and the local record should seed it. */
  clientSettings: () => jfetch<ClientSettingsDto>(`/api/settings/client`),
  clientSettingsSave: (settings: Record<string, unknown>, opts?: { keepalive?: boolean }) =>
    jfetch<ClientSettingsDto>(`/api/settings/client`, {
      ...json("PUT", { settings }),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    }),

  // ---- idle assist (F9): recap + suggestion, chat→note --------------------------
  assistSettings: () => jfetch<AssistSettingsDto>(`/api/settings/assist`),
  assistSettingsSave: (patch: Partial<AssistSettingsDto>) =>
    jfetch<AssistSettingsDto>(`/api/settings/assist`, json("PUT", patch)),
  /** 404s when nothing fresh exists — callers rely on the projection instead. */
  assistGet: (sessionId: string) =>
    jfetch<AssistDto>(`/api/sessions/${encodeURIComponent(sessionId)}/assist`),
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

  // ---- backend session import (F14 import half) ----------------------------------
  backendSessions: (projectId: string) =>
    jfetch<{ items: RuntimeSession[]; total: number }>(
      `/api/agent/backend-sessions?projectId=${encodeURIComponent(projectId)}`,
    ),
  importBackendSessions: (projectId: string, ids: string[]) =>
    jfetch<SessionProjection[]>(`/api/agent/backend-sessions/import`, json("POST", { projectId, ids })),

  // ---- auto-accept policy (F18) ------------------------------------------------------
  autoAcceptGet: (sessionId: string) =>
    jfetch<AutoAcceptDto>(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/auto-accept`),
  autoAcceptSet: (sessionId: string, setting: AutoAcceptSetting) =>
    jfetch<AutoAcceptDto>(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/auto-accept`, json("PATCH", { setting })),

  // ---- web push (F18) -----------------------------------------------------------------
  pushKey: () => jfetch<{ publicKey: string; subscriptions: number }>(`/api/push/key`),
  pushSubscribe: (sub: unknown) => jfetch<{ ok: boolean }>(`/api/push/subscribe`, json("POST", sub)),
  pushUnsubscribe: (endpoint: string) => jfetch<{ ok: boolean }>(`/api/push/subscribe`, json("DELETE", { endpoint })),
  pushTest: () => jfetch<{ sent: number; dropped: number }>(`/api/push/test`, json("POST", {})),

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

  // ---- access control (F16) --------------------------------------------------------
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

// ---- access control DTOs (F16) ------------------------------------------------------
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
