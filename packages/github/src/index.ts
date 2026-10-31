// GitHub integration via the `gh` CLI — no octokit, no token handling of our
// own. Every call fails soft: a missing binary, missing auth, or a non-GitHub
// repo yields { ok: false, reason } instead of throwing, so the UI can render
// an honest empty state.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrCheck } from "@polyth/contracts";
import {
  buildConflictResolutionPrompt as buildHostingConflictResolutionPrompt,
} from "@polyth/code-hosting/conflicts";
import type {
  ChangeRequest,
  ChangeRequestCheckFailure,
  ChangeRequestComment,
  ChangeRequestWatchComment,
  ChangeRequestWatchSource,
  ChangeRequestDetail,
  ChangeRequestFile,
  HostingIssue,
  HostingIssueComment,
  HostingIssueDetail,
  HostingRepository,
  HostingResult,
  HostingService,
  HostingStatus,
  MergeStrategy as HostingMergeStrategy,
  PrCreateInput as HostingPrCreateInput,
  ReviewCommentInput as HostingReviewCommentInput,
  SubmitReviewInput as HostingSubmitReviewInput,
} from "@polyth/code-hosting/types";
import { normalizeCheck, type RollupEntry } from "./checks.ts";
import { createGithubArchiveDownloader, type ArchiveExec } from "./archive.ts";
import type { RepositoryArchiveDownloader } from "@polyth/plugins";
import { GIT_BINARY_ENV, resolveExecutable } from "@polyth/kernel/executable";

export { anyCheckPending, normalizeCheck, summarizeChecks } from "./checks.ts";
export type { ChecksGroup, ChecksSummary, RollupEntry } from "./checks.ts";
export { GITHUB_WIDGETS } from "../widgets/catalog.ts";

export type ExecFn = (
  bin: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

// ---- whose GitHub account a `gh` call uses (Spaces §14.4) -------------------

/** A person's own GitHub token for the `gh` calls of one request. */
export interface GithubCallAuth {
  token: string;
  /** Host the token belongs to, e.g. "github.com" or a GitHub Enterprise host. */
  host: string;
}

const callAuth = new AsyncLocalStorage<GithubCallAuth>();
let emptyGhConfig: string | undefined;

/** Run `fn` with every `gh` call it makes authenticated as `auth` alone: the
 *  token reaches only that child's environment, and `gh` sees an empty config
 *  directory, so the host's own `gh` logins can never answer for it. Null
 *  keeps the host's `gh` logins (the installation account). */
export function withGithubAuth<T>(auth: GithubCallAuth | null, fn: () => Promise<T>): Promise<T> {
  if (!auth) return fn();
  if (!auth.token || /[\s\0]/.test(auth.token) || !/^[a-z0-9.-]+(?::\d+)?$/i.test(auth.host)) {
    return Promise.reject(Object.assign(new Error("GitHub credential is invalid"), { code: "auth-required", status: 409 }));
  }
  return callAuth.run({ token: auth.token, host: auth.host.toLowerCase() }, fn);
}

/** Environment for a `gh` child in the current auth context; empty outside one. */
export function githubCallEnv(): Record<string, string> {
  const auth = callAuth.getStore();
  if (!auth) return {};
  if (!emptyGhConfig) {
    const dir = mkdtempSync(join(tmpdir(), "polyth-gh-"));
    emptyGhConfig = dir;
    // One directory per process; without this every server restart and test
    // process left one behind in the shared temp directory.
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return {
    GH_CONFIG_DIR: emptyGhConfig,
    GH_PROMPT_DISABLED: "1",
    ...(auth.host === "github.com"
      ? { GH_TOKEN: auth.token, GH_HOST: auth.host }
      : { GH_ENTERPRISE_TOKEN: auth.token, GH_HOST: auth.host }),
  };
}

const defaultExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    let inputError: Error | undefined;
    const child = execFile(
      resolveExecutable(bin, bin === "git" ? { overrideEnv: GIT_BINARY_ENV } : {}),
      args,
      { cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024, timeout: 20_000, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else if (inputError) reject(Object.assign(inputError, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      // execFile's completion callback owns command failure, while stdin owns
      // asynchronous write failures such as EPIPE.
      child.stdin.on("error", (error) => { inputError = error; });
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });

export type GhResult<T> = HostingResult<T>;
export type GithubRepo = HostingRepository;
export type GithubIssue = HostingIssue;
export type GithubIssueDetail = HostingIssueDetail;
export type GithubIssueComment = HostingIssueComment;
export type GithubPr = ChangeRequest;

export interface CurrentPrSummary {
  number: number;
  title: string;
  url: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export type GithubStatus = HostingStatus;
/** The account `gh` answers as. */
export type GithubUser = NonNullable<GithubStatus["user"]>;

/** `code` of a failed {@link GithubService.user}: `gh` itself says there is no
 *  usable account. Every other failure (timeout, network, rate limit) says
 *  nothing about who is signed in. */
export const GITHUB_SIGNED_OUT = "signed-out";

// ---- PR detail surfaces -----------------------------------------------------

export type PrDetail = ChangeRequestDetail;

export function buildConflictResolutionPrompt(
  detail: Pick<PrDetail, "number" | "title" | "url" | "baseRefName" | "headRefName">,
  userPrompt: string,
): string {
  return buildHostingConflictResolutionPrompt(detail, userPrompt);
}

export type PrFile = ChangeRequestFile;
export type PrComment = ChangeRequestComment;
export type ReviewCommentInput = HostingReviewCommentInput;
export type SubmitReviewInput = HostingSubmitReviewInput;

// ---- PR lifecycle --------------------------------------------------------

export type PrCreateInput = HostingPrCreateInput;
export type MergeStrategy = HostingMergeStrategy;
export interface GithubService extends HostingService {
  /** Uses local gh authentication, then SSH keys; null allows public download. */
  downloadArchive: RepositoryArchiveDownloader;
  status(cwd: string): Promise<GithubStatus>;
  /** Who `gh` is signed in as: one `gh api user` call, no repository lookup.
   *  A definitive "no account" fails with `code: GITHUB_SIGNED_OUT`. */
  user(cwd: string): Promise<GhResult<GithubUser>>;
  repo(cwd: string): Promise<GhResult<GithubRepo>>;
  issues(cwd: string, limit?: number, filters?: { state?: string; search?: string }): Promise<GhResult<GithubIssue[]>>;
  getIssue(cwd: string, number: number): Promise<GhResult<GithubIssueDetail>>;
  getIssueComments(cwd: string, number: number): Promise<GhResult<GithubIssueComment[]>>;
  addIssueComment(cwd: string, number: number, body: string): Promise<GhResult<{ url: string }>>;
  prs(cwd: string, limit?: number, filters?: { state?: string; search?: string }): Promise<GhResult<GithubPr[]>>;
  addPrComment(cwd: string, number: number, body: string): Promise<GhResult<{ url: string }>>;
  currentPrSummary(cwd: string): Promise<GhResult<CurrentPrSummary>>;
  prDetail(cwd: string, number: number): Promise<GhResult<PrDetail>>;
  prFiles(cwd: string, number: number): Promise<GhResult<PrFile[]>>;
  prChecks(cwd: string, number: number): Promise<GhResult<PrCheck[]>>;
  prComments(cwd: string, number: number): Promise<GhResult<PrComment[]>>;
  prDiff(cwd: string, number: number): Promise<GhResult<string>>;
  /** External write. Idempotent per content digest — a retried submit with the
   *  same payload returns the first result instead of posting a duplicate. */
  submitReview(cwd: string, input: SubmitReviewInput): Promise<GhResult<{ id: string; url?: string }>>;
  /** External write. Labels are policy-checked (risk:N / confidence:N only). */
  addLabels(cwd: string, number: number, labels: string[]): Promise<GhResult<{ labels: string[] }>>;
  /** External write. Opens a PR from the current branch (or `head`). */
  prCreate(cwd: string, input: PrCreateInput): Promise<GhResult<{ number: number; url: string }>>;
  /** External write. Edits the title/body/base of an open PR. */
  prUpdate(cwd: string, number: number, patch: { title?: string; body?: string; base?: string }): Promise<GhResult<{ number: number }>>;
  /** External write. Merges via GitHub with an explicit strategy.
   *  Never deletes the branch — that stays a separate, deliberate action. */
  prMerge(cwd: string, number: number, strategy: MergeStrategy): Promise<GhResult<{ number: number; strategy: MergeStrategy }>>;
  /** Read-only state a chat's pull request watch polls. */
  watch: ChangeRequestWatchSource;
}

/** Repository roles whose comments may wake an agent. Contributors without
 *  write access and strangers on a public repository may not: their text
 *  could steer an agent that holds the person's credentials. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ACTIONS_JOB_URL = /\/actions\/runs\/\d+\/jobs?\/(\d+)/;
const EXIT_CODE_NOTE = /^Process completed with exit code \d+\.?$/i;

interface GhAuthor { login?: string; is_bot?: boolean }
const isBot = (author: GhAuthor | null | undefined, type?: string): boolean =>
  author?.is_bot === true || type === "Bot" || /\[bot\]$/i.test(author?.login ?? "");

const LABEL_POLICY = /^(risk|confidence):[1-5]$/;

// Refs go straight into argv (never a shell), but must not start with "-" so
// a crafted branch name can never be parsed by gh as a flag.
const SAFE_REF = /^[\w][\w./~^-]{0,255}$/;
// fork-aware head may carry an owner prefix: owner:branch
const SAFE_HEAD = /^[\w][\w./~^:-]{0,255}$/;
const MERGE_FLAG: Record<MergeStrategy, string> = {
  squash: "--squash",
  merge: "--merge",
  rebase: "--rebase",
};

const NOT_INSTALLED = "GitHub CLI (gh) is not installed — install it from cli.github.com";

function reasonOf(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string };
  if (err?.code === "ENOENT") return NOT_INSTALLED;
  const stderr = (err?.stderr ?? "").trim();
  if (/not logged in|auth login|authentication/i.test(stderr)) return "Not signed in — run `gh auth login`";
  if (/not a git repository|no git remotes|could not determine/i.test(stderr)) return "This project is not connected to a GitHub repository";
  return stderr.split("\n")[0] || (err instanceof Error ? err.message : String(e));
}

/** `gh` is missing, signed out or its token was rejected — not merely slow. */
function hasNoAccount(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException & { stderr?: string };
  return err?.code === "ENOENT" || /not logged in|auth login|authentication|bad credentials|HTTP 401/i.test(err?.stderr ?? "");
}

export function createGithubService(deps: { exec?: ExecFn; archiveExec?: ArchiveExec } = {}): GithubService {
  const baseExec = deps.exec ?? defaultExec;
  // Every `gh` child carries the current request's account (withGithubAuth).
  const exec: ExecFn = (bin, args, opts) => {
    const env = githubCallEnv();
    return baseExec(bin, args, Object.keys(env).length ? { ...opts, env: { ...opts.env, ...env } } : opts);
  };
  // idempotency memory for external review writes (content digest → result)
  const submittedReviews = new Map<string, GhResult<{ id: string; url?: string }>>();

  const ghJson = async <T>(cwd: string, args: string[]): Promise<GhResult<T>> => {
    try {
      const { stdout } = await exec("gh", args, { cwd });
      return { ok: true, data: JSON.parse(stdout) as T };
    } catch (e) {
      return { ok: false, reason: reasonOf(e) };
    }
  };

  const repo = async (cwd: string): Promise<GhResult<GithubRepo>> => {
    const r = await ghJson<{
      name: string;
      owner: { login: string };
      url: string;
      description: string | null;
      defaultBranchRef: { name: string } | null;
      isPrivate: boolean;
    }>(cwd, ["repo", "view", "--json", "name,owner,url,description,defaultBranchRef,isPrivate"]);
    if (!r.ok) return r;
    return {
      ok: true,
      data: {
        name: r.data.name,
        owner: r.data.owner?.login ?? "",
        url: r.data.url,
        description: r.data.description ?? "",
        defaultBranch: r.data.defaultBranchRef?.name ?? "",
        isPrivate: r.data.isPrivate === true,
      },
    };
  };

  const user = async (cwd: string): Promise<GhResult<GithubUser>> => {
    let stdout: string;
    try {
      ({ stdout } = await exec("gh", ["api", "user"], { cwd }));
    } catch (e) {
      return { ok: false, reason: reasonOf(e), ...(hasNoAccount(e) ? { code: GITHUB_SIGNED_OUT } : {}) };
    }
    try {
      const account = JSON.parse(stdout) as { login?: unknown; avatar_url?: unknown };
      if (typeof account.login === "string" && typeof account.avatar_url === "string") {
        return { ok: true, data: { login: account.login, avatarUrl: account.avatar_url } };
      }
    } catch { /* an unreadable answer is the same as no answer */ }
    return { ok: false, reason: "GitHub returned an unreadable account." };
  };

  return {
    downloadArchive: createGithubArchiveDownloader({ exec: deps.archiveExec }),
    repo,
    user,

    async status(cwd) {
      try {
        await exec("gh", ["--version"], { cwd });
      } catch (e) {
        return { installed: false, authenticated: false, user: null, repo: null, reason: reasonOf(e) };
      }
      // Each remaining probe is a network round trip; the repository lookup
      // does not depend on the auth probe, so they run side by side.
      const [{ authenticated, account }, r] = await Promise.all([
        (async () => {
          try {
            await exec("gh", ["auth", "status"], { cwd });
          } catch {
            return { authenticated: false, account: null };
          }
          return { authenticated: true, account: await user(cwd) };
        })(),
        repo(cwd),
      ]);
      return {
        installed: true,
        authenticated,
        user: account?.ok ? account.data : null,
        repo: r.ok ? r.data : null,
        ...(r.ok ? {} : { reason: r.reason }),
      };
    },

    async issues(cwd, limit = 30, filters) {
      const r = await ghJson<Array<{ number: number; title: string; state: string; author: { login: string } | null; updatedAt: string; url: string }>>(
        cwd,
        ["issue", "list", "--limit", String(limit), ...(filters?.state ? [`--state=${filters.state}`] : []), ...(filters?.search ? [`--search=${filters.search}`] : []), "--json", "number,title,state,author,updatedAt,url"],
      );
      if (!r.ok) return r;
      return {
        ok: true,
        data: r.data.map((i) => ({
          number: i.number, title: i.title, state: i.state,
          author: i.author?.login ?? "", updatedAt: i.updatedAt, url: i.url,
        })),
      };
    },

    async getIssue(cwd, number) {
      const r = await ghJson<{
        number: number; title: string; state: string; author: { login: string } | null;
        updatedAt: string; createdAt: string; url: string; body: string | null;
      }>(cwd, [
        "issue", "view", String(number), "--json",
        "number,title,state,author,updatedAt,createdAt,url,body",
      ]);
      if (!r.ok) return r;
      return {
        ok: true,
        data: {
          number: r.data.number,
          title: r.data.title,
          state: r.data.state,
          author: r.data.author?.login ?? "",
          updatedAt: r.data.updatedAt,
          createdAt: r.data.createdAt,
          url: r.data.url,
          body: r.data.body ?? "",
        },
      };
    },

    async getIssueComments(cwd, number) {
      const r = await ghJson<{
        comments?: Array<{
          id?: string; author: { login: string } | null; body: string;
          createdAt: string; url: string;
        }>;
      }>(cwd, ["issue", "view", String(number), "--json", "comments"]);
      if (!r.ok) return r;
      return {
        ok: true,
        data: (r.data.comments ?? []).map((comment, index) => ({
          id: comment.id || `comment-${index}`,
          author: comment.author?.login ?? "",
          body: comment.body ?? "",
          createdAt: comment.createdAt ?? "",
          url: comment.url ?? "",
        })),
      };
    },

    async addIssueComment(cwd, number, body) {
      const text = body.trim();
      if (!text) return { ok: false, reason: "comment body is required" };
      try {
        const { stdout } = await exec(
          "gh",
          ["issue", "comment", String(number), "--body-file", "-"],
          { cwd, input: text },
        );
        return { ok: true, data: { url: stdout.trim() } };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    async prs(cwd, limit = 30, filters) {
      const r = await ghJson<Array<{ number: number; title: string; state: string; author: { login: string } | null; updatedAt: string; url: string; isDraft: boolean; headRefName: string }>>(
        cwd,
        ["pr", "list", "--limit", String(limit), ...(filters?.state ? [`--state=${filters.state}`] : []), ...(filters?.search ? [`--search=${filters.search}`] : []), "--json", "number,title,state,author,updatedAt,url,isDraft,headRefName"],
      );
      if (!r.ok) return r;
      return {
        ok: true,
        data: r.data.map((p) => ({
          number: p.number, title: p.title, state: p.state,
          author: p.author?.login ?? "", updatedAt: p.updatedAt, url: p.url,
          isDraft: p.isDraft === true, headRefName: p.headRefName,
        })),
      };
    },

    async addPrComment(cwd, number, body) {
      const text = body.trim();
      if (!text) return { ok: false, reason: "comment body is required" };
      try {
        const { stdout } = await exec(
          "gh",
          ["pr", "comment", String(number), "--body-file", "-"],
          { cwd, input: text },
        );
        return { ok: true, data: { url: stdout.trim() } };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    async currentPrSummary(cwd) {
      const r = await ghJson<CurrentPrSummary>(
        cwd,
        ["pr", "view", "--json", "number,title,url,changedFiles,additions,deletions"],
      );
      if (!r.ok) return r;
      return {
        ok: true,
        data: {
          number: r.data.number,
          title: r.data.title,
          url: r.data.url,
          changedFiles: r.data.changedFiles ?? 0,
          additions: r.data.additions ?? 0,
          deletions: r.data.deletions ?? 0,
        },
      };
    },

    async prDetail(cwd, number) {
      const r = await ghJson<{
        number: number; title: string; state: string; isDraft: boolean;
        author: { login: string } | null; url: string; body: string | null;
        baseRefName: string; headRefName: string; headRefOid?: string;
        additions: number; deletions: number; changedFiles: number;
        mergeable: string | null; createdAt: string; updatedAt: string;
      }>(cwd, [
        "pr", "view", String(number), "--json",
        // headRefOid is not available in older gh releases (for example,
        // Ubuntu's gh 2.4.0), while the other detail fields are. Requesting
        // it here makes gh reject the entire PR response as an unknown field.
        "number,title,state,isDraft,author,url,body,baseRefName,headRefName,additions,deletions,changedFiles,mergeable,createdAt,updatedAt",
      ]);
      if (!r.ok) return r;
      let headRefOid = r.data.headRefOid ?? "";
      if (!headRefOid) {
        // The REST representation exposes the same value as head.sha and is
        // available through gh api even when pr view does not know headRefOid.
        // This is enrichment only: a failure must not prevent the PR detail
        // surface from loading on older CLIs or with restricted API access.
        const sha = await ghJson<{ head?: { sha?: string } }>(
          cwd,
          ["api", `repos/{owner}/{repo}/pulls/${number}`],
        );
        if (sha.ok && typeof sha.data.head?.sha === "string") headRefOid = sha.data.head.sha;
      }
      return {
        ok: true,
        data: {
          number: r.data.number, title: r.data.title, state: r.data.state,
          isDraft: r.data.isDraft === true, author: r.data.author?.login ?? "",
          url: r.data.url, body: r.data.body ?? "",
          baseRefName: r.data.baseRefName, headRefName: r.data.headRefName,
          headRefOid,
          additions: r.data.additions ?? 0, deletions: r.data.deletions ?? 0,
          changedFiles: r.data.changedFiles ?? 0, mergeable: r.data.mergeable ?? "UNKNOWN",
          createdAt: r.data.createdAt, updatedAt: r.data.updatedAt,
        },
      };
    },

    async prFiles(cwd, number) {
      const r = await ghJson<{ files?: Array<{ path: string; additions: number; deletions: number }> }>(
        cwd, ["pr", "view", String(number), "--json", "files"],
      );
      if (!r.ok) return r;
      return {
        ok: true,
        data: (r.data.files ?? []).map((f) => ({
          path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0,
        })),
      };
    },

    async prChecks(cwd, number) {
      const r = await ghJson<{ statusCheckRollup?: RollupEntry[] | null }>(
        cwd, ["pr", "view", String(number), "--json", "statusCheckRollup"],
      );
      if (!r.ok) return r;
      const rollup = Array.isArray(r.data.statusCheckRollup) ? r.data.statusCheckRollup : [];
      return { ok: true, data: rollup.map((e, i) => normalizeCheck(e, i)) };
    },

    async prComments(cwd, number) {
      const r = await ghJson<{
        comments?: Array<{ id?: string; author: { login: string } | null; body: string; createdAt: string; url: string }>;
        reviews?: Array<{ id?: string; author: { login: string } | null; body: string; submittedAt?: string; state?: string; url?: string }>;
      }>(cwd, ["pr", "view", String(number), "--json", "comments,reviews"]);
      if (!r.ok) return r;
      const out: PrComment[] = [];
      for (const [i, c] of (r.data.comments ?? []).entries()) {
        out.push({
          id: c.id || `comment-${i}`, author: c.author?.login ?? "", body: c.body ?? "",
          createdAt: c.createdAt ?? "", url: c.url ?? "", kind: "issue",
        });
      }
      for (const [i, rv] of (r.data.reviews ?? []).entries()) {
        if (!(rv.body ?? "").trim() && !(rv.state ?? "").trim()) continue;
        out.push({
          id: rv.id || `review-${i}`, author: rv.author?.login ?? "", body: rv.body ?? "",
          createdAt: rv.submittedAt ?? "", url: rv.url ?? "", kind: "review",
          ...(rv.state ? { reviewState: rv.state } : {}),
        });
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      return { ok: true, data: out };
    },

    async prDiff(cwd, number) {
      try {
        const { stdout } = await exec("gh", ["pr", "diff", String(number)], { cwd });
        return { ok: true, data: stdout };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    async submitReview(cwd, input) {
      const payload = {
        event: input.event,
        body: input.body,
        ...(input.commitSha ? { commit_id: input.commitSha } : {}),
        comments: (input.comments ?? []).map((c) => ({
          path: c.path, line: c.line, side: c.side ?? "RIGHT",
          ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
          body: c.body,
        })),
      };
      const digest = createHash("sha256")
        .update(`${input.number}\n${JSON.stringify(payload)}`)
        .digest("hex");
      const prior = submittedReviews.get(digest);
      if (prior) return prior;
      try {
        const { stdout } = await exec(
          "gh",
          [
            "api", `repos/{owner}/{repo}/pulls/${input.number}/reviews`,
            "--method", "POST", "--input", "-",
          ],
          { cwd, input: JSON.stringify(payload) },
        );
        const parsed = JSON.parse(stdout) as { id?: number | string; html_url?: string };
        const result: GhResult<{ id: string; url?: string }> = {
          ok: true,
          data: { id: String(parsed.id ?? ""), ...(parsed.html_url ? { url: parsed.html_url } : {}) },
        };
        submittedReviews.set(digest, result);
        return result;
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    async addLabels(cwd, number, labels) {
      const bad = labels.filter((l) => !LABEL_POLICY.test(l));
      if (bad.length || labels.length === 0) {
        return { ok: false, reason: `labels must match risk:N / confidence:N (1-5); rejected: ${bad.join(", ") || "(empty)"}` };
      }
      try {
        await exec("gh", ["pr", "edit", String(number), "--add-label", labels.join(",")], { cwd });
        return { ok: true, data: { labels } };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    // ---- PR lifecycle --------------------------------------------------------

    async prCreate(cwd, input) {
      const title = input.title.trim();
      if (!title) return { ok: false, reason: "a pull request title is required" };
      if (input.base !== undefined && !SAFE_REF.test(input.base)) {
        return { ok: false, reason: `invalid base ref: ${input.base}` };
      }
      if (input.head !== undefined && !SAFE_HEAD.test(input.head)) {
        return { ok: false, reason: `invalid head ref: ${input.head}` };
      }
      // body arrives via stdin (--body-file -) so its content can never be
      // read as arguments, whatever it contains
      const args = [
        "pr", "create", "--title", title, "--body-file", "-",
        ...(input.base ? ["--base", input.base] : []),
        ...(input.head ? ["--head", input.head] : []),
        ...(input.draft ? ["--draft"] : []),
      ];
      try {
        const { stdout } = await exec("gh", args, { cwd, input: input.body });
        const url = stdout.trim().split("\n").find((l) => /\/pull\/\d+/.test(l)) ?? "";
        const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
        if (!number) return { ok: false, reason: `gh did not return a pull request URL: ${stdout.trim().slice(0, 200)}` };
        return { ok: true, data: { number, url } };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    async prUpdate(cwd, number, patch) {
      const title = patch.title?.trim();
      const hasBody = typeof patch.body === "string";
      if (!title && !hasBody && patch.base === undefined) {
        return { ok: false, reason: "nothing to update — pass title, body, or base" };
      }
      if (patch.base !== undefined && !SAFE_REF.test(patch.base)) {
        return { ok: false, reason: `invalid base ref: ${patch.base}` };
      }
      const args = [
        "pr", "edit", String(number),
        ...(title ? ["--title", title] : []),
        ...(hasBody ? ["--body-file", "-"] : []),
        ...(patch.base ? ["--base", patch.base] : []),
      ];
      try {
        await exec("gh", args, { cwd, ...(hasBody ? { input: patch.body } : {}) });
        return { ok: true, data: { number } };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    async prMerge(cwd, number, strategy) {
      const flag = MERGE_FLAG[strategy];
      if (!flag) return { ok: false, reason: `merge strategy must be squash, merge, or rebase — got ${String(strategy)}` };
      try {
        // deliberately no --delete-branch: destructive follow-ups stay separate
        await exec("gh", ["pr", "merge", String(number), flag], { cwd });
        return { ok: true, data: { number, strategy } };
      } catch (e) {
        return { ok: false, reason: reasonOf(e) };
      }
    },

    watch: createGithubWatchSource(exec, ghJson),
  };
}

type GhJson = <T>(cwd: string, args: string[]) => Promise<GhResult<T>>;

/** Three reads per poll: the pull request (state and head commit, REST, so
 *  older `gh` releases without `headRefOid` work), its checks and
 *  conversation (one GraphQL view) and the newest inline review comments. */
function createGithubWatchSource(exec: ExecFn, ghJson: GhJson): ChangeRequestWatchSource {
  return {
    async snapshot(cwd, number, options = {}) {
      const pull = await ghJson<{
        number?: number; title?: string; html_url?: string; state?: string; merged?: boolean; merged_at?: string | null;
        head?: { sha?: string; ref?: string }; base?: { ref?: string };
      }>(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}`]);
      if (!pull.ok) return pull;
      const view = await ghJson<{
        statusCheckRollup?: RollupEntry[] | null;
        comments?: Array<{ id?: string; author?: GhAuthor | null; authorAssociation?: string; body?: string; createdAt?: string; url?: string; isMinimized?: boolean; viewerDidAuthor?: boolean }>;
        reviews?: Array<{ id?: string; author?: GhAuthor | null; authorAssociation?: string; body?: string; submittedAt?: string; state?: string }>;
      }>(cwd, ["pr", "view", String(number), "--json", "statusCheckRollup,comments,reviews"]);
      if (!view.ok) return view;
      // Inline comments are enrichment: a failure here keeps the poll alive.
      const inline = await ghJson<Array<{
        id?: number; user?: { login?: string; type?: string } | null; author_association?: string; body?: string;
        created_at?: string; html_url?: string; path?: string; line?: number | null; original_line?: number | null;
      }>>(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100&sort=created&direction=desc`]);
      const own = (login: string | undefined) => !!login && !!options.login && login.toLowerCase() === options.login.toLowerCase();
      const trusted = (association: string | undefined, login: string | undefined, bot: boolean, viewer?: boolean) =>
        viewer === true || own(login) || bot || TRUSTED_ASSOCIATIONS.has((association ?? "").toUpperCase());
      const url = pull.data.html_url ?? "";
      const comments: ChangeRequestWatchComment[] = [];
      for (const comment of view.data.comments ?? []) {
        // A bot's plain comment is a status report (coverage, previews), not a review.
        if (!comment.id || comment.isMinimized || isBot(comment.author) || !(comment.body ?? "").trim()) continue;
        comments.push({
          id: comment.id, author: comment.author?.login ?? "", body: comment.body ?? "", createdAt: comment.createdAt ?? "",
          url: comment.url ?? url, kind: "comment",
          trusted: trusted(comment.authorAssociation, comment.author?.login, false, comment.viewerDidAuthor),
        });
      }
      for (const review of view.data.reviews ?? []) {
        const state = (review.state ?? "").toUpperCase();
        // Approvals and empty review envelopes carry nothing to act on; their
        // inline comments arrive on their own.
        if (!review.id || state === "APPROVED" || state === "DISMISSED" || state === "PENDING") continue;
        if (!(review.body ?? "").trim() && state !== "CHANGES_REQUESTED") continue;
        comments.push({
          id: review.id, author: review.author?.login ?? "", body: review.body ?? "", createdAt: review.submittedAt ?? "",
          url, kind: "review", ...(state ? { reviewState: state } : {}),
          trusted: trusted(review.authorAssociation, review.author?.login, isBot(review.author)),
        });
      }
      for (const comment of inline.ok && Array.isArray(inline.data) ? inline.data : []) {
        if (typeof comment.id !== "number" || !(comment.body ?? "").trim()) continue;
        const line = comment.line ?? comment.original_line ?? undefined;
        comments.push({
          id: `inline-${comment.id}`, author: comment.user?.login ?? "", body: comment.body ?? "",
          createdAt: comment.created_at ?? "", url: comment.html_url ?? url, kind: "inline",
          ...(comment.path ? { path: comment.path } : {}),
          ...(typeof line === "number" && line > 0 ? { line } : {}),
          trusted: trusted(comment.author_association, comment.user?.login, isBot(comment.user, comment.user?.type ?? undefined)),
        });
      }
      const rollup = Array.isArray(view.data.statusCheckRollup) ? view.data.statusCheckRollup : [];
      return {
        ok: true,
        data: {
          number: pull.data.number ?? number,
          title: pull.data.title ?? "",
          url,
          state: pull.data.merged === true || !!pull.data.merged_at ? "merged" : pull.data.state === "closed" ? "closed" : "open",
          headSha: pull.data.head?.sha ?? "",
          headRef: pull.data.head?.ref ?? "",
          ...(pull.data.base?.ref ? { baseRef: pull.data.base.ref } : {}),
          checks: rollup.map((entry, index) => normalizeCheck(entry, index)),
          comments,
        },
      };
    },

    /** Only GitHub Actions jobs leave a log `gh` can read; other checks get
     *  their link. A check run's id is its job id. */
    async failure(cwd, check) {
      const jobId = check.url ? ACTIONS_JOB_URL.exec(check.url)?.[1] : undefined;
      if (!jobId) return { ok: false, reason: "This check has no GitHub Actions log." };
      const [annotations, log] = await Promise.all([
        ghJson<Array<{ path?: string; start_line?: number; annotation_level?: string; message?: string; title?: string }>>(
          cwd, ["api", `repos/{owner}/{repo}/check-runs/${jobId}/annotations?per_page=20`],
        ),
        exec("gh", ["run", "view", "--job", jobId, "--log-failed"], { cwd }).then(({ stdout }) => stdout, () => ""),
      ]);
      const detail: ChangeRequestCheckFailure = {
        annotations: (annotations.ok && Array.isArray(annotations.data) ? annotations.data : [])
          .filter((note) => (note.message ?? "").trim() && !EXIT_CODE_NOTE.test((note.message ?? "").trim()))
          .map((note) => ({
            ...(note.path && note.path !== ".github" ? { path: note.path } : {}),
            ...(typeof note.start_line === "number" && note.start_line > 0 ? { line: note.start_line } : {}),
            ...(note.annotation_level ? { level: note.annotation_level } : {}),
            message: note.title && !note.message!.startsWith(note.title) ? `${note.title}: ${note.message}` : note.message!,
          })),
        // `--log-failed` prefixes every line with the job and step names.
        ...(log.trim() ? { log: log.split("\n").map((line) => line.replace(/^[^\t]*\t[^\t]*\t/, "")).join("\n") } : {}),
      };
      return { ok: true, data: detail };
    },
  };
}
