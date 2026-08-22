// GitHub integration via the `gh` CLI — no octokit, no token handling of our
// own. Every call fails soft: a missing binary, missing auth, or a non-GitHub
// repo yields { ok: false, reason } instead of throwing, so the UI can render
// an honest empty state.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { PrCheck } from "@polyth/contracts";
import { normalizeCheck, type RollupEntry } from "./checks.ts";

export { anyCheckPending, normalizeCheck, summarizeChecks } from "./checks.ts";
export type { ChecksGroup, ChecksSummary, RollupEntry } from "./checks.ts";
export { GITHUB_WIDGETS } from "../widgets/index.ts";

export type ExecFn = (
  bin: string,
  args: string[],
  opts: { cwd?: string; input?: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });

export type GhResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface GithubRepo {
  name: string;
  owner: string;
  url: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  author: string;
  updatedAt: string;
  url: string;
}

export interface GithubPr extends GithubIssue {
  isDraft: boolean;
  headRefName: string;
}

export interface CurrentPrSummary {
  number: number;
  title: string;
  url: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface GithubStatus {
  installed: boolean;
  authenticated: boolean;
  repo: GithubRepo | null;
  reason?: string;
}

// ---- PR detail surfaces (WP11) ----------------------------------------------

export interface PrDetail {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  url: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  /** source commit SHA the detail was read at — anchors comments/staleness */
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  /** review comments carry a file anchor; issue comments do not */
  path?: string;
  line?: number;
  outdated?: boolean;
  kind: "issue" | "review";
  reviewState?: string;
}

export interface ReviewCommentInput {
  path: string;
  side?: "LEFT" | "RIGHT";
  line: number;
  startLine?: number;
  body: string;
}

export interface SubmitReviewInput {
  number: number;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments?: ReviewCommentInput[];
  commitSha?: string;
}

// ---- PR lifecycle (F7) -------------------------------------------------------

export interface PrCreateInput {
  title: string;
  body: string;
  /** target branch; defaults to the repo's default branch when omitted */
  base?: string;
  draft?: boolean;
  /** fork-aware head ref (owner:branch); omitted = current branch */
  head?: string;
}

export type MergeStrategy = "squash" | "merge" | "rebase";

export interface GithubService {
  status(cwd: string): Promise<GithubStatus>;
  repo(cwd: string): Promise<GhResult<GithubRepo>>;
  issues(cwd: string, limit?: number): Promise<GhResult<GithubIssue[]>>;
  prs(cwd: string, limit?: number): Promise<GhResult<GithubPr[]>>;
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
  /** External write (F7). Opens a PR from the current branch (or `head`). */
  prCreate(cwd: string, input: PrCreateInput): Promise<GhResult<{ number: number; url: string }>>;
  /** External write (F7). Edits the title/body/base of an open PR. */
  prUpdate(cwd: string, number: number, patch: { title?: string; body?: string; base?: string }): Promise<GhResult<{ number: number }>>;
  /** External write (F7). Merges via GitHub with an explicit strategy.
   *  Never deletes the branch — that stays a separate, deliberate action. */
  prMerge(cwd: string, number: number, strategy: MergeStrategy): Promise<GhResult<{ number: number; strategy: MergeStrategy }>>;
}

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

export function createGithubService(deps: { exec?: ExecFn } = {}): GithubService {
  const exec = deps.exec ?? defaultExec;
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

  return {
    repo,

    async status(cwd) {
      let installed = true;
      let authenticated = false;
      try {
        await exec("gh", ["--version"], { cwd });
      } catch (e) {
        return { installed: false, authenticated: false, repo: null, reason: reasonOf(e) };
      }
      try {
        await exec("gh", ["auth", "status"], { cwd });
        authenticated = true;
      } catch {
        authenticated = false;
      }
      const r = await repo(cwd);
      return {
        installed,
        authenticated,
        repo: r.ok ? r.data : null,
        ...(r.ok ? {} : { reason: r.reason }),
      };
    },

    async issues(cwd, limit = 30) {
      const r = await ghJson<Array<{ number: number; title: string; state: string; author: { login: string } | null; updatedAt: string; url: string }>>(
        cwd,
        ["issue", "list", "--limit", String(limit), "--json", "number,title,state,author,updatedAt,url"],
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

    async prs(cwd, limit = 30) {
      const r = await ghJson<Array<{ number: number; title: string; state: string; author: { login: string } | null; updatedAt: string; url: string; isDraft: boolean; headRefName: string }>>(
        cwd,
        ["pr", "list", "--limit", String(limit), "--json", "number,title,state,author,updatedAt,url,isDraft,headRefName"],
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
        baseRefName: string; headRefName: string; headRefOid: string;
        additions: number; deletions: number; changedFiles: number;
        mergeable: string | null; createdAt: string; updatedAt: string;
      }>(cwd, [
        "pr", "view", String(number), "--json",
        "number,title,state,isDraft,author,url,body,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,mergeable,createdAt,updatedAt",
      ]);
      if (!r.ok) return r;
      return {
        ok: true,
        data: {
          number: r.data.number, title: r.data.title, state: r.data.state,
          isDraft: r.data.isDraft === true, author: r.data.author?.login ?? "",
          url: r.data.url, body: r.data.body ?? "",
          baseRefName: r.data.baseRefName, headRefName: r.data.headRefName,
          headRefOid: r.data.headRefOid ?? "",
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

    // ---- PR lifecycle (F7) ---------------------------------------------------

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
  };
}
