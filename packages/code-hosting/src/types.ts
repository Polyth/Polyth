import type { PrCheck } from "@polyth/contracts";

export type HostingResult<T> = { ok: true; data: T } | { ok: false; reason: string; code?: string; outcome?: "unknown" };

export interface HostingRepository {
  name: string;
  owner: string;
  url: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
  visibility?: "public" | "internal" | "private";
  provider?: "github" | "gitlab";
  instance?: string;
  fullPath?: string;
  upstream?: string;
}

export interface HostingIssue {
  number: number;
  title: string;
  state: string;
  author: string;
  updatedAt: string;
  url: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}
export interface HostingIssueDetail extends HostingIssue { body: string; createdAt: string }
export interface HostingIssueComment {
  id: string; author: string; body: string; createdAt: string; url: string;
  threadId?: string; replyToId?: string; resolved?: boolean;
}
export interface ChangeRequest extends HostingIssue {
  isDraft: boolean;
  headRefName: string;
  sourceProject?: string;
  targetProject?: string;
  baseRefName?: string;
  headRefOid?: string;
  diffRefs?: { base?: string; head?: string; start?: string };
}
export interface ChangeRequestDetail extends ChangeRequest {
  body: string;
  createdAt: string;
  baseRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
}
export interface ChangeRequestFile { path: string; additions: number; deletions: number }
export interface ChangeRequestComment extends HostingIssueComment {
  path?: string; line?: number; outdated?: boolean;
  kind: "issue" | "review"; reviewState?: string;
}
export interface ReviewThread {
  id: string;
  resolved: boolean;
  resolvable: boolean;
  comments: ChangeRequestComment[];
}
export interface ReviewCommentInput {
  path: string; oldPath?: string; side?: "LEFT" | "RIGHT"; line: number; startLine?: number; body: string;
}
export interface SubmitReviewInput {
  number: number;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments?: ReviewCommentInput[];
  commitSha?: string;
}
export interface PrCreateInput {
  title: string; body: string; base?: string; draft?: boolean; head?: string;
}
export type MergeStrategy = "squash" | "merge" | "rebase";
export interface HostingStatus {
  installed: boolean;
  authenticated: boolean;
  user: { login: string; avatarUrl: string } | null;
  repo: HostingRepository | null;
  reason?: string;
  /** Observed API access; Git transport authority is deliberately separate. */
  access?: Partial<Record<"readRepository" | "pushRepository" | "readApi" | "writeIssues" | "writeChanges" | "review", "available" | "denied" | "unknown" | "git-transport">>;
  capabilities?: { mergeStrategies: readonly MergeStrategy[]; reviewEvents: readonly ("COMMENT" | "APPROVE" | "REQUEST_CHANGES")[]; ready?: boolean; unapprove?: boolean; discussions?: boolean; reply?: boolean; resolve?: boolean };
}
export interface HostingService {
  status(cwd: string): Promise<HostingStatus>;
  repo(cwd: string): Promise<HostingResult<HostingRepository>>;
  issues(cwd: string, limit?: number, filters?: { state?: string; search?: string }): Promise<HostingResult<HostingIssue[]>>;
  getIssue(cwd: string, number: number): Promise<HostingResult<HostingIssueDetail>>;
  getIssueComments(cwd: string, number: number): Promise<HostingResult<HostingIssueComment[]>>;
  addIssueComment(cwd: string, number: number, body: string): Promise<HostingResult<{ url: string }>>;
  prs(cwd: string, limit?: number, filters?: { state?: string; search?: string }): Promise<HostingResult<ChangeRequest[]>>;
  addPrComment(cwd: string, number: number, body: string): Promise<HostingResult<{ url: string }>>;
  currentPrSummary(cwd: string): Promise<HostingResult<{ number: number; title: string; url: string; changedFiles: number; additions: number; deletions: number }>>;
  prDetail(cwd: string, number: number): Promise<HostingResult<ChangeRequestDetail>>;
  prFiles(cwd: string, number: number): Promise<HostingResult<ChangeRequestFile[]>>;
  prChecks(cwd: string, number: number): Promise<HostingResult<PrCheck[]>>;
  prComments(cwd: string, number: number): Promise<HostingResult<ChangeRequestComment[]>>;
  prDiff(cwd: string, number: number): Promise<HostingResult<string>>;
  submitReview(cwd: string, input: SubmitReviewInput): Promise<HostingResult<{ id: string; url?: string }>>;
  addLabels(cwd: string, number: number, labels: string[]): Promise<HostingResult<{ labels: string[] }>>;
  prCreate(cwd: string, input: PrCreateInput): Promise<HostingResult<{ number: number; url: string }>>;
  prUpdate(cwd: string, number: number, patch: { title?: string; body?: string; base?: string }): Promise<HostingResult<{ number: number }>>;
  prMerge(cwd: string, number: number, strategy: MergeStrategy, expectedHead?: string): Promise<HostingResult<{ number: number; strategy: MergeStrategy }>>;
  ready?(cwd: string, number: number): Promise<HostingResult<unknown>>;
  unapprove?(cwd: string, number: number): Promise<HostingResult<unknown>>;
  discussions?(cwd: string, number: number): Promise<HostingResult<ReviewThread[]>>;
  reply?(cwd: string, number: number, threadId: string, body: string): Promise<HostingResult<{ url: string }>>;
  resolve?(cwd: string, number: number, threadId: string, resolved: boolean): Promise<HostingResult<unknown>>;
}
