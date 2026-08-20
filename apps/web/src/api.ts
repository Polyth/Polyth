// Typed fetch wrappers for every REST endpoint in PLAN.md §5.
import type {
  AgentDescriptor,
  AgentProfile,
  AttachmentRef,
  AutoAcceptDto,
  AutoAcceptSetting,
  BulkSessionResult,
  DictationSessionDto,
  ForkResult,
  FusionDto,
  InstalledPluginDto,
  JsonObject,
  McpServerDto,
  McpTransport,
  ModelDescriptor,
  ModelRef,
  MultirunDto,
  PreviewState,
  SystemInfoDto,
  Project,
  ProjectPatch,
  QueueItemDto,
  RuntimeSession,
  SendResult,
  SessionEvent,
  SessionFolderDto,
  SessionProjection,
  SessionRef,
  ShellTurnResult,
  TerminalInfo,
  WalkthroughStepDto,
  WorkspaceLabel,
} from "@polyth/contracts";

export interface BrowserSessionDto {
  id: string;
  projectId: string;
  sessionId?: string;
  url: string;
  title: string;
  status: "starting" | "ready" | "closed" | "failed";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  revision: number;
  engine: "chromium" | "fake" | "unavailable";
}

export type BrowserTargetDto =
  | { selector: string }
  | { role: string; name?: string; exact?: boolean }
  | { point: { x: number; y: number }; frameRevision: number };

export type BrowserActionDto =
  | { kind: "click"; target: BrowserTargetDto }
  | { kind: "type"; target: BrowserTargetDto; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "select"; target: BrowserTargetDto; value: string }
  | { kind: "wait"; condition: "network-idle" | "selector"; value?: string; timeoutMs?: number };

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

// ---- host directory browsing (project folder picker; localhost-only) --------
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
  context?: number;
  cost?: { input: number; output: number };
  connected: boolean;
  enabled: boolean;
}
export interface ProviderCatalogDto {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
  models: ProviderCatalogModelDto[];
}
export interface VisibilityStateDto {
  ok: boolean;
  disabledProviders: string[];
  disabledModels: string[];
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
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // non-JSON error body
    }
    throw Object.assign(
      new Error(message ?? `HTTP ${res.status} ${res.statusText} — ${body}`),
      { status: res.status, ...(code !== undefined ? { code } : {}) },
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

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

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
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
}
export interface GitDiffResult { path: string; diff: string }
export interface GitBranches {
  current: string;
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
  branch: string;
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
export type KnowledgeKindDto = "note" | "plan" | "memory";
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
export interface GithubRepoDto {
  name: string; owner: string; url: string; description: string;
  defaultBranch: string; isPrivate: boolean;
}
export interface GithubIssueDto {
  number: number; title: string; state: string; author: string; updatedAt: string; url: string;
}
export interface GithubPrDto extends GithubIssueDto { isDraft: boolean; headRefName: string }
export interface GithubStatusDto {
  installed: boolean; authenticated: boolean; repo: GithubRepoDto | null; reason?: string;
}
export type GhListResult<T> = { ok: true; data: T } | { ok: false; reason: string };

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

// ---- PR detail + checks (WP11) ----------------------------------------------
export interface PrDetailDto {
  number: number; title: string; state: string; isDraft: boolean; author: string;
  url: string; body: string; baseRefName: string; headRefName: string; headRefOid: string;
  additions: number; deletions: number; changedFiles: number; mergeable: string;
  createdAt: string; updatedAt: string;
}
export interface PrFileDto { path: string; additions: number; deletions: number }
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
export interface PrCommentDto {
  id: string; author: string; body: string; createdAt: string; url: string;
  path?: string; line?: number; outdated?: boolean; kind: "issue" | "review"; reviewState?: string;
}

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

  listProjects: () => jfetch<Project[]>("/api/projects"),
  addProject: (path: string, name?: string) =>
    jfetch<Project>("/api/projects", json("POST", { path, name })),
  createProject: (path: string, name?: string) =>
    jfetch<Project>("/api/projects/create", json("POST", { path, name })),
  deleteProject: (id: string) => jfetch<void>(`/api/projects/${id}`, { method: "DELETE" }),
  patchProject: (id: string, patch: ProjectPatch) =>
    jfetch<Project>(`/api/projects/${id}`, json("PATCH", patch)),

  listSessions: (projectId: string) => jfetch<SessionProjection[]>(`/api/sessions?projectId=${encodeURIComponent(projectId)}`),
  createSession: (input: { projectId: string; title?: string; model?: JsonObject; agent?: string; worktreePath?: string }) =>
    jfetch<SessionRef>("/api/sessions", json("POST", input)),
  getSession: (id: string) => jfetch<SessionProjection>(`/api/sessions/${id}`),
  getEvents: (id: string, afterSeq = 0) =>
    jfetch<SessionEvent[]>(`/api/sessions/${id}/events?afterSeq=${afterSeq}`),

  // agentProfileId: string selects a profile, null explicitly clears the
  // session's stored profile, omitted inherits it (UX-COMPOSER-DISC).
  sendMessage: (id: string, body: { text: string; attachments?: AttachmentRef[]; model?: JsonObject; agent?: string; delivery?: string; dismissPending?: boolean; agentProfileId?: string | null }) =>
    jfetch<SendResult>(`/api/sessions/${id}/message`, json("POST", body)),
  abort: (id: string) => jfetch<void>(`/api/sessions/${id}/abort`, { method: "POST" }),
  renameSession: (id: string, title: string) =>
    jfetch<{ ok: true }>(`/api/sessions/${id}/rename`, json("POST", { title })),

  // ---- delivery queue (WP3) -------------------------------------------------
  queueList: (id: string) =>
    jfetch<QueueItemDto[]>(`/api/sessions/${id}/queue`).catch((): QueueItemDto[] => []),
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
  runShell: (id: string, command: string) =>
    jfetch<ShellTurnResult>(`/api/sessions/${id}/shell`, json("POST", { command })),
  archive: (id: string) => jfetch<void>(`/api/sessions/${id}/archive`, { method: "POST" }),
  restore: (id: string) => jfetch<void>(`/api/sessions/${id}/restore`, { method: "POST" }),

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
  searchSessions: (q: string, projectId?: string, limit = 30) =>
    jfetch<SessionSearchResult[]>(
      `/api/search/sessions?q=${encodeURIComponent(q)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}&limit=${limit}`,
    ).catch((): SessionSearchResult[] => []),

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
  systemInfo: () => jfetch<SystemInfoDto>("/api/system/info"),
  mcpList: () => jfetch<McpServerDto[]>("/api/mcp/servers").catch((): McpServerDto[] => []),
  mcpCreate: (input: { name: string; transport: McpTransport; secrets?: Record<string, string>; enabled?: boolean }) =>
    jfetch<McpServerDto>("/api/mcp/servers", json("POST", input)),
  mcpUpdate: (id: string, patch: { name?: string; transport?: McpTransport; secrets?: Record<string, string>; enabled?: boolean }, expectedRevision: number) =>
    jfetch<McpServerDto>(`/api/mcp/servers/${encodeURIComponent(id)}`, json("PATCH", { ...patch, expectedRevision })),
  mcpRemove: (id: string) => jfetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
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

  replyPermission: (id: string, requestId: string, reply: "once" | "always" | "reject", scope?: "session" | "project") =>
    jfetch<void>(`/api/sessions/${id}/permission/${encodeURIComponent(requestId)}`, json("POST", { reply, ...(scope ? { scope } : {}) })),
  answerQuestion: (id: string, requestId: string, answers: JsonObject) =>
    jfetch<void>(`/api/sessions/${id}/question/${encodeURIComponent(requestId)}`, json("POST", { answers })),
  rejectQuestion: (id: string, requestId: string) =>
    jfetch<void>(`/api/sessions/${id}/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }),

  listModels: () => jfetch<ModelDescriptor[]>("/api/models"),
  listAgents: () => jfetch<AgentDescriptor[]>("/api/agents"),

  // ---- provider/model visibility (Providers & Models settings) --------------
  listProviders: () => jfetch<ProviderCatalogDto[]>("/api/providers"),
  setProviderEnabled: (id: string, enabled: boolean) =>
    jfetch<VisibilityStateDto>(`/api/providers/${encodeURIComponent(id)}/enabled`, json("POST", { enabled })),
  setModelEnabled: (key: string, enabled: boolean) =>
    jfetch<VisibilityStateDto>(`/api/models/enabled`, json("POST", { key, enabled })),
  opencodePlugins: () =>
    jfetch<{ plugins: string[] }>("/api/plugins/opencode").catch((): { plugins: string[] } => ({ plugins: [] })),

  // ---- host directory browsing (folder picker; localhost-only route) --------
  browseHost: (path?: string, hidden?: boolean) =>
    jfetch<BrowseResultDto>(`/api/browse?${new URLSearchParams({
      ...(path ? { path } : {}),
      ...(hidden ? { hidden: "true" } : {}),
    })}`),
  browseMkdir: (path: string) =>
    jfetch<{ path: string }>(`/api/browse/mkdir`, json("POST", { path })),

  // ---- git (§12) -----------------------------------------------------------
  gitStatus: (projectId: string, sessionId?: string) =>
    jfetch<GitStatus>(`/api/git/status?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).catch((): GitStatus => ({
      branch: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [],
    })),
  gitDiff: (projectId: string, filePath: string, staged?: boolean, ignoreWhitespace?: boolean, sessionId?: string) =>
    jfetch<GitDiffResult>(
      `/api/git/diff?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}${staged ? "&staged=true" : ""}${ignoreWhitespace ? "&ignoreWhitespace=true" : ""}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ).catch((): GitDiffResult => ({ path: filePath, diff: "" })),
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
    jfetch<{ message: string }>(`/api/git/commit-message`, json("POST", { projectId, ...(sessionId ? { sessionId } : {}) })).catch(
      (): { message: "" } => ({ message: "" }),
    ),
  gitBranches: (projectId: string, sessionId?: string) =>
    jfetch<GitBranches>(`/api/git/branches?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).catch(
      (): GitBranches => ({ current: "", branches: [] }),
    ),
  gitBranch: (projectId: string, name: string, from?: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/branch`, json("POST", { projectId, name, from, ...(sessionId ? { sessionId } : {}) })),
  gitCheckout: (projectId: string, name: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/checkout`, json("POST", { projectId, name, ...(sessionId ? { sessionId } : {}) })),
  gitLog: (projectId: string, limit = 20, sessionId?: string) =>
    jfetch<GitLogEntry[]>(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).catch(
      (): GitLogEntry[] => [],
    ),
  gitGraph: (projectId: string, limit = 40, skip = 0, sessionId?: string) =>
    jfetch<GitGraphEntry[]>(`/api/git/graph?projectId=${encodeURIComponent(projectId)}&limit=${limit}&skip=${skip}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).catch(
      (): GitGraphEntry[] => [],
    ),
  gitFolder: (projectId: string, folder: string, op: "stage" | "unstage" | "discard", sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/git/folder`, json("POST", { projectId, folder, op, ...(sessionId ? { sessionId } : {}) })),
  gitStashes: (projectId: string, sessionId?: string) =>
    jfetch<GitStash[]>(`/api/git/stashes?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).catch((): GitStash[] => []),
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

  // ---- worktrees (§12) -----------------------------------------------------
  listWorktrees: (projectId: string) =>
    jfetch<Worktree[]>(`/api/worktrees?projectId=${encodeURIComponent(projectId)}`).catch(
      (): Worktree[] => [],
    ),
  createWorktree: (projectId: string, branch: string, wtPath?: string, base?: string) =>
    jfetch<Worktree>(`/api/worktrees`, json("POST", { projectId, branch, path: wtPath, base })),
  removeWorktree: (projectId: string, wtPath: string, deleteBranch?: boolean) =>
    jfetch<{ ok: true }>(`/api/worktrees/remove`, json("POST", { projectId, path: wtPath, deleteBranch })),

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
  createTerminal: (projectId: string, opts?: { sessionId?: string; cwd?: string; cols?: number; rows?: number }) =>
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

  // ---- github (gh CLI; fail-soft) --------------------------------------------
  githubStatus: (projectId: string) =>
    jfetch<GithubStatusDto>(`/api/github/status?projectId=${encodeURIComponent(projectId)}`).catch(
      (): GithubStatusDto => ({ installed: false, authenticated: false, repo: null, reason: "server unreachable" }),
    ),
  githubRepo: (projectId: string) =>
    jfetch<GhListResult<GithubRepoDto>>(`/api/github/repo?projectId=${encodeURIComponent(projectId)}`).catch(
      (): GhListResult<GithubRepoDto> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubIssues: (projectId: string, limit = 30) =>
    jfetch<GhListResult<GithubIssueDto[]>>(`/api/github/issues?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GhListResult<GithubIssueDto[]> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubPrs: (projectId: string, limit = 30) =>
    jfetch<GhListResult<GithubPrDto[]>>(`/api/github/prs?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GhListResult<GithubPrDto[]> => ({ ok: false, reason: "server unreachable" }),
    ),

  // ---- PR detail surfaces (WP11; fail-soft) ------------------------------------
  githubPrDetail: (projectId: string, number: number) =>
    jfetch<GhListResult<PrDetailDto>>(`/api/github/pr?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<PrDetailDto> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubPrFiles: (projectId: string, number: number) =>
    jfetch<GhListResult<PrFileDto[]>>(`/api/github/pr/files?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<PrFileDto[]> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubPrChecks: (projectId: string, number: number) =>
    jfetch<GhListResult<{ checks: PrCheckDto[]; summary: ChecksSummaryDto }>>(
      `/api/github/pr/checks?projectId=${encodeURIComponent(projectId)}&number=${number}`,
    ).catch((): GhListResult<{ checks: PrCheckDto[]; summary: ChecksSummaryDto }> => ({ ok: false, reason: "server unreachable" })),
  githubPrComments: (projectId: string, number: number) =>
    jfetch<GhListResult<PrCommentDto[]>>(`/api/github/pr/comments?projectId=${encodeURIComponent(projectId)}&number=${number}`).catch(
      (): GhListResult<PrCommentDto[]> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubSubmitReview: (number: number, input: {
    projectId: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string;
    comments?: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; startLine?: number; body: string }>;
    commitSha?: string; confirm?: boolean; sessionId?: string;
  }) =>
    jfetch<GhListResult<{ id: string; url?: string }>>(`/api/github/pr/${number}/reviews`, json("POST", input)),
  githubAddLabels: (number: number, projectId: string, labels: string[]) =>
    jfetch<GhListResult<{ labels: string[] }>>(`/api/github/pr/${number}/labels`, json("POST", { projectId, labels })),

  // ---- PR lifecycle (F7): explicit external writes + AI describe ---------------
  githubPrCreate: (input: { projectId: string; title: string; body: string; base?: string; draft?: boolean; sessionId?: string }) =>
    jfetch<GhListResult<{ number: number; url: string }>>(`/api/github/pr/create`, json("POST", input)),
  githubPrUpdate: (input: { projectId: string; number: number; title?: string; body?: string; base?: string; sessionId?: string }) =>
    jfetch<GhListResult<{ number: number }>>(`/api/github/pr/update`, json("POST", input)),
  githubPrMerge: (input: { projectId: string; number: number; strategy: "squash" | "merge" | "rebase"; sessionId?: string }) =>
    jfetch<GhListResult<{ number: number; strategy: string }>>(`/api/github/pr/merge`, json("POST", { ...input, confirm: true })),
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
    jfetch<QuotaSnapshotDto[]>(`/api/usage/quotas`).catch((): QuotaSnapshotDto[] => []),
  usageQuotasRefresh: (providerId: string) =>
    jfetch<QuotaSnapshotDto>(`/api/usage/quotas/refresh`, json("POST", { providerId })),

  // ---- session control ---------------------------------------------------------
  controlSessions: (projectId?: string) =>
    jfetch<SessionProjection[]>(`/api/control/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  controlNew: (projectId: string, title?: string) =>
    jfetch<SessionRef>(`/api/control/sessions`, json("POST", { projectId, title })),
  controlFork: (sessionId: string, atSeq?: number) =>
    jfetch<SessionRef>(`/api/control/sessions/${encodeURIComponent(sessionId)}/fork`, json("POST", atSeq === undefined ? {} : { atSeq })),
  controlAbort: (sessionId: string) =>
    jfetch<{ ok: true }>(`/api/control/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }),

  // ---- commands + snippets CRUD ------------------------------------------------
  saveCommand: (projectId: string, scope: "user" | "project", cmd: { name: string; prompt: string; description?: string; agent?: string; model?: string }) =>
    jfetch<{ ok: true }>(`/api/commands`, json("POST", { projectId, scope, ...cmd })),
  deleteCommand: (projectId: string, scope: "user" | "project", name: string) =>
    jfetch<{ ok: boolean }>(`/api/commands`, json("DELETE", { projectId, scope, name })),
  saveSnippet: (projectId: string, scope: "user" | "project", snippet: { alias: string; text: string }) =>
    jfetch<{ ok: true }>(`/api/snippets`, json("POST", { projectId, scope, ...snippet })),
  deleteSnippet: (projectId: string, scope: "user" | "project", alias: string) =>
    jfetch<{ ok: boolean }>(`/api/snippets`, json("DELETE", { projectId, scope, alias })),

  // ---- M3: preview ---------------------------------------------------------
  previewStart: (projectId: string, command?: string, sessionId?: string) =>
    jfetch<{ url: string; port: number }>(`/api/preview/start`, json("POST", { projectId, command, ...(sessionId ? { sessionId } : {}) })),
  previewGet: (projectId: string, sessionId?: string) =>
    jfetch<PreviewState>(`/api/preview?projectId=${encodeURIComponent(projectId)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`).catch(
      (): PreviewState => ({ url: null, status: "off" }),
    ),
  previewStop: (projectId: string, sessionId?: string) =>
    jfetch<{ ok: true }>(`/api/preview/stop`, json("POST", { projectId, ...(sessionId ? { sessionId } : {}) })),

  // ---- controlled browser (WP14) ---------------------------------------------
  browserCapability: () =>
    jfetch<{ available: boolean; engine: "chromium" | "fake" | null; reason?: string }>(`/api/browser/capability`).catch(
      () => ({ available: false, engine: null, reason: "server unreachable" }),
    ),
  browserCreate: (input: { projectId: string; sessionId?: string; url?: string; viewport?: { width: number; height: number } }) =>
    jfetch<BrowserSessionDto>(`/api/browser/sessions`, json("POST", input)),
  browserGet: (id: string) =>
    jfetch<BrowserSessionDto>(`/api/browser/sessions/${encodeURIComponent(id)}`),
  browserList: (projectId?: string) =>
    jfetch<BrowserSessionDto[]>(`/api/browser/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`).catch(
      (): BrowserSessionDto[] => [],
    ),
  browserNavigate: (id: string, url: string, actor: "user" | "agent" = "user") =>
    jfetch<BrowserSessionDto>(`/api/browser/sessions/${encodeURIComponent(id)}/navigate`, json("POST", { url, actor })),
  browserAction: (id: string, action: BrowserActionDto, actor: "user" | "agent" = "user") =>
    jfetch<{ actionId: string; session: BrowserSessionDto }>(
      `/api/browser/sessions/${encodeURIComponent(id)}/actions`, json("POST", { action, actor }),
    ),
  browserObserve: (id: string, includeScreenshot = false) =>
    jfetch<{ url: string; title: string; text: string; accessibilityDigest: string; screenshotRef?: string }>(
      `/api/browser/sessions/${encodeURIComponent(id)}/observe`, json("POST", { includeScreenshot }),
    ),
  browserClose: (id: string) =>
    jfetch<{ ok: true }>(`/api/browser/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  browserPauseAgent: (id: string, paused: boolean) =>
    jfetch<{ ok: true; paused: boolean }>(`/api/browser/sessions/${encodeURIComponent(id)}/pause-agent`, json("POST", { paused })),
  browserConsole: (id: string) =>
    jfetch<Array<{ at: number; level: string; message: string }>>(`/api/browser/sessions/${encodeURIComponent(id)}/console`).catch(
      (): Array<{ at: number; level: string; message: string }> => [],
    ),
  browserApprove: (origin: string) =>
    jfetch<{ origins: string[] }>(`/api/browser/approvals`, json("POST", { origin })),

  // ---- streaming dictation (WP15; audio itself travels over /ws) ---------------
  dictationCapability: () =>
    jfetch<{ available: boolean; engine?: string; reason?: string }>(`/api/dictation/capability`).catch(
      () => ({ available: false, reason: "server unreachable" }),
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
      throw new Error(body.message ?? `TTS failed: HTTP ${res.status}`);
    }
    return res.arrayBuffer();
  },
  ttsSummarize: (text: string) => jfetch<{ text: string }>(`/api/tts/summarize`, json("POST", { text })),

  // ---- idle assist (F9): recap + suggestion, chat→note --------------------------
  assistSettings: () => jfetch<AssistSettingsDto>(`/api/settings/assist`),
  assistSettingsSave: (patch: Partial<AssistSettingsDto>) =>
    jfetch<AssistSettingsDto>(`/api/settings/assist`, json("PUT", patch)),
  /** 404s when nothing fresh exists — callers rely on the projection instead. */
  assistGet: (sessionId: string) =>
    jfetch<AssistDto>(`/api/sessions/${encodeURIComponent(sessionId)}/assist`),
  /** Small-model chat→note DRAFT; saving still goes through knowledgeCreate. */
  assistNote: (sessionId: string) =>
    jfetch<{ title: string; body: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/assist/note`, json("POST", {})),

  // ---- backend session import (F14 import half) ----------------------------------
  backendSessions: (projectId: string) =>
    jfetch<{ items: RuntimeSession[]; total: number }>(
      `/api/control/backend-sessions?projectId=${encodeURIComponent(projectId)}`,
    ),
  importBackendSessions: (projectId: string, ids: string[]) =>
    jfetch<SessionProjection[]>(`/api/control/backend-sessions/import`, json("POST", { projectId, ids })),

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
      message: body.message ?? `HTTP ${res.status}`,
      ...(typeof body.retryAfterSec === "number" ? { retryAfterSec: body.retryAfterSec } : {}),
    };
  },
  authLogout: () => jfetch<{ ok: boolean }>(`/api/auth/logout`, json("POST", {})),
  authLogoutAll: () => jfetch<{ ok: boolean }>(`/api/auth/logout-all`, json("POST", {})),
  authSessions: () => jfetch<AuthDeviceDto[]>(`/api/auth/sessions`),
  authRevoke: (id: string) => jfetch<{ ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
