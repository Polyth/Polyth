// Git + worktree capability. Shells out to the `git` binary with argv arrays
// (never a shell string), so no user input can be interpreted as a command.
// Pure host logic: no HTTP, no session knowledge — the server maps projectId to
// a repo root and calls these.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type GitFileStatus =
  | "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted";

export interface GitFileEntry {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  origPath?: string; // rename source
}

export interface GitStatus {
  branch: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  clean: boolean;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitGraphCommit extends GitCommit {
  parents: string[];
  /** Decorations: branch heads, remote heads, tags pointing at this commit. */
  refs: string[];
}

export interface GitBranches {
  current: string | null;
  branches: Array<{ name: string; current: boolean; remote?: string }>;
}

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
}

export interface WorktreeService {
  list(root: string): Promise<Worktree[]>;
  create(root: string, input: { branch: string; path?: string; base?: string }): Promise<{ path: string; branch: string }>;
  remove(root: string, input: { path: string; deleteBranch?: boolean }): Promise<void>;
}

export interface GitService {
  isRepo(root: string): Promise<boolean>;
  status(root: string): Promise<GitStatus>;
  diff(root: string, opts?: { path?: string; staged?: boolean }): Promise<{ path: string | null; diff: string }>;
  /** All uncommitted changes (staged + unstaged) against HEAD; plain `git diff` on a fresh repo. */
  diffHead(root: string): Promise<string>;
  /** `git diff base...head` — the walkthrough snapshot for a commit range. */
  diffRange(root: string, base: string, head: string): Promise<string>;
  stage(root: string, paths: string[]): Promise<void>;
  unstage(root: string, paths: string[]): Promise<void>;
  discard(root: string, paths: string[]): Promise<void>;
  commit(root: string, message: string): Promise<{ sha: string }>;
  branches(root: string): Promise<GitBranches>;
  createBranch(root: string, name: string, from?: string): Promise<void>;
  checkout(root: string, name: string): Promise<void>;
  log(root: string, limit?: number): Promise<GitCommit[]>;
  /** History with parent SHAs and ref decorations, paginated for the graph view. */
  graph(root: string, opts?: { limit?: number; skip?: number }): Promise<GitGraphCommit[]>;
  worktrees: WorktreeService;
}

/** Expand a folder into the concrete changed paths under it, per status view.
 *  Pure — folder actions must act on what Git currently reports, never a glob. */
export function pathsUnder(
  status: Pick<GitStatus, "staged" | "unstaged" | "untracked" | "conflicted">,
  folder: string,
): { staged: string[]; unstaged: string[]; untracked: string[]; conflicted: string[] } {
  const prefix = folder.endsWith("/") ? folder : folder ? `${folder}/` : "";
  const under = (list: GitFileEntry[]) =>
    list.filter((f) => prefix === "" || f.path.startsWith(prefix)).map((f) => f.path);
  return {
    staged: under(status.staged),
    unstaged: under(status.unstaged),
    untracked: under(status.untracked),
    conflicted: under(status.conflicted),
  };
}

export interface GitServiceOptions {
  /** Configurable git binary (OC-13-011). */
  bin?: string;
  timeoutMs?: number;
}

interface RunResult { stdout: string; stderr: string; code: number }

const STATUS_LETTER: Record<string, GitFileStatus> = {
  A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "conflicted",
};

const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const shortErr = (stderr: string): string => {
  const line = stderr.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "git command failed";
  return line.replace(/^(fatal|error):\s*/i, "");
};

const sanitizeBranchDir = (branch: string): string =>
  branch.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const bin = opts.bin ?? process.env.POLYTH_GIT_BIN ?? "git";
  const timeout = opts.timeoutMs ?? 30_000;

  const run = (root: string, args: string[], allowFail = false): Promise<RunResult> =>
    new Promise((res, rej) => {
      execFile(bin, args, { cwd: root, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = (err as (Error & { code?: number }) | null)?.code ?? 0;
        if (err && !allowFail) {
          rej(Object.assign(new Error(shortErr(String(stderr || err.message))), { cause: stderr, code: "git-failed" }));
          return;
        }
        res({ stdout: String(stdout), stderr: String(stderr), code: typeof code === "number" ? code : 1 });
      });
    });

  const parseStatus = (raw: string): Omit<GitStatus, "branch" | "ahead" | "behind" | "upstream" | "clean"> => {
    const staged: GitFileEntry[] = [];
    const unstaged: GitFileEntry[] = [];
    const untracked: GitFileEntry[] = [];
    const conflicted: GitFileEntry[] = [];
    const fields = raw.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i];
      if (!entry || entry.startsWith("## ")) continue;
      const xy = entry.slice(0, 2);
      const path = entry.slice(3);
      if (xy === "??") {
        untracked.push({ path, status: "untracked", staged: false });
        continue;
      }
      if (CONFLICT_PAIRS.has(xy)) {
        conflicted.push({ path, status: "conflicted", staged: false });
        continue;
      }
      const x = xy[0]!;
      const y = xy[1]!;
      let origPath: string | undefined;
      if (x === "R" || x === "C") origPath = fields[++i]; // -z puts the source path in the next field
      if (x !== " " && x !== "?") {
        staged.push({ path, status: STATUS_LETTER[x] ?? "modified", staged: true, ...(origPath ? { origPath } : {}) });
      }
      if (y !== " " && y !== "?") {
        unstaged.push({ path, status: STATUS_LETTER[y] ?? "modified", staged: false });
      }
    }
    return { staged, unstaged, untracked, conflicted };
  };

  const parseBranchLine = (raw: string) => {
    const line = raw.split("\0").find((f) => f.startsWith("## ")) ?? "";
    const body = line.slice(3);
    let branch: string | null = null;
    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    if (body.startsWith("No commits yet on ")) {
      branch = body.slice("No commits yet on ".length).trim();
    } else if (body.startsWith("HEAD (no branch)")) {
      branch = null;
    } else if (body) {
      const [names, counts] = body.split(" [");
      const [local, up] = (names ?? "").split("...");
      branch = (local ?? "").trim() || null;
      if (up) upstream = up.trim();
      if (counts) {
        ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0);
        behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0);
      }
    }
    return { branch, upstream, ahead, behind };
  };

  const service: GitService = {
    async isRepo(root) {
      try {
        const r = await run(root, ["rev-parse", "--is-inside-work-tree"], true);
        return r.code === 0 && r.stdout.trim() === "true";
      } catch {
        return false;
      }
    },

    async status(root) {
      const { stdout } = await run(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]);
      const head = parseBranchLine(stdout);
      const lists = parseStatus(stdout);
      const clean =
        lists.staged.length + lists.unstaged.length + lists.untracked.length + lists.conflicted.length === 0;
      return {
        branch: head.branch,
        ...(head.upstream ? { upstream: head.upstream } : {}),
        ahead: head.ahead,
        behind: head.behind,
        ...lists,
        clean,
      };
    },

    async diff(root, o = {}) {
      const path = o.path ?? null;
      const args = ["diff", "--no-color"];
      if (o.staged) args.push("--cached");
      if (path) args.push("--", path);
      const r = await run(root, args, true);
      if (r.stdout.trim() || !path) return { path, diff: r.stdout };
      // Only an *untracked* file needs a synthesised diff; an empty diff for a
      // tracked file genuinely means "no changes in this view".
      const tracked = (await run(root, ["ls-files", "--error-unmatch", "--", path], true)).code === 0;
      if (tracked) return { path, diff: "" };
      const untracked = await run(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", path], true);
      return { path, diff: untracked.stdout };
    },

    async diffHead(root) {
      const hasHead = (await run(root, ["rev-parse", "--verify", "HEAD"], true)).code === 0;
      const r = await run(root, hasHead ? ["diff", "--no-color", "HEAD"] : ["diff", "--no-color"], true);
      return r.stdout;
    },

    async diffRange(root, base, head) {
      // refs are passed as separate argv entries — never interpolated into a shell
      const safe = /^[\w./~^-]{1,128}$/;
      if (!safe.test(base) || !safe.test(head)) {
        throw Object.assign(new Error("invalid ref"), { code: "invalid-input" });
      }
      const r = await run(root, ["diff", "--no-color", `${base}...${head}`]);
      return r.stdout;
    },

    async stage(root, paths) {
      if (!paths.length) return;
      await run(root, ["add", "--", ...paths]);
    },

    async unstage(root, paths) {
      if (!paths.length) return;
      // works with and without an initial commit
      const hasHead = (await run(root, ["rev-parse", "--verify", "HEAD"], true)).code === 0;
      await run(root, hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "--", ...paths]);
    },

    async discard(root, paths) {
      if (!paths.length) return;
      const status = await service.status(root);
      const untracked = new Set(status.untracked.map((f) => f.path));
      const tracked = paths.filter((p) => !untracked.has(p));
      const newFiles = paths.filter((p) => untracked.has(p));
      if (tracked.length) await run(root, ["checkout", "--", ...tracked]);
      if (newFiles.length) await run(root, ["clean", "-fd", "--", ...newFiles]);
    },

    async commit(root, message) {
      if (!message.trim()) throw Object.assign(new Error("commit message is empty"), { code: "invalid-input" });
      await run(root, ["commit", "-m", message]);
      const { stdout } = await run(root, ["rev-parse", "HEAD"]);
      return { sha: stdout.trim() };
    },

    async branches(root) {
      const cur = await run(root, ["rev-parse", "--abbrev-ref", "HEAD"], true);
      const current = cur.code === 0 && cur.stdout.trim() !== "HEAD" ? cur.stdout.trim() : null;
      const local = await run(root, ["branch", "--format=%(refname:short)"], true);
      const remote = await run(root, ["branch", "-r", "--format=%(refname:short)"], true);
      const branches: GitBranches["branches"] = local.stdout
        .split("\n").map((l) => l.trim()).filter(Boolean)
        .map((name) => ({ name, current: name === current }));
      for (const name of remote.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (name.includes("HEAD ->")) continue;
        branches.push({ name, current: false, remote: name.split("/")[0]! });
      }
      return { current, branches };
    },

    async createBranch(root, name, from) {
      await run(root, from ? ["branch", name, from] : ["branch", name]);
    },

    async checkout(root, name) {
      await run(root, ["checkout", name]);
    },

    async log(root, limit = 20) {
      const r = await run(root, ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"], true);
      if (r.code !== 0) return []; // e.g. repo without commits
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, shortSha, subject, author, date] = line.split("\x1f");
        return { sha: sha ?? "", shortSha: shortSha ?? "", subject: subject ?? "", author: author ?? "", date: date ?? "" };
      });
    },

    async graph(root, o = {}) {
      const limit = Math.min(Math.max(1, o.limit ?? 40), 400);
      const skip = Math.max(0, o.skip ?? 0);
      const r = await run(root, [
        "log", "--all", `-n${limit}`, `--skip=${skip}`, "--date-order",
        "--format=%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%aI",
      ], true);
      if (r.code !== 0) return []; // e.g. repo without commits
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [sha, shortSha, parents, decorations, subject, author, date] = line.split("\x1f");
        const refs = (decorations ?? "")
          .split(",").map((d) => d.trim().replace(/^HEAD -> /, "")).filter((d) => d && d !== "HEAD");
        return {
          sha: sha ?? "",
          shortSha: shortSha ?? "",
          parents: (parents ?? "").split(" ").filter(Boolean),
          refs,
          subject: subject ?? "",
          author: author ?? "",
          date: date ?? "",
        };
      });
    },

    worktrees: {
      async list(root) {
        const r = await run(root, ["worktree", "list", "--porcelain"], true);
        if (r.code !== 0) return [];
        const out: Worktree[] = [];
        let cur: Partial<Worktree> | null = null;
        for (const line of r.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "", isMain: out.length === 0 });
            cur = { path: line.slice("worktree ".length) };
          } else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5).trim();
          else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "").trim();
          else if (line === "detached" && cur) cur.branch = null;
        }
        if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "", isMain: out.length === 0 });
        return out;
      },

      async create(root, input) {
        const branch = input.branch.trim();
        if (!branch) throw Object.assign(new Error("branch name is required"), { code: "invalid-input" });
        const target = input.path
          ? resolve(input.path)
          : join(dirname(resolve(root)), `${basename(resolve(root))}-worktrees`, sanitizeBranchDir(branch));
        await mkdir(dirname(target), { recursive: true });
        const exists = (await run(root, ["rev-parse", "--verify", `refs/heads/${branch}`], true)).code === 0;
        if (exists) await run(root, ["worktree", "add", target, branch]);
        else {
          const base = input.base ?? "HEAD";
          await run(root, ["worktree", "add", "-b", branch, target, base]);
        }
        return { path: target, branch };
      },

      async remove(root, input) {
        const list = await service.worktrees.list(root);
        const wt = list.find((w) => resolve(w.path) === resolve(input.path));
        await run(root, ["worktree", "remove", "--force", input.path]);
        if (input.deleteBranch && wt?.branch) await run(root, ["branch", "-D", wt.branch], true);
      },
    },
  };

  return service;
}
