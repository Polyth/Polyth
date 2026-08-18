// Typed fetch wrappers for every REST endpoint in PLAN.md §5.
import type {
  AgentDescriptor,
  JsonObject,
  ModelDescriptor,
  Project,
  SessionEvent,
  SessionProjection,
  SessionRef,
  TurnRef,
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
};
