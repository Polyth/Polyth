// Git + worktree capability. Shells out to the `git` binary with argv arrays
// (never a shell string), so no user input can be interpreted as a command.
// Pure host logic: no HTTP, no session knowledge — the server maps projectId to
// a repo root and calls these.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { ProjectCloneInput, RemoteHost } from "@polyth/contracts";

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

export interface GitStash {
  ref: string;
  sha: string;
  message: string;
  date: string;
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
  prune(root: string): Promise<void>;
  /** Detached checkout used as a transient integration workspace. */
  addDetached(root: string, path: string, startPoint: string): Promise<void>;
}

export interface GitService {
  isRepo(root: string): Promise<boolean>;
  status(root: string): Promise<GitStatus>;
  diff(root: string, opts?: { path?: string; staged?: boolean; ignoreWhitespace?: boolean }): Promise<{ path: string | null; diff: string }>;
  show(root: string, sha: string, opts?: { ignoreWhitespace?: boolean }): Promise<{ sha: string; diff: string }>;
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
  stashList(root: string): Promise<GitStash[]>;
  stashPush(root: string, message?: string): Promise<{ created: boolean }>;
  stashApply(root: string, ref?: string): Promise<void>;
  stashDrop(root: string, ref?: string): Promise<void>;
  fetch(root: string, remote?: string): Promise<void>;
  pull(root: string, remote?: string): Promise<void>;
  push(root: string, remote?: string): Promise<void>;
  identity(root: string): Promise<{ name: string; email: string }>;
  setIdentity(root: string, identity: { name: string; email: string }): Promise<void>;
  /** Resolve a ref to a 40-char SHA. */
  revParse(root: string, rev: string): Promise<string>;
  gitDir(root: string): Promise<string>;
  commonDir(root: string): Promise<string>;
  /** `git add -A` — tracked mods/deletes plus untracked files, honouring gitignore. */
  stageAll(root: string): Promise<void>;
  /** HEAD + dirty-tree fingerprint used to suppress repeated merge suggestions. */
  fingerprint(root: string): Promise<string>;
  /** True when `root` has commits or a dirty tree not contained in `againstRef`. */
  hasUniqueChanges(root: string, againstRef: string): Promise<boolean>;
  /**
   * Snapshot uncommitted (gitignore-respecting) work as a synthetic commit on
   * the current branch. Returns the resulting HEAD. Identity is passed via
   * `-c` so the user's repo config is never rewritten.
   */
  snapshotCommit(root: string, message: string, identity?: { name: string; email: string }): Promise<{ sha: string; created: boolean }>;
  mergeSquash(root: string, ref: string): Promise<{ ok: true } | { ok: false; conflicted: string[] }>;
  abortMerge(root: string): Promise<void>;
  commitWithIdentity(root: string, message: string, identity?: { name: string; email: string }): Promise<{ sha: string }>;
  mergeFfOnly(root: string, sha: string): Promise<void>;
  /** Compare-and-swap a ref. Returns false when `expectedOldSha` no longer matches. */
  updateRef(root: string, ref: string, newSha: string, expectedOldSha: string): Promise<boolean>;
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

/** Compose the model-visible handoff prompt for resolving a *local* git
 *  conflict — a diverged fast-forward pull, or an in-progress merge/rebase/
 *  stash whose working tree carries conflict markers. Pure text: the server
 *  fills in the live repo state, the caller passes the user's default
 *  instruction (settings.conflictAgentPrompt). Sibling of the github
 *  package's buildConflictResolutionPrompt, which is PR-scoped. */
export function buildLocalConflictResolutionPrompt(
  state: {
    branch: string | null;
    ahead: number;
    behind: number;
    conflictedPaths: string[];
    diverged: boolean;
  },
  userPrompt: string,
): string {
  const instructions = userPrompt.trim();
  const lines = [
    "Resolve the git conflict in this repository's working tree.",
    "",
    "Repository state:",
    `- Branch: ${state.branch ?? "(detached HEAD)"}`,
    `- Local commits ahead of upstream: ${state.ahead}`,
    `- Upstream commits not yet integrated: ${state.behind}`,
  ];
  if (state.conflictedPaths.length > 0) {
    lines.push(`- Files with conflict markers (${state.conflictedPaths.length}):`);
    for (const path of state.conflictedPaths.slice(0, 50)) lines.push(`  - ${path}`);
    if (state.conflictedPaths.length > 50) lines.push("  - …");
  } else if (state.diverged) {
    lines.push(
      "- No files are conflicted yet: a fast-forward pull failed because local and upstream history diverged.",
    );
  }
  lines.push(
    "",
    "User instructions:",
    instructions || "Inspect and resolve every merge conflict in the working tree.",
    "",
    "Required steps:",
    "- If no merge or rebase is in progress yet, integrate the upstream branch first. This project keeps a linear history, so rebase the local commits onto the upstream branch (e.g. `git pull --rebase`) unless the user asked for a merge.",
    "- Resolve every conflict by understanding both sides; explain each non-obvious decision.",
    "- Remove all conflict markers and keep the code buildable.",
    "- Run the relevant tests or checks once the tree is clean.",
    "- Stage the resolved files and complete the rebase or merge locally.",
    "- Do NOT push or force-push without explicit user approval.",
  );
  return lines.join("\n");
}

export interface GitServiceOptions {
  /** Configurable git binary (OC-13-011). */
  bin?: string;
  timeoutMs?: number;
}

const cloneError = (message: string) => Object.assign(new Error(message), { code: "git-failed" });

/** Accepted public repository forms are deliberately narrow: only GitHub and
 * GitLab clone URLs, with no credentials embedded in the URL. */
export function normalizeRepositoryUrl(value: string): string {
  const repository = value.trim();
  if (!repository || repository.length > 2_048 || /[\s\0\p{Cc}]/u.test(repository)) {
    throw Object.assign(new Error("repository must be a valid GitHub or GitLab URL"), { code: "invalid-input" });
  }
  const scp = repository.match(/^git@(github\.com|gitlab\.com):(.+)$/i);
  if (scp) {
    if (!validRepositoryPath(scp[2]!)) throw Object.assign(new Error("repository path is invalid"), { code: "invalid-input" });
    return repository;
  }
  let parsed: URL;
  try { parsed = new URL(repository); } catch {
    throw Object.assign(new Error("repository must be a valid GitHub or GitLab URL"), { code: "invalid-input" });
  }
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ssh:")
    || !/^(github\.com|gitlab\.com)$/i.test(parsed.hostname)
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.protocol !== "ssh:" && parsed.username)
    || !validRepositoryPath(parsed.pathname.slice(1))) {
    throw Object.assign(new Error("repository must be a GitHub or GitLab HTTP(S)/SSH URL without credentials"), { code: "invalid-input" });
  }
  return repository;
}

const validRepositoryPath = (path: string): boolean => {
  const clean = path.replace(/\/$/, "");
  return clean.length > 0
    && !/[?#]/.test(clean)
    && !clean.split("/").includes("..")
    && clean.split("/").length >= 2
    && /^[^/]+(?:\/[^/]+)+$/.test(clean);
};

const safeName = (value: string | undefined, repository: string): string => {
  const fromUrl = repository.includes(":") && !repository.includes("//")
    ? repository.slice(repository.lastIndexOf(":") + 1).split("/").at(-1)
    : new URL(repository).pathname.split("/").filter(Boolean).at(-1);
  const fallback = (fromUrl ?? "repository").replace(/\.git$/i, "");
  const name = (value ?? fallback).trim();
  if (!name || name === "." || name === ".." || name.startsWith("-") || name.length > 120 || /[\\/\0\p{Cc}]/u.test(name)) {
    throw Object.assign(new Error("project name must be a safe folder name"), { code: "invalid-input" });
  }
  return name;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const isDirectory = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

export interface CloneRepositoryResult { path: string; name: string }

/** Clone on the current host, or through the supplied RemoteHost. */
export async function cloneRepository(
  input: ProjectCloneInput,
  remote?: RemoteHost,
  timeoutMs = 120_000,
): Promise<CloneRepositoryResult> {
  const repository = normalizeRepositoryUrl(input.repository);
  const name = safeName(input.name, repository);
  const rawParentPath = typeof input.parentPath === "string" ? input.parentPath.trim() : "";
  const parentPath = remote ? rawParentPath : resolve(rawParentPath);
  if (!rawParentPath || (remote ? !parentPath.startsWith("/") : !isDirectory(parentPath))) {
    throw Object.assign(new Error("destination parent folder does not exist"), { code: "invalid-path" });
  }
  const target = remote ? posix.join(parentPath, name) : join(parentPath, name);
  if (remote) {
    const parent = await remote.exec(`test -d -- ${shellQuote(parentPath)}`);
    if (parent.code !== 0) throw Object.assign(new Error("destination parent folder does not exist on the remote host"), { code: "invalid-path" });
    const existing = await remote.exec(`test -e -- ${shellQuote(target)}`);
    if (existing.code === 0) throw Object.assign(new Error(`destination already exists: ${target}`), { code: "conflict" });
    const result = await remote.exec(
      `git clone -- ${shellQuote(repository)} ${shellQuote(target)}`,
      { timeoutMs, maxOutputBytes: 32 * 1024 * 1024 },
    );
    if (result.code !== 0) {
      await remote.exec(`rm -rf -- ${shellQuote(target)}`).catch(() => undefined);
      throw cloneError((result.stderr || result.stdout).trim().split("\n")[0] || "git clone failed");
    }
    return { path: target, name };
  }
  if (existsSync(target)) throw Object.assign(new Error(`destination already exists: ${target}`), { code: "conflict" });
  await new Promise<void>((resolvePromise, reject) => {
    execFile(process.env.POLYTH_GIT_BIN ?? "git", ["clone", "--", repository, target], {
      cwd: parentPath,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (!error) { resolvePromise(); return; }
      rmSync(target, { recursive: true, force: true });
      reject(cloneError((String(stderr) || String(stdout) || error.message).trim().split("\n")[0] || "git clone failed"));
    });
  });
  return { path: target, name };
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

const SAFE_REV = /^[\w./~^{}@+-]{1,160}$/;
const assertRev = (rev: string, label = "ref"): string => {
  if (!SAFE_REV.test(rev) || rev.startsWith("-")) {
    throw Object.assign(new Error(`invalid ${label}`), { code: "invalid-input" });
  }
  return rev;
};

interface GitRunOpts {
  allowFail?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const bin = opts.bin ?? process.env.POLYTH_GIT_BIN ?? "git";
  const timeout = opts.timeoutMs ?? 30_000;

  const run = (root: string, args: string[], allowFailOrOpts: boolean | GitRunOpts = false): Promise<RunResult> =>
    new Promise((res, rej) => {
      const opts: GitRunOpts = typeof allowFailOrOpts === "boolean"
        ? { allowFail: allowFailOrOpts }
        : allowFailOrOpts;
      execFile(bin, args, {
        cwd: root,
        timeout: opts.timeoutMs ?? timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) },
      }, (err, stdout, stderr) => {
        const code = (err as (Error & { code?: number }) | null)?.code ?? 0;
        if (err && !opts.allowFail) {
          rej(Object.assign(new Error(shortErr(String(stderr || err.message))), { cause: stderr, code: "git-failed" }));
          return;
        }
        res({ stdout: String(stdout), stderr: String(stderr), code: typeof code === "number" ? code : 1 });
      });
    });
  const configValue = async (root: string, key: string): Promise<string> =>
    (await run(root, ["config", "--local", "--get", key], true)).stdout.trim();

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
      if (o.ignoreWhitespace) args.push("--ignore-all-space");
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

    async show(root, sha, o = {}) {
      if (!/^[\w./~^{}@+-]{1,160}$/.test(sha) || sha.startsWith("-")) {
        throw Object.assign(new Error("invalid commit ref"), { code: "invalid-input" });
      }
      const args = ["show", "--format=fuller", "--no-ext-diff", "--no-color"];
      if (o.ignoreWhitespace) args.push("--ignore-all-space");
      args.push(sha);
      const r = await run(root, args);
      return { sha, diff: r.stdout };
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

    async stashList(root) {
      const r = await run(root, ["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%aI"], true);
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [ref, sha, message, date] = line.split("\x1f");
        return { ref: ref ?? "", sha: sha ?? "", message: message ?? "", date: date ?? "" };
      });
    },

    async stashPush(root, message) {
      const args = ["stash", "push", "--include-untracked"];
      const cleanMessage = message?.trim();
      if (cleanMessage) args.push("-m", cleanMessage);
      const r = await run(root, args);
      return { created: !/No local changes to save/i.test(r.stdout) };
    },

    async stashApply(root, ref = "stash@{0}") {
      if (!/^stash@\{\d+\}$/.test(ref)) throw Object.assign(new Error("invalid stash ref"), { code: "invalid-input" });
      await run(root, ["stash", "apply", ref]);
    },

    async stashDrop(root, ref = "stash@{0}") {
      if (!/^stash@\{\d+\}$/.test(ref)) throw Object.assign(new Error("invalid stash ref"), { code: "invalid-input" });
      await run(root, ["stash", "drop", ref]);
    },

    async fetch(root, remote = "origin") {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      await run(root, ["fetch", remote]);
    },

    async pull(root, remote = "origin") {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      try {
        await run(root, ["pull", "--ff-only", remote]);
      } catch (error) {
        const failure = error as Error & { cause?: unknown };
        if (/not possible to fast-forward/i.test(`${failure.message} ${String(failure.cause ?? "")}`)) {
          throw Object.assign(
            new Error("Pull cannot fast-forward because local and remote histories have diverged. Rebase or merge your local commits, then try again."),
            { code: "conflict" },
          );
        }
        throw error;
      }
    },

    async push(root, remote = "origin") {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      // On a normal branch with no tracking ref yet, `git push` aborts with
      // "has no upstream branch". Publish the branch and set upstream so the
      // first push (and every sync after) just works.
      const branchRef = await run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const branch = branchRef.code === 0 ? branchRef.stdout.trim() : "";
      if (branch) {
        const hasUpstream = (await run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true)).code === 0;
        if (!hasUpstream) {
          await run(root, ["push", "--set-upstream", remote, branch]);
          return;
        }
      }
      await run(root, ["push", remote]);
    },

    async identity(root) {
      return {
        name: await configValue(root, "user.name"),
        email: await configValue(root, "user.email"),
      };
    },

    async setIdentity(root, identity) {
      const name = identity.name.trim();
      const email = identity.email.trim();
      if (!name || name.length > 160) throw Object.assign(new Error("git name required (≤160 characters)"), { code: "invalid-input" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw Object.assign(new Error("valid git email required"), { code: "invalid-input" });
      }
      await run(root, ["config", "--local", "user.name", name]);
      await run(root, ["config", "--local", "user.email", email]);
    },

    async revParse(root, rev) {
      const r = await run(root, ["rev-parse", "--verify", `${assertRev(rev)}^{commit}`], true);
      if (r.code !== 0 || !r.stdout.trim()) {
        throw Object.assign(new Error(`unknown revision ${rev}`), { code: "not-found" });
      }
      return r.stdout.trim();
    },

    async gitDir(root) {
      return (await run(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    },

    async commonDir(root) {
      const r = await run(root, ["rev-parse", "--absolute-git-common-dir"], true);
      return (r.code === 0 && r.stdout.trim()) || (await service.gitDir(root));
    },

    async stageAll(root) {
      await run(root, ["add", "-A", "--"]);
    },

    async fingerprint(root) {
      const head = (await run(root, ["rev-parse", "HEAD"], true)).stdout.trim() || "unborn";
      const porcelain = (await run(root, ["status", "--porcelain=v1", "-unormal"], true)).stdout;
      const trackedDiff = (await run(root, ["diff", "HEAD"], true)).stdout;
      const untrackedList = (await run(root, ["ls-files", "--others", "--exclude-standard", "-z"], true)).stdout;
      const untracked = untrackedList.split("\0").filter(Boolean);
      const hash = createHash("sha256");
      hash.update(porcelain);
      hash.update("\n");
      hash.update(trackedDiff);
      for (const path of untracked) {
        hash.update(path);
        hash.update("\n");
        try {
          hash.update(readFileSync(join(root, path)));
        } catch {
          hash.update("missing");
        }
      }
      return `${head}:${hash.digest("hex").slice(0, 16)}`;
    },

    async hasUniqueChanges(root, againstRef) {
      assertRev(againstRef);
      const dirty = (await run(root, ["status", "--porcelain=v1", "-unormal"], true)).stdout.trim();
      if (dirty) return true;
      const ahead = await run(root, ["rev-list", "--count", `${againstRef}..HEAD`], true);
      return ahead.code === 0 && Number(ahead.stdout.trim()) > 0;
    },

    async snapshotCommit(root, message, identity) {
      await service.stageAll(root);
      const staged = await run(root, ["diff", "--cached", "--quiet"], true);
      if (staged.code === 0) {
        const sha = (await run(root, ["rev-parse", "HEAD"], true)).stdout.trim();
        return { sha, created: false };
      }
      const committed = await service.commitWithIdentity(root, message, identity);
      return { sha: committed.sha, created: true };
    },

    async mergeSquash(root, ref) {
      assertRev(ref);
      const r = await run(root, ["merge", "--squash", "--no-commit", ref], {
        allowFail: true,
        timeoutMs: Math.max(timeout, 120_000),
      });
      if (r.code === 0) return { ok: true };
      const status = await service.status(root);
      const conflicted = status.conflicted.map((file) => file.path);
      if (conflicted.length > 0 || /conflict/i.test(`${r.stdout}\n${r.stderr}`)) {
        return { ok: false, conflicted };
      }
      throw Object.assign(new Error(shortErr(r.stderr || r.stdout || "merge --squash failed")), {
        code: "git-failed",
      });
    },

    async abortMerge(root) {
      await run(root, ["merge", "--abort"], true);
    },

    async commitWithIdentity(root, message, identity) {
      if (!message.trim()) throw Object.assign(new Error("commit message is empty"), { code: "invalid-input" });
      const name = identity?.name.trim() || (await service.identity(root)).name || "Polyth";
      const email = identity?.email.trim() || (await service.identity(root)).email || "polyth@localhost";
      await run(root, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message]);
      const { stdout } = await run(root, ["rev-parse", "HEAD"]);
      return { sha: stdout.trim() };
    },

    async mergeFfOnly(root, sha) {
      assertRev(sha);
      await run(root, ["merge", "--ff-only", sha], { timeoutMs: Math.max(timeout, 120_000) });
    },

    async updateRef(root, ref, newSha, expectedOldSha) {
      assertRev(ref);
      assertRev(newSha, "sha");
      assertRev(expectedOldSha, "sha");
      const r = await run(root, ["update-ref", ref, newSha, expectedOldSha], true);
      return r.code === 0;
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

      async prune(root) {
        await run(root, ["worktree", "prune"], true);
      },

      async addDetached(root, path, startPoint) {
        assertRev(startPoint);
        const target = resolve(path);
        await mkdir(dirname(target), { recursive: true });
        await run(root, ["worktree", "add", "--detach", target, startPoint]);
      },
    },
  };

  return service;
}
