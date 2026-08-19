// GitHub integration via the `gh` CLI — no octokit, no token handling of our
// own. Every call fails soft: a missing binary, missing auth, or a non-GitHub
// repo yields { ok: false, reason } instead of throwing, so the UI can render
// an honest empty state.
import { execFile } from "node:child_process";

export type ExecFn = (
  bin: string,
  args: string[],
  opts: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { ...opts, maxBuffer: 4 * 1024 * 1024, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
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

export interface GithubStatus {
  installed: boolean;
  authenticated: boolean;
  repo: GithubRepo | null;
  reason?: string;
}

export interface GithubService {
  status(cwd: string): Promise<GithubStatus>;
  repo(cwd: string): Promise<GhResult<GithubRepo>>;
  issues(cwd: string, limit?: number): Promise<GhResult<GithubIssue[]>>;
  prs(cwd: string, limit?: number): Promise<GhResult<GithubPr[]>>;
}

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
  };
}
