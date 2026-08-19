// Typed fetch wrappers for every REST endpoint in PLAN.md §5.
import type {
  AgentDescriptor,
  FusionDto,
  JsonObject,
  ModelDescriptor,
  ModelRef,
  MultirunDto,
  PreviewState,
  Project,
  SessionEvent,
  SessionProjection,
  SessionRef,
  TerminalInfo,
  TurnRef,
  WalkthroughStepDto,
} from "@polyth/contracts";

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

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

// ---- schedule types --------------------------------------------------------
export interface ScheduleTaskDto {
  id: string;
  projectId: string;
  sessionId?: string;
  title?: string;
  prompt: string;
  kind: "at" | "every";
  at?: number;
  everyMinutes?: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastError?: string;
  nextRunAt: number | null;
  runs: number;
}
export interface ScheduleTaskInputDto {
  projectId: string;
  prompt: string;
  kind: "at" | "every";
  at?: number;
  everyMinutes?: number;
  sessionId?: string;
  title?: string;
  enabled?: boolean;
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

  listSessions: (projectId: string) => jfetch<SessionProjection[]>(`/api/sessions?projectId=${encodeURIComponent(projectId)}`),
  createSession: (input: { projectId: string; title?: string; model?: JsonObject; agent?: string }) =>
    jfetch<SessionRef>("/api/sessions", json("POST", input)),
  getSession: (id: string) => jfetch<SessionProjection>(`/api/sessions/${id}`),
  getEvents: (id: string, afterSeq = 0) =>
    jfetch<SessionEvent[]>(`/api/sessions/${id}/events?afterSeq=${afterSeq}`),

  sendMessage: (id: string, body: { text: string; model?: JsonObject; agent?: string }) =>
    jfetch<TurnRef>(`/api/sessions/${id}/message`, json("POST", body)),
  abort: (id: string) => jfetch<void>(`/api/sessions/${id}/abort`, { method: "POST" }),
  fork: (id: string, atSeq?: number) =>
    jfetch<SessionRef>(`/api/sessions/${id}/fork`, json("POST", atSeq === undefined ? {} : { atSeq })),
  archive: (id: string) => jfetch<void>(`/api/sessions/${id}/archive`, { method: "POST" }),
  restore: (id: string) => jfetch<void>(`/api/sessions/${id}/restore`, { method: "POST" }),

  replyPermission: (id: string, requestId: string, reply: "once" | "always" | "reject") =>
    jfetch<void>(`/api/sessions/${id}/permission/${encodeURIComponent(requestId)}`, json("POST", { reply })),
  answerQuestion: (id: string, requestId: string, answers: JsonObject) =>
    jfetch<void>(`/api/sessions/${id}/question/${encodeURIComponent(requestId)}`, json("POST", { answers })),
  rejectQuestion: (id: string, requestId: string) =>
    jfetch<void>(`/api/sessions/${id}/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }),

  listModels: () => jfetch<ModelDescriptor[]>("/api/models"),
  listAgents: () => jfetch<AgentDescriptor[]>("/api/agents"),

  // ---- git (§12) -----------------------------------------------------------
  gitStatus: (projectId: string) =>
    jfetch<GitStatus>(`/api/git/status?projectId=${encodeURIComponent(projectId)}`).catch((): GitStatus => ({
      branch: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [],
    })),
  gitDiff: (projectId: string, filePath: string, staged?: boolean) =>
    jfetch<GitDiffResult>(
      `/api/git/diff?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}${staged ? "&staged=true" : ""}`,
    ).catch((): GitDiffResult => ({ path: filePath, diff: "" })),
  gitStage: (projectId: string, paths: string[]) =>
    jfetch<{ ok: true }>(`/api/git/stage`, json("POST", { projectId, paths })),
  gitUnstage: (projectId: string, paths: string[]) =>
    jfetch<{ ok: true }>(`/api/git/unstage`, json("POST", { projectId, paths })),
  gitDiscard: (projectId: string, paths: string[]) =>
    jfetch<{ ok: true }>(`/api/git/discard`, json("POST", { projectId, paths })),
  gitCommit: (projectId: string, message: string) =>
    jfetch<{ sha: string }>(`/api/git/commit`, json("POST", { projectId, message })),
  gitCommitMessage: (projectId: string) =>
    jfetch<{ message: string }>(`/api/git/commit-message`, json("POST", { projectId })).catch(
      (): { message: "" } => ({ message: "" }),
    ),
  gitBranches: (projectId: string) =>
    jfetch<GitBranches>(`/api/git/branches?projectId=${encodeURIComponent(projectId)}`).catch(
      (): GitBranches => ({ current: "", branches: [] }),
    ),
  gitBranch: (projectId: string, name: string, from?: string) =>
    jfetch<{ ok: true }>(`/api/git/branch`, json("POST", { projectId, name, from })),
  gitCheckout: (projectId: string, name: string) =>
    jfetch<{ ok: true }>(`/api/git/checkout`, json("POST", { projectId, name })),
  gitLog: (projectId: string, limit = 20) =>
    jfetch<GitLogEntry[]>(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GitLogEntry[] => [],
    ),

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
  filesTree: (projectId: string, relPath?: string, hidden?: boolean) =>
    jfetch<FileEntry[]>(`/api/files/tree?projectId=${encodeURIComponent(projectId)}${relPath ? `&path=${encodeURIComponent(relPath)}` : ""}${hidden ? "&hidden=true" : ""}`),
  filesRead: (projectId: string, relPath: string) =>
    jfetch<FileReadResult>(`/api/files/read?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}`),
  filesWrite: (projectId: string, relPath: string, content: string) =>
    jfetch<{ ok: true }>(`/api/files/write`, json("POST", { projectId, path: relPath, content })),
  filesMkdir: (projectId: string, relPath: string) =>
    jfetch<{ ok: true }>(`/api/files/mkdir`, json("POST", { projectId, path: relPath })),
  filesDelete: (projectId: string, relPath: string) =>
    jfetch<{ ok: true }>(`/api/files/delete`, json("POST", { projectId, path: relPath })),
  filesRename: (projectId: string, from: string, to: string) =>
    jfetch<{ ok: true }>(`/api/files/rename`, json("POST", { projectId, from, to })),
  filesUpload: (projectId: string, relPath: string, bytes: Uint8Array) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return jfetch<{ ok: true }>(`/api/files/upload`, json("POST", { projectId, path: relPath, base64: btoa(bin) }));
  },
  filesSearch: (projectId: string, q: string, limit = 50) =>
    jfetch<string[]>(`/api/files/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=${limit}`).catch(
      (): string[] => [],
    ),

  // ---- commands + snippets (§12) --------------------------------------------
  // PLAN §12: /api/commands and /api/snippets each return a flat array.
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

  // ---- schedule --------------------------------------------------------------
  scheduleList: (projectId?: string) =>
    jfetch<ScheduleTaskDto[]>(`/api/schedule${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`).catch(
      (): ScheduleTaskDto[] => [],
    ),
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

  // ---- github (gh CLI; fail-soft) --------------------------------------------
  githubStatus: (projectId: string) =>
    jfetch<GithubStatusDto>(`/api/github/status?projectId=${encodeURIComponent(projectId)}`).catch(
      (): GithubStatusDto => ({ installed: false, authenticated: false, repo: null, reason: "server unreachable" }),
    ),
  githubIssues: (projectId: string, limit = 30) =>
    jfetch<GhListResult<GithubIssueDto[]>>(`/api/github/issues?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GhListResult<GithubIssueDto[]> => ({ ok: false, reason: "server unreachable" }),
    ),
  githubPrs: (projectId: string, limit = 30) =>
    jfetch<GhListResult<GithubPrDto[]>>(`/api/github/prs?projectId=${encodeURIComponent(projectId)}&limit=${limit}`).catch(
      (): GhListResult<GithubPrDto[]> => ({ ok: false, reason: "server unreachable" }),
    ),

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
  previewStart: (projectId: string, command?: string) =>
    jfetch<{ url: string; port: number }>(`/api/preview/start`, json("POST", { projectId, command })),
  previewGet: (projectId: string) =>
    jfetch<PreviewState>(`/api/preview?projectId=${encodeURIComponent(projectId)}`).catch(
      (): PreviewState => ({ url: null, status: "off" }),
    ),
  previewStop: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/preview/stop`, json("POST", { projectId })),
};
