import type { ReactNode } from "react";
import { ApiError, createApiTransport, type ApiTransport } from "@polyth/web-sdk";
import type { PrCheck } from "@polyth/contracts";
import type { ChecksSummary } from "@polyth/code-hosting/checks";
import type {
  ChangeRequest, ChangeRequestComment, ChangeRequestDetail, ChangeRequestFile,
  HostingIssueComment, HostingIssueDetail, HostingIssue, HostingResult, HostingStatus,
} from "@polyth/code-hosting";

export interface CodeHostingPresentation {
  serviceName: string; command: string;
  /** Singular, prose-safe label ("issue"). Used in agent prompts and titles. */
  issueLabel: string;
  /** Plural heading for the issues list and its empty state ("Issues"). Optional
   *  so an existing provider that predates the tab correction keeps compiling;
   *  the view falls back to issueLabel when it is absent. */
  issuePlural?: string;
  changeLabel: string;
  changePlural: string; changeNumberPrefix: "#" | "!"; icon: () => ReactNode;
}
export interface CodeHostingProvider {
  id: string; apiBase: string; presentation: CodeHostingPresentation;
  t(key: string, values?: Record<string, string | number>): string;
}
export interface CodeHostingClient {
  status(projectId: string): Promise<HostingStatus>;
  issues(projectId: string, limit?: number, filters?: { state?: string; search?: string }): Promise<HostingResult<HostingIssue[]>>;
  changes(projectId: string, limit?: number, filters?: { state?: string; search?: string }): Promise<HostingResult<ChangeRequest[]>>;
  issue(projectId: string, number: number): Promise<HostingResult<HostingIssueDetail>>;
  issueComments(projectId: string, number: number): Promise<HostingResult<HostingIssueComment[]>>;
  repository(projectId: string): Promise<HostingResult<{ defaultBranch: string }>>;
  change(projectId: string, number: number): Promise<HostingResult<ChangeRequestDetail>>;
  changeFiles(projectId: string, number: number): Promise<HostingResult<ChangeRequestFile[]>>;
  changeComments(projectId: string, number: number): Promise<HostingResult<ChangeRequestComment[]>>;
  discussions(projectId: string, number: number): Promise<HostingResult<Array<{ id: string; resolved: boolean; resolvable: boolean; comments: ChangeRequestComment[] }>>>;
  changeDiff(projectId: string, number: number): Promise<HostingResult<string>>;
  checks(projectId: string, number: number): Promise<HostingResult<{ checks: PrCheck[]; summary: ChecksSummary }>>;
  update(input: { projectId: string; number: number; title?: string; body?: string; base?: string; sessionId?: string }): Promise<HostingResult<{ number: number }>>;
  submitReview(input: { projectId: string; number: number; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; comments?: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; body: string }>; commitSha?: string; confirm?: boolean; sessionId?: string }): Promise<HostingResult<{ id: string; url?: string }>>;
  conflictAgent(input: { projectId: string; number: number; prompt: string; target: "new-session" | "current-session"; sessionId?: string }): Promise<HostingResult<{ sessionId: string }>>;
  addComment(input: { kind: "issue" | "pr"; projectId: string; number: number; body: string; sessionId?: string }): Promise<HostingResult<{ url: string }>>;
  describe(input: { projectId: string; base?: string }): Promise<HostingResult<{ title: string; body: string }>>;
  create(input: { projectId: string; title: string; body: string; base?: string; draft?: boolean; sessionId?: string }): Promise<HostingResult<{ number: number; url: string }>>;
  merge(input: { projectId: string; number: number; strategy: "squash" | "merge" | "rebase"; headSha?: string; sessionId?: string }): Promise<HostingResult<{ number: number }>>;
  ready(input: { projectId: string; number: number }): Promise<HostingResult<unknown>>;
  unapprove(input: { projectId: string; number: number }): Promise<HostingResult<unknown>>;
  reply(input: { projectId: string; number: number; discussionId: string; body: string }): Promise<HostingResult<{ url: string }>>;
  resolve(input: { projectId: string; number: number; discussionId: string; resolved?: boolean }): Promise<HostingResult<unknown>>;
}
export const supportedMergeStrategies = (status: HostingStatus | null): readonly ("squash" | "merge" | "rebase")[] =>
  status ? status.capabilities?.mergeStrategies ?? ["squash", "merge", "rebase"] : [];
export const supportedReviewEvents = (status: HostingStatus | null): readonly ("COMMENT" | "APPROVE" | "REQUEST_CHANGES")[] =>
  status ? status.capabilities?.reviewEvents ?? ["COMMENT", "APPROVE", "REQUEST_CHANGES"] : [];
const query = (path: string, values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return `${path}?${params}`;
};
export function createCodeHostingClient(provider: CodeHostingProvider, transport: ApiTransport = createApiTransport()): CodeHostingClient {
  const at = (path: string) => `${provider.apiBase}${path}`;
  // Retain uncertain attempts in this client: repeated clicks cannot turn a
  // lost response into another comment/review/create. Refresh reconciles reads.
  const attempts = new Map<string, Promise<HostingResult<unknown>>>();
  const mutation = <T,>(path: string, body: Record<string, unknown>): Promise<HostingResult<T>> => {
    const key = JSON.stringify([path, body]);
    const existing = attempts.get(key);
    if (existing) return existing as Promise<HostingResult<T>>;
    const pending = transport.post<HostingResult<T>>(at(path), { ...body, requestId: crypto.randomUUID() }).catch((error: unknown): HostingResult<T> => {
      if (error instanceof ApiError) {
        try {
          const result = JSON.parse(error.message) as HostingResult<T>;
          if (result.ok === false && typeof result.reason === "string") return result;
        } catch { /* Non-JSON failures cannot prove whether a write happened. */ }
      }
      return { ok: false, outcome: "unknown", code: "mutation-unknown", reason: "The operation may have completed. Check the provider before trying another action." };
    }).then(result => {
      if (result.ok || result.outcome !== "unknown") attempts.delete(key);
      return result;
    });
    attempts.set(key, pending);
    return pending;
  };
  return {
    status: (projectId) => transport.get(query(at("/status"), { projectId })),
    issues: (projectId, limit = 30, filters) => transport.get(query(at("/issues"), { projectId, limit, state: filters?.state, search: filters?.search })),
    changes: (projectId, limit = 30, filters) => transport.get(query(at("/prs"), { projectId, limit, state: filters?.state, search: filters?.search })),
    repository: (projectId) => transport.get(query(at("/repo"), { projectId })), issue: (projectId, number) => transport.get(query(at("/issue"), { projectId, number })), issueComments: (projectId, number) => transport.get(query(at("/issue/comments"), { projectId, number })),
    change: (projectId, number) => transport.get(query(at("/pr"), { projectId, number })), changeFiles: (projectId, number) => transport.get(query(at("/pr/files"), { projectId, number })), changeComments: (projectId, number) => transport.get(query(at("/pr/comments"), { projectId, number })), discussions: (projectId, number) => transport.get(query(at(`/pr/${number}/discussions`), { projectId })), changeDiff: (projectId, number) => transport.get(query(at("/pr/diff"), { projectId, number })), checks: (projectId, number) => transport.get(query(at("/pr/checks"), { projectId, number })),
    update: (input) => mutation("/pr/update", input), submitReview: (input) => mutation(`/pr/${input.number}/reviews`, input), conflictAgent: (input) => mutation("/pr/conflict-agent", input),
    addComment: ({ kind, number, ...input }) => mutation(`/${kind}/${number}/comments`, input),
    describe: (input) => mutation("/pr/describe", input), create: (input) => mutation("/pr/create", input),
    merge: (input) => mutation("/pr/merge", { ...input, confirm: true, ...(input.headSha ? { headSha: input.headSha } : {}) }), ready: (input) => mutation(`/pr/${input.number}/ready`, { projectId: input.projectId }), unapprove: (input) => mutation(`/pr/${input.number}/unapprove`, { projectId: input.projectId, confirm: true }), reply: (input) => mutation(`/pr/${input.number}/discussions/${encodeURIComponent(input.discussionId)}/reply`, { projectId: input.projectId, body: input.body }), resolve: (input) => mutation(`/pr/${input.number}/discussions/${encodeURIComponent(input.discussionId)}/resolve`, { projectId: input.projectId, resolved: input.resolved ?? true }),
  };
}
