// Git + worktree capability. Shells out to the `git` binary with argv arrays
// (never a shell string), so no user input can be interpreted as a command.
// Pure host logic: no HTTP, no session knowledge — the server maps projectId to
// a repo root and calls these.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS, existsSync, rmSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readlink, realpath, rm, rmdir, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import type { ProjectCloneInput, RemoteHost } from "@polyth/contracts";
import { currentGitCommitIdentity, gitTransportInvocation } from "./sourceControlAccounts.ts";
import { resolveGitBinary } from "./gitBinary.ts";

export { resolveGitBinary, type GitBinaryOptions } from "./gitBinary.ts";

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

/** Hard ceilings for branch review. The file list and a single patch are
 *  capped so a huge branch cannot stall the server or the renderer; callers
 *  surface `truncated` rather than silently dropping rows. */
export const BRANCH_DIFF_MAX_FILES = 1000;
export const BRANCH_DIFF_MAX_PATCH_CHARS = 512 * 1024;

export type GitBranchFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface GitBranchFile {
  path: string;
  /** Rename source. */
  previousPath?: string;
  status: GitBranchFileStatus;
  additions: number;
  deletions: number;
  /** Git reported the change as binary; no content is ever returned for it. */
  binary?: true;
  /** The entry is a symbolic link; at most its link text is reviewable. */
  symlink?: true;
}

/** Why this base was compared: a managed isolation record, the caller's pick,
 *  or repository-default detection. */
export type GitBranchBaseSource = "isolation" | "requested" | "default";

export interface GitBranchDiffInput {
  /** Managed isolation identity. Its target branch is the base when
   *  `refs/heads/<targetBranch>` resolves, otherwise its base commit. */
  isolation?: { targetBranch: string; baseCommit: string };
  /** Caller-picked comparison ref. Overrides the automatic isolation/default
   * base without changing the workspace or its isolation target. */
  base?: string;
  /** Return this one file's patch instead of the file list. It must be an
   *  entry of the branch changes; anything else is `not-found`. */
  path?: string;
  ignoreWhitespace?: boolean;
}

export interface GitBranchIdentity {
  /** Resolved base as displayed: a branch name, or a commit SHA. */
  base: string;
  baseSource: GitBranchBaseSource;
  mergeBase: string;
  head: string;
  /** Symbolic branch, or null while HEAD is detached. */
  headRef: string | null;
}

export interface GitBranchDiffList extends GitBranchIdentity {
  /** Commits reachable from HEAD but not from the base. */
  ahead: number;
  files: GitBranchFile[];
  truncated?: true;
  /** Entries found before the cap; present only with `truncated`. */
  totalFiles?: number;
}

export interface GitBranchFileDiff extends GitBranchIdentity {
  path: string;
  previousPath?: string;
  diff: string;
  binary?: true;
  symlink?: true;
  truncated?: true;
}

export type GitBranchDiff = GitBranchDiffList | GitBranchFileDiff;

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
}

/** Outcome of an ordinary merge. `ok: false` means Git stopped inside the
 *  working tree with conflict markers — the caller owns the next step. */
export type GitMergeOutcome =
  | { ok: true; alreadyUpToDate: boolean; fastForward: boolean; head: string }
  | { ok: false; conflicted: string[] };

/** Ceilings for a merge-conflict preview, each surfaced as `truncated`. */
export const MERGE_CONFLICT_MAX_FILES = 200;
export const MERGE_CONFLICT_MAX_REGIONS = 50;
export const MERGE_CONFLICT_MAX_LINES = 200;

/** Why a path does not merge. `content`: both sides edited the same lines.
 *  The others carry no line regions: one side no longer has the path
 *  (deleted, or renamed — the preview does not follow renames), both added
 *  it, or it is binary, too large, a link or a submodule. */
export type GitMergeConflictKind =
  | "content"
  | "added-by-both"
  | "deleted-in-target"
  | "deleted-in-source"
  | "binary"
  | "too-large"
  | "unsupported";

/** One overlapping edit, with up to three unchanged lines around it. */
export interface GitMergeConflictRegion {
  /** 1-based line in the source version where the region starts. */
  line: number;
  before: string[];
  target: string[];
  source: string[];
  after: string[];
  /** A side was longer than `MERGE_CONFLICT_MAX_LINES`. */
  truncated?: true;
}

export interface GitMergeConflictFile {
  path: string;
  kind: GitMergeConflictKind;
  regions: GitMergeConflictRegion[];
  /** More than `MERGE_CONFLICT_MAX_REGIONS` regions. */
  truncated?: true;
}

export interface GitMergeConflicts {
  target: string;
  source: string;
  mergeBase: string;
  files: GitMergeConflictFile[];
  /** More than `MERGE_CONFLICT_MAX_FILES` paths conflict. */
  truncated?: true;
}

export interface WorktreeService {
  list(root: string): Promise<Worktree[]>;
  create(root: string, input: { branch: string; path?: string; base?: string; newBranchOnly?: boolean }): Promise<{ path: string; branch: string }>;
  /** Git is the authority. First call is `git worktree remove` without
   *  `--force`. Dirty/untracked refusal becomes `worktree-dirty`. `--force`
   *  is used only when the caller passes `force` after explicit confirmation.
   *  Already-absent paths are a physical success. `ownedBranch` is a
   *  server-derived identity for branch cleanup when the worktree row is gone;
   *  it is never a client-supplied name. */
  remove(root: string, input: {
    path: string;
    deleteBranch?: boolean;
    force?: boolean;
    ownedBranch?: string;
  }): Promise<{ branchCleanupFailed?: boolean }>;
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
  /** Read-only review of everything in `root` against merge-base(HEAD, base):
   *  committed branch work, uncommitted tracked edits and untracked files.
   *  Without `input.path` it lists the changed files; with it, that one file's
   *  patch. Never writes the index, refs or objects, and never returns bytes
   *  from outside the worktree (symlinks and binary files are placeholders).
   *  Throws `invalid-input` (bad ref/path), `no-base`, `no-merge-base` or
   *  `not-found` (path is not one of the branch's changes). */
  branchDiff(root: string, input?: GitBranchDiffInput): Promise<GitBranchDiff>;
  stage(root: string, paths: string[]): Promise<void>;
  unstage(root: string, paths: string[]): Promise<void>;
  discard(root: string, paths: string[]): Promise<void>;
  commit(root: string, message: string): Promise<{ sha: string }>;
  branches(root: string): Promise<GitBranches>;
  createBranch(root: string, name: string, from?: string): Promise<void>;
  renameBranch(root: string, from: string, to: string): Promise<void>;
  checkout(root: string, name: string): Promise<void>;
  log(root: string, limit?: number): Promise<GitCommit[]>;
  /** History with parent SHAs and ref decorations, paginated for the graph view. */
  graph(root: string, opts?: { limit?: number; skip?: number }): Promise<GitGraphCommit[]>;
  stashList(root: string): Promise<GitStash[]>;
  stashPush(root: string, message?: string): Promise<{ created: boolean }>;
  stashApply(root: string, ref?: string): Promise<void>;
  stashDrop(root: string, ref?: string): Promise<void>;
  fetch(root: string, remote?: string): Promise<void>;
  pull(root: string, remote?: string, branch?: string): Promise<void>;
  /** Rebase local commits onto the selected remote branch without autostashing. */
  rebase(root: string, remote?: string): Promise<void>;
  push(root: string, remote?: string): Promise<void>;
  /** Push the checked-out branch to an explicit remote branch and track it. */
  pushBranch(root: string, input: { remote: string; branch: string }): Promise<void>;
  /** Rebase the checked-out branch onto an explicit local ref. */
  rebaseOnto?(root: string, newBase: string, oldBase?: string): Promise<void>;
  /** Push a branch with an explicit expected remote SHA; never force-pushes blindly. */
  pushForceWithLease?(root: string, input: { remote: string; branch: string; expectedRemoteSha: string; expectedLocalSha: string }): Promise<{ newSha: string }>;
  /** Fetch, integrate the selected remote branch when safe, then publish local commits. */
  sync(root: string, remote?: string): Promise<void>;
  identity(root: string): Promise<{ name: string; email: string }>;
  setIdentity(root: string, identity: { name: string; email: string }): Promise<void>;
  /** Resolve a ref to a 40-char SHA. */
  revParse(root: string, rev: string): Promise<string>;
  mergeBase(root: string, first: string, second: string): Promise<string>;
  /** Exact ref lookup. Null means proven absence; lookup/corruption errors throw. */
  readRef(root: string, ref: string): Promise<string | null>;
  /** Refs under `prefix` (e.g. `refs/polyth/isolation/`) whose tips are
   *  reachable from at least one local branch. */
  refsMergedIntoBranches(root: string, prefix: string): Promise<Array<{ ref: string; sha: string }>>;
  gitDir(root: string): Promise<string>;
  commonDir(root: string): Promise<string>;
  /** `git add -A` — tracked mods/deletes plus untracked files, honouring gitignore. */
  stageAll(root: string): Promise<void>;
  /** Which of `paths` Git ignores in `root`, in one `check-ignore --stdin`
   *  batch. Read-only; throws `git-failed` when Git itself fails, so an
   *  unreadable ignore state is never reported as "nothing ignored". */
  checkIgnored(root: string, paths: readonly string[]): Promise<string[]>;
  /** HEAD + dirty-tree fingerprint used to suppress repeated merge suggestions. */
  fingerprint(root: string): Promise<string>;
  /** HEAD-independent working-tree fingerprint for destructive repair fences. */
  workingFingerprint(root: string): Promise<string>;
  /** True when `root` has commits or a dirty tree not contained in `againstRef`. */
  hasUniqueChanges(root: string, againstRef: string): Promise<boolean>;
  workingTreeMatches(root: string, commit: string): Promise<boolean>;
  /** Snapshot HEAD plus the working tree without changing HEAD or the real index. */
  snapshotCommit(root: string, message: string, identity?: { name: string; email: string }): Promise<{ sha: string; created: boolean }>;
  mergeSquash(root: string, ref: string): Promise<{ ok: true } | { ok: false; conflicted: string[] }>;
  /** Ordinary `git merge --no-edit` of `ref` into whatever is checked out at
   *  `root`. Conflicts are reported, never thrown: the tree stays conflicted so
   *  the caller can resolve it or call `abortMerge`. Refusals that leave the
   *  tree untouched (dirty overlap, unborn HEAD) still throw. */
  merge(root: string, ref: string): Promise<GitMergeOutcome>;
  /** Preview merging commit `source` into commit `target` without merging:
   *  a three-way read in a throwaway index plus `git merge-file` per path.
   *  Never writes the index, refs, objects or the working tree. Throws
   *  `no-merge-base` when the two share no history. */
  mergeConflicts(root: string, input: { target: string; source: string }): Promise<GitMergeConflicts>;
  abortMerge(root: string): Promise<void>;
  commitWithIdentity(root: string, message: string, identity?: { name: string; email: string }): Promise<{ sha: string }>;
  /** Commit the current index as a child of HEAD without moving HEAD or running hooks/signing. */
  commitStagedTree(root: string, message: string, identity?: { name: string; email: string }): Promise<{ sha: string }>;
  mergeFfOnly(root: string, sha: string): Promise<void>;
  /** Compare-and-swap a ref. Returns false when `expectedOldSha` no longer matches. */
  updateRef(root: string, ref: string, newSha: string, expectedOldSha: string): Promise<boolean>;
  /** Atomically compare-and-swap a branch and record its publication receipt. */
  publishRef(root: string, input: { targetRef: string; expectedHead: string; newSha: string; receiptRef: string }): Promise<boolean>;
  /** Check or repair a published branch checkout while carrying compatible
   * staged, unstaged, and untracked work forward. Conflicting local work is
   * refused without being overwritten. */
  syncPublishedCheckout(root: string, input: {
    branch: string;
    expectedHead: string;
    resultCommit: string;
    /** Verify Git's two-tree carry-forward before publication without writing. */
    checkOnly?: boolean;
  }): Promise<void>;
  /**
   * Install a publication that already contains the caller's backed-up local
   * repair. The expected fingerprint is checked after the ref CAS, immediately
   * before replacing tracked files. This is intentionally separate from
   * syncPublishedCheckout: it is an explicit, recoverable overwrite boundary.
   */
  replacePublishedCheckout(root: string, input: {
    branch: string;
    expectedHead: string;
    resultCommit: string;
    expectedFingerprint: string;
  }): Promise<void>;
  /** `git merge-base --is-ancestor ancestor descendant`. */
  isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean>;
  /** Remove exactly the ref value inspected by its owner; never a replacement. */
  deleteRef(root: string, ref: string, expectedSha: string): Promise<boolean>;
  /** Delete a local branch. Returns false when the name does not exist. */
  deleteBranch(root: string, name: string): Promise<boolean>;
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
    problem?: string;
  },
  userPrompt: string,
): string {
  const instructions = userPrompt.trim();
  const conflicted = state.conflictedPaths.length > 0;
  const problem = state.problem?.trim();
  const lines = [
    conflicted || state.diverged
      ? "Resolve the git conflict in this repository's working tree."
      : "Diagnose and resolve the reported git problem in this repository's working tree.",
    "",
    "Repository state:",
    `- Branch: ${state.branch ?? "(detached HEAD)"}`,
    `- Local commits ahead of upstream: ${state.ahead}`,
    `- Upstream commits not yet integrated: ${state.behind}`,
  ];
  if (problem) lines.push(`- Reported failure: ${problem}`);
  if (conflicted) {
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
    instructions || (conflicted || state.diverged
      ? "Inspect and resolve every merge conflict in the working tree."
      : "Diagnose the reported failure and restore a healthy sync with the remote."),
    "",
    "Required steps:",
  );
  if (conflicted || state.diverged) {
    lines.push(
      "- If no merge or rebase is in progress yet, integrate the upstream branch first. This project keeps a linear history, so rebase the local commits onto the upstream branch (e.g. `git pull --rebase`) unless the user asked for a merge.",
      "- Resolve every conflict by understanding both sides; explain each non-obvious decision.",
      "- Remove all conflict markers and keep the code buildable.",
      "- Run the relevant tests or checks once the tree is clean.",
      "- Stage the resolved files and complete the rebase or merge locally.",
      "- Do NOT push or force-push without explicit user approval.",
    );
  } else {
    lines.push(
      "- Diagnose the reported failure from the repository state above.",
      "- Prefer `git fetch`, then a fast-forward pull (`git pull --ff-only`) when you are behind-only.",
      "- Push local commits when you are ahead-only and the remote accepts them.",
      "- Rebase onto upstream only when local and remote histories have diverged.",
      "- Do NOT force-push without explicit user approval.",
    );
  }
  return lines.join("\n");
}

export interface GitServiceOptions {
  /** Configurable git binary. */
  bin?: string;
  timeoutMs?: number;
}

const cloneError = (message: string) => Object.assign(new Error(message), { code: "git-failed" });

/** Accepted public repository forms are deliberately narrow: only GitHub and
 * GitLab clone URLs, with no credentials embedded in the URL. */
export function normalizeRepositoryUrl(value: string): string {
  const repository = value.trim();
  if (!repository || repository.length > 2_048 || /[\s\0\p{Cc}]/u.test(repository)) {
    throw Object.assign(new Error("repository must be a valid Git repository URL"), { code: "invalid-input" });
  }
  const scp = repository.match(/^git@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(.+)$/i);
  if (scp) {
    if (!validRepositoryPath(scp[2]!)) throw Object.assign(new Error("repository path is invalid"), { code: "invalid-input" });
    return repository;
  }
  let parsed: URL;
  try { parsed = new URL(repository); } catch {
    throw Object.assign(new Error("repository must be a valid Git repository URL"), { code: "invalid-input" });
  }
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ssh:")
    || !parsed.hostname
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.protocol !== "ssh:" && parsed.username)
    || !validRepositoryPath(parsed.pathname.slice(1))) {
    throw Object.assign(new Error("repository must be an HTTP(S)/SSH Git URL without credentials"), { code: "invalid-input" });
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
    const transport = gitTransportInvocation(["clone", "--", repository, target]);
    execFile(resolveGitBinary(), transport.args, {
      cwd: parentPath,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...transport.env },
    }, (error, stdout, stderr) => {
      if (!error) { resolvePromise(); return; }
      rmSync(target, { recursive: true, force: true });
      reject(cloneError((String(stderr) || String(stdout) || error.message).trim().split("\n")[0] || "git clone failed"));
    });
  });
  return { path: target, name };
}

interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit status when Git actually exited. */
  code: number;
  /** False when the process was killed, timed out, or never started. */
  exited: boolean;
}

const STATUS_LETTER: Record<string, GitFileStatus> = {
  A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "conflicted",
};

const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const SKIP_ERR_LINE = /^(?:To |From )|^remote:/i;
const PREFER_ERR_LINE = /^(?:fatal|error):|!\s*\[rejected\]|failed to push|not possible to fast-forward|Updates were rejected/i;

export const shortErr = (stderr: string): string => {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const informative = lines.find((line) => PREFER_ERR_LINE.test(line))
    ?? lines.find((line) => !SKIP_ERR_LINE.test(line))
    ?? lines[0]
    ?? "git command failed";
  let message = informative.replace(/^(fatal|error):\s*/i, "");
  if (message.length >= 200) message = `${message.slice(0, 197)}…`;
  return message;
};

const pushRejection = (failure: Error & { cause?: unknown }): boolean => {
  const text = `${failure.message} ${String(failure.cause ?? "")}`;
  return /!\s*\[rejected\]|non-fast-forward|Updates were rejected|fetch first|tip of your current branch is behind|its remote counterpart/i.test(text);
};

/** Git's refusal to publish because the remote moved. Shared by every push
 *  path so an isolation branch push reports the same actionable conflict. */
const rethrowPushFailure = (error: unknown): never => {
  const failure = error as Error & { cause?: unknown };
  if (pushRejection(failure)) {
    throw Object.assign(
      new Error("Push was rejected because the remote has commits you do not have locally. Pull or rebase first, then push again."),
      { code: "conflict" },
    );
  }
  throw error;
};

/** Git's own refusal for a dirty linked worktree. Status is never the gate. */
const isDirtyWorktreeRefusal = (stderr: string): boolean =>
  /use --force to delete/i.test(stderr);

/** Server-derived branch names only. Rejects empty, spaced, or dashed-option forms. */
const OWNED_BRANCH = /^[\w][\w./@+-]*$/;

const sanitizeBranchDir = (branch: string): string =>
  branch.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";

const SAFE_REV = /^[\w./~^{}@+-]{1,160}$/;
const assertRev = (rev: string, label = "ref"): string => {
  if (!SAFE_REV.test(rev) || rev.startsWith("-")) {
    throw Object.assign(new Error(`invalid ${label}`), { code: "invalid-input" });
  }
  return rev;
};

// ---- branch review helpers ---------------------------------------------------

/** `SAFE_REV` admits dots, so range syntax (`a..b`, `a...b`) is refused here. */
const assertBranchBase = (value: string): string => {
  assertRev(value, "base");
  if (value.includes("..")) throw Object.assign(new Error("invalid base"), { code: "invalid-input" });
  return value;
};

/** A local branch name fit for `refs/heads/<name>` (server-derived input). */
const isPlainBranchName = (value: unknown): value is string =>
  typeof value === "string" && OWNED_BRANCH.test(value) && !value.includes("..") && value.length <= 160;

const COMMIT_ID = /^[0-9a-f]{40,64}$/i;

/** 409: the request is fine, but this repository state has nothing to compare. */
const branchReviewError = (code: "no-base" | "no-merge-base", message: string): Error =>
  Object.assign(new Error(message), { code, status: 409 });

const outsideWorktree = (): Error =>
  Object.assign(new Error("path resolves outside the workspace"), { code: "invalid-input" });

const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isInside = (realRoot: string, candidate: string): boolean =>
  candidate === realRoot || candidate.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);

interface RawDiffEntry {
  letter: string;
  path: string;
  previousPath?: string;
  symlink: boolean;
}

/** `git diff --raw -z`: `:<mode> <mode> <sha> <sha> <status>` NUL path NUL [path NUL]. */
function parseRawDiff(output: string): RawDiffEntry[] {
  const tokens = output.split("\0");
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const meta = tokens[index];
    if (!meta || !meta.startsWith(":")) continue;
    const fields = meta.slice(1).split(" ");
    const letter = (fields[4] ?? "M")[0] ?? "M";
    const symlink = fields[0] === "120000" || fields[1] === "120000";
    const first = tokens[++index] ?? "";
    if (letter === "R" || letter === "C") {
      entries.push({ letter, path: tokens[++index] ?? "", previousPath: first, symlink });
    } else {
      entries.push({ letter, path: first, symlink });
    }
  }
  return entries.filter((entry) => entry.path !== "");
}

/** `git diff --numstat -z`: `adds TAB dels TAB path NUL`, or for renames
 *  `adds TAB dels TAB NUL old NUL new NUL`. Binary files report `-`/`-`. */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = output.split("\0");
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    let path = parts.slice(2).join("\t");
    if (path === "") {
      index += 1; // rename source
      path = tokens[++index] ?? "";
    }
    if (!path) continue;
    const binary = parts[0] === "-" || parts[1] === "-";
    counts.set(path, {
      additions: binary ? 0 : Number(parts[0]) || 0,
      deletions: binary ? 0 : Number(parts[1]) || 0,
      binary,
    });
  }
  return counts;
}

const BRANCH_STATUS: Record<string, GitBranchFileStatus> = { A: "added", D: "deleted", R: "renamed", C: "added" };

/** Cut at a line boundary so a capped patch never ends mid-line. */
function capPatch(text: string, force = false): { diff: string; truncated?: true } {
  if (text.length <= BRANCH_DIFF_MAX_PATCH_CHARS) return force ? { diff: text, truncated: true } : { diff: text };
  const cut = text.lastIndexOf("\n", BRANCH_DIFF_MAX_PATCH_CHARS);
  return { diff: text.slice(0, cut > 0 ? cut + 1 : BRANCH_DIFF_MAX_PATCH_CHARS), truncated: true };
}

/** git-format patch for a symbolic link: its link text, never the target's bytes. */
function symlinkPatch(path: string, linkText: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 120000",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+${linkText.slice(0, 4096)}`,
    "\\ No newline at end of file",
    "",
  ].join("\n");
}

interface GitRunOpts {
  allowFail?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
}

const parseWorktrees = (stdout: string): Worktree[] => {
  const out: Worktree[] = [];
  let cur: Partial<Worktree> | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "", isMain: out.length === 0 });
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5).trim();
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "").trim();
    else if (line === "detached" && cur) cur.branch = null;
  }
  if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "", isMain: out.length === 0 });
  return out;
};

type GitRunner = (root: string, args: string[], opts?: GitRunOpts) => Promise<RunResult>;

/**
 * Content-level three-way merge of `ours` and `theirs` over a common `base`,
 * resolved in a throwaway index and returned as a tree. Git's two-tree
 * `read-tree -m -u` carry-forward is path-level: a file edited on both sides is
 * refused even when the hunks do not overlap. This fills that gap for the only
 * case that is safe to auto-resolve — a text modify/modify with all three
 * stages. Adds, deletes, renames, mode changes, binary data and true content
 * overlaps return `null` so the caller can refuse without writing.
 */
const mergeTreeContents = async (
  run: GitRunner,
  root: string,
  base: string,
  ours: string,
  theirs: string,
  scratch: string,
  tag: string,
): Promise<string | null> => {
  const indexFile = join(scratch, `${tag}.index`);
  const env = { GIT_INDEX_FILE: indexFile };
  const read = await run(root, ["read-tree", "-m", base, ours, theirs], { allowFail: true, env });
  if (!read.exited || read.code !== 0) return null;
  const listed = await run(root, ["ls-files", "-u", "--stage"], { allowFail: true, env });
  if (!listed.exited || listed.code !== 0) return null;
  const stages = new Map<string, { baseMode?: string; oursMode?: string; theirsMode?: string; base?: string; ours?: string; theirs?: string }>();
  for (const line of listed.stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, sha, stage] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    const entry = stages.get(path) ?? {};
    if (stage === "1") { entry.base = sha; entry.baseMode = mode; }
    else if (stage === "2") { entry.ours = sha; entry.oursMode = mode; }
    else if (stage === "3") { entry.theirs = sha; entry.theirsMode = mode; }
    stages.set(path, entry);
  }
  const updates: string[] = [];
  for (const [path, entry] of stages) {
    const baseSha = entry.base;
    const oursSha = entry.ours;
    const theirsSha = entry.theirs;
    // Only plain text modify/modify: adds, deletes, renames, mode changes and
    // binary data stay overlapping work the caller must refuse.
    if (!baseSha || !oursSha || !theirsSha) return null;
    if (entry.baseMode !== "100644" || entry.oursMode !== entry.baseMode || entry.theirsMode !== entry.baseMode) return null;
    const mode = entry.baseMode;
    const baseText = (await run(root, ["cat-file", "blob", baseSha])).stdout;
    const oursText = (await run(root, ["cat-file", "blob", oursSha])).stdout;
    const theirsText = (await run(root, ["cat-file", "blob", theirsSha])).stdout;
    if (baseText.includes("\0") || oursText.includes("\0") || theirsText.includes("\0")) return null;
    const baseFile = join(scratch, `${tag}.base`);
    const oursFile = join(scratch, `${tag}.ours`);
    const theirsFile = join(scratch, `${tag}.theirs`);
    await writeFile(baseFile, baseText, "utf8");
    await writeFile(oursFile, oursText, "utf8");
    await writeFile(theirsFile, theirsText, "utf8");
    const merged = await run(root, ["merge-file", "-q", "-p", oursFile, baseFile, theirsFile], { allowFail: true });
    if (!merged.exited || merged.code !== 0) return null;
    const hashed = await run(root, ["hash-object", "-w", "--stdin"], { allowFail: true, input: merged.stdout });
    if (!hashed.exited || hashed.code !== 0) return null;
    updates.push(`${mode} ${hashed.stdout.trim()}\t${path}`);
  }
  if (updates.length > 0) {
    const updated = await run(root, ["update-index", "--index-info"], { allowFail: true, env, input: `${updates.join("\n")}\n` });
    if (!updated.exited || updated.code !== 0) return null;
  }
  const tree = await run(root, ["write-tree"], { allowFail: true, env });
  if (!tree.exited || tree.code !== 0) return null;
  return tree.stdout.trim();
};

/** Long enough that a file's own text practically never looks like a marker. */
const CONFLICT_MARKER_SIZE = 32;
const CONFLICT_CONTEXT_LINES = 3;
const CONFLICT_MAX_LINE_CHARS = 1000;
const CONFLICT_MAX_BLOB_BYTES = 2 * 1024 * 1024;

const conflictLine = (line: string): string => {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  return text.length > CONFLICT_MAX_LINE_CHARS ? `${text.slice(0, CONFLICT_MAX_LINE_CHARS)}…` : text;
};

/** The conflicting regions of `git merge-file -p` output written with
 *  `markerSize` markers (target side first, an optional diff3 base section,
 *  then the source side). Lines outside markers are common to both. */
export function parseConflictRegions(
  merged: string,
  markerSize = CONFLICT_MARKER_SIZE,
): { regions: GitMergeConflictRegion[]; truncated?: true } {
  const marker = (char: string) => char.repeat(markerSize);
  const isMarker = (line: string, char: string) => line === marker(char) || line.startsWith(`${marker(char)} `);
  const lines = merged.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const regions: GitMergeConflictRegion[] = [];
  let recent: string[] = [];
  let current: GitMergeConflictRegion | null = null;
  let side: "target" | "base" | "source" | null = null;
  let closed: GitMergeConflictRegion | null = null;
  let sourceLine = 1;
  let truncated = false;
  const keep = (region: GitMergeConflictRegion, into: string[], line: string) => {
    if (into.length < MERGE_CONFLICT_MAX_LINES) into.push(conflictLine(line));
    else region.truncated = true;
  };
  for (const line of lines) {
    if (side === null && isMarker(line, "<")) {
      if (regions.length >= MERGE_CONFLICT_MAX_REGIONS) { truncated = true; break; }
      current = { line: sourceLine, before: recent.map(conflictLine), target: [], source: [], after: [] };
      recent = [];
      closed = null;
      side = "target";
    } else if (current && side !== null && side !== "source" && isMarker(line, "|")) {
      side = "base";
    } else if (current && side !== null && side !== "source" && line === marker("=")) {
      side = "source";
    } else if (current && side === "source" && isMarker(line, ">")) {
      regions.push(current);
      closed = current;
      current = null;
      side = null;
    } else if (current && side === "target") {
      keep(current, current.target, line);
    } else if (current && side === "source") {
      keep(current, current.source, line);
      sourceLine += 1;
    } else if (side === null) {
      recent.push(line);
      if (recent.length > CONFLICT_CONTEXT_LINES) recent.shift();
      if (closed && closed.after.length < CONFLICT_CONTEXT_LINES) closed.after.push(conflictLine(line));
      sourceLine += 1;
    }
  }
  return truncated ? { regions, truncated: true } : { regions };
}

type ConflictStage = { mode: string; sha: string };

/** See `GitService.mergeConflicts`. `read-tree -m` leaves every path both
 *  sides changed as unmerged stages; `merge-file` then decides which of those
 *  really overlap. The index is a private file in `scratch`. */
const mergeConflictPreview = async (
  run: GitRunner,
  root: string,
  input: { target: string; source: string },
): Promise<GitMergeConflicts> => {
  const target = assertRev(input.target, "target");
  const source = assertRev(input.source, "source");
  const found = await run(root, ["merge-base", target, source], { allowFail: true });
  if (!found.exited) throw Object.assign(new Error("git did not finish"), { code: "git-failed" });
  if (found.code === 1) throw branchReviewError("no-merge-base", "The two branches share no common history.");
  const mergeBase = found.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (found.code !== 0 || !COMMIT_ID.test(mergeBase)) {
    throw Object.assign(new Error(shortErr(found.stderr)), { cause: found.stderr, code: "git-failed" });
  }
  const scratch = await mkdtemp(join(tmpdir(), "polyth-git-conflicts-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    const read = await run(root, ["read-tree", "-m", mergeBase, target, source], { allowFail: true, env });
    if (!read.exited || read.code !== 0) {
      throw Object.assign(new Error(shortErr(read.stderr || "read-tree failed")), { cause: read.stderr, code: "git-failed" });
    }
    const listed = await run(root, ["ls-files", "-u", "-z"], { allowFail: true, env });
    if (!listed.exited || listed.code !== 0) {
      throw Object.assign(new Error(shortErr(listed.stderr || "ls-files failed")), { cause: listed.stderr, code: "git-failed" });
    }
    const stages = new Map<string, { base?: ConflictStage; target?: ConflictStage; source?: ConflictStage }>();
    for (const record of listed.stdout.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, sha, stage] = record.slice(0, tab).split(" ");
      if (!mode || !sha || !stage) continue;
      const path = record.slice(tab + 1);
      const entry = stages.get(path) ?? {};
      if (stage === "1") entry.base = { mode, sha };
      else if (stage === "2") entry.target = { mode, sha };
      else if (stage === "3") entry.source = { mode, sha };
      stages.set(path, entry);
    }
    const paths = [...stages.keys()].sort(comparePaths);
    const kept = paths.slice(0, MERGE_CONFLICT_MAX_FILES);
    const shas = [...new Set(kept.flatMap((path) => {
      const entry = stages.get(path)!;
      return [entry.base?.sha, entry.target?.sha, entry.source?.sha].filter((sha): sha is string => !!sha);
    }))];
    const sizes = new Map<string, number>();
    if (shas.length) {
      const checked = await run(root, ["cat-file", "--batch-check"], { allowFail: true, input: `${shas.join("\n")}\n` });
      for (const line of checked.stdout.split("\n")) {
        const [sha, type, size] = line.split(" ");
        if (sha && type === "blob") sizes.set(sha, Number(size));
      }
    }
    const regular = (stage: ConflictStage | undefined) => !stage || stage.mode === "100644" || stage.mode === "100755";
    const blob = async (stage: ConflictStage | undefined): Promise<string> =>
      stage ? (await run(root, ["cat-file", "blob", stage.sha])).stdout : "";
    const files: GitMergeConflictFile[] = [];
    for (const [index, path] of kept.entries()) {
      const entry = stages.get(path)!;
      const sides = [entry.base, entry.target, entry.source];
      if (!entry.target) { files.push({ path, kind: "deleted-in-target", regions: [] }); continue; }
      if (!entry.source) { files.push({ path, kind: "deleted-in-source", regions: [] }); continue; }
      if (!sides.every(regular)) { files.push({ path, kind: "unsupported", regions: [] }); continue; }
      if (sides.some((stage) => stage && (sizes.get(stage.sha) ?? Infinity) > CONFLICT_MAX_BLOB_BYTES)) {
        files.push({ path, kind: "too-large", regions: [] });
        continue;
      }
      const [baseText, targetText, sourceText] = await Promise.all([blob(entry.base), blob(entry.target), blob(entry.source)]);
      if ([baseText, targetText, sourceText].some((text) => text.includes("\0"))) {
        files.push({ path, kind: "binary", regions: [] });
        continue;
      }
      const baseFile = join(scratch, `${index}.base`);
      const targetFile = join(scratch, `${index}.target`);
      const sourceFile = join(scratch, `${index}.source`);
      await Promise.all([
        writeFile(baseFile, baseText, "utf8"),
        writeFile(targetFile, targetText, "utf8"),
        writeFile(sourceFile, sourceText, "utf8"),
      ]);
      const merged = await run(root, [
        "merge-file", "-p", `--marker-size=${CONFLICT_MARKER_SIZE}`,
        "-L", "target", "-L", "base", "-L", "source",
        targetFile, baseFile, sourceFile,
      ], { allowFail: true });
      // The exit status is the number of conflicts; 0 merged cleanly, and a
      // negative status (255) is merge-file's own failure.
      if (!merged.exited || merged.code < 0 || merged.code > 127) {
        files.push({ path, kind: "unsupported", regions: [] });
        continue;
      }
      if (merged.code === 0) continue;
      files.push({ path, kind: entry.base ? "content" : "added-by-both", ...parseConflictRegions(merged.stdout) });
    }
    return {
      target,
      source,
      mergeBase,
      files,
      ...(paths.length > kept.length ? { truncated: true as const } : {}),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const bin = opts.bin ?? resolveGitBinary();
  const timeout = opts.timeoutMs ?? 30_000;

  const run = (root: string, args: string[], allowFailOrOpts: boolean | GitRunOpts = false): Promise<RunResult> =>
    new Promise((res, rej) => {
      const opts: GitRunOpts = typeof allowFailOrOpts === "boolean"
        ? { allowFail: allowFailOrOpts }
        : allowFailOrOpts;
      // A project's source-control account (if one is bound for this call)
      // authenticates transport commands only; see sourceControlAccounts.ts.
      const transport = gitTransportInvocation(args);
      const child = execFile(bin, transport.args, {
        cwd: root,
        timeout: opts.timeoutMs ?? timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...(opts.env ?? {}), ...transport.env },
      }, (err, stdout, stderr) => {
        const execErr = err as (Error & {
          code?: number | string;
          killed?: boolean;
        }) | null;
        const raw = execErr?.code;
        const exited = !execErr || (typeof raw === "number" && !execErr.killed);
        const code = typeof raw === "number" ? raw : execErr ? 1 : 0;
        if (err && !opts.allowFail) {
          rej(Object.assign(new Error(shortErr(String(stderr || err.message))), { cause: stderr, code: "git-failed" }));
          return;
        }
        res({ stdout: String(stdout), stderr: String(stderr), code, exited });
      });
      if (opts.input !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(opts.input);
      }
    });

  const hashDirtyTree = async (root: string): Promise<string> => {
    const porcelain = (await run(root, ["status", "--porcelain=v1", "-unormal", "-z"], true)).stdout;
    const trackedDirty = (await run(root, ["diff", "HEAD", "--name-only", "-z"], true)).stdout;
    const untrackedList = (await run(root, ["ls-files", "--others", "--exclude-standard", "-z"], true)).stdout;
    const paths = [...new Set([...trackedDirty.split("\0"), ...untrackedList.split("\0")].filter(Boolean))];
    const hash = createHash("sha256");
    hash.update(porcelain);
    const regular: string[] = [];
    for (const path of paths) {
      let stat;
      try { stat = await lstat(join(root, path)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
        hash.update(JSON.stringify([path, "missing"]));
        continue;
      }
      hash.update(JSON.stringify([path, stat.mode]));
      if (stat.isSymbolicLink()) hash.update(await readlink(join(root, path)));
      else if (stat.isFile()) regular.push(path);
      else throw Object.assign(new Error("unsupported resource in isolated workspace"), { code: "conflict" });
    }
    for (let offset = 0; offset < regular.length; offset += 128) {
      hash.update((await run(root, ["hash-object", "--", ...regular.slice(offset, offset + 128)])).stdout);
    }
    return hash.digest("hex").slice(0, 16);
  };

  const listWorktrees = async (root: string): Promise<{ ok: boolean; trees: Worktree[] }> => {
    const listed = await run(root, ["worktree", "list", "--porcelain"], true);
    if (listed.code !== 0) return { ok: false, trees: [] };
    return { ok: true, trees: parseWorktrees(listed.stdout) };
  };

  const deleteOwnedBranch = async (root: string, branch: string): Promise<boolean> => {
    const deleted = await run(root, ["branch", "-D", branch], true);
    if (deleted.exited && deleted.code === 0) return true;
    const still = await run(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true);
    // git-show-ref: 0 = ref exists, 1 = requested ref is absent. Timeouts,
    // spawn failures, and fatal 128 are not proof of absence.
    return still.exited && still.code === 1;
  };

  const configValue = async (root: string, key: string): Promise<string> =>
    (await run(root, ["config", "--local", "--get", key], true)).stdout.trim();

  const retargetUpstream = async (root: string, remote: string, branch: string): Promise<void> => {
    const upstream = await run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true);
    const upstreamRemote = upstream.code === 0 ? upstream.stdout.trim().split("/")[0] : "";
    if (upstreamRemote !== remote) {
      await run(root, ["branch", "--set-upstream-to", `${remote}/${branch}`]);
    }
  };

  const commitTree = async (
    root: string,
    tree: string,
    parent: string,
    message: string,
    identity?: { name: string; email: string },
  ): Promise<string> => {
    // Explicit identity, else the acting person's (withGitCommitIdentity),
    // else the checkout's own configuration.
    const acting = identity ?? currentGitCommitIdentity();
    const name = acting?.name.trim() || (await service.identity(root)).name || "Polyth";
    const email = acting?.email.trim() || (await service.identity(root)).email || "polyth@localhost";
    const result = await run(root, [
      "-c", `user.name=${name}`,
      "-c", `user.email=${email}`,
      "commit-tree", tree, "-p", parent, "-F", "-",
    ], { input: `${message.trim()}\n` });
    return result.stdout.trim();
  };

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

  // ---- branch review (read-only) ----------------------------------------------
  // Every command here only reads: `--no-optional-locks` (and the GIT_OPTIONAL_LOCKS
  // default in `run`) stop `git diff` from opportunistically refreshing the index
  // while an agent is committing in the same worktree.
  const readGit = (root: string, args: string[], allowFail = false): Promise<RunResult> =>
    run(root, ["--no-optional-locks", ...args], allowFail);

  const commitOf = async (root: string, rev: string): Promise<string | null> => {
    const result = await readGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], true);
    const sha = result.stdout.trim();
    return result.exited && result.code === 0 && COMMIT_ID.test(sha) ? sha.toLowerCase() : null;
  };

  const resolveBranchBase = async (
    root: string,
    input: GitBranchDiffInput,
  ): Promise<{ name: string; commit: string; source: GitBranchBaseSource }> => {
    if (input.base !== undefined && input.base !== "") {
      const name = assertBranchBase(input.base);
      const commit = await commitOf(root, name);
      if (!commit) throw Object.assign(new Error(`unknown base: ${name}`), { code: "invalid-input" });
      return { name, commit, source: "requested" };
    }
    const isolation = input.isolation;
    if (isolation) {
      if (isPlainBranchName(isolation.targetBranch)) {
        const commit = await commitOf(root, `refs/heads/${isolation.targetBranch}`);
        if (commit) return { name: isolation.targetBranch, commit, source: "isolation" };
      }
      if (typeof isolation.baseCommit === "string" && COMMIT_ID.test(isolation.baseCommit)) {
        const commit = await commitOf(root, isolation.baseCommit);
        if (commit) return { name: commit, commit, source: "isolation" };
      }
    }
    const candidates: Array<{ ref: string; name: string }> = [];
    const origin = await readGit(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], true);
    const target = origin.exited && origin.code === 0 ? origin.stdout.trim() : "";
    if (/^refs\/remotes\/[\w.-]+\/\w[\w./@+-]*$/.test(target) && !target.includes("..")) {
      candidates.push({ ref: target, name: target.slice("refs/remotes/".length) });
    }
    candidates.push({ ref: "refs/heads/main", name: "main" }, { ref: "refs/heads/master", name: "master" });
    for (const candidate of candidates) {
      const commit = await commitOf(root, candidate.ref);
      if (commit) return { name: candidate.name, commit, source: "default" };
    }
    throw branchReviewError("no-base", "No base branch was found. Choose a branch to compare against.");
  };

  /** Every tracked change in the worktree against `mergeBase`, committed or not. */
  const trackedBranchChanges = async (root: string, mergeBase: string, ignoreWhitespace: boolean): Promise<GitBranchFile[]> => {
    const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", ...(ignoreWhitespace ? ["-w"] : [])];
    const raw = await readGit(root, ["diff", ...flags, "--raw", "-z", mergeBase]);
    const numstat = await readGit(root, ["diff", ...flags, "--numstat", "-z", mergeBase]);
    const counts = parseNumstat(numstat.stdout);
    const byPath = new Map<string, GitBranchFile>();
    for (const entry of parseRawDiff(raw.stdout)) {
      // An unmerged path can be reported twice; the resolved row wins.
      if (entry.letter === "U" && byPath.has(entry.path)) continue;
      const count = counts.get(entry.path);
      byPath.set(entry.path, {
        path: entry.path,
        ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
        status: BRANCH_STATUS[entry.letter] ?? "modified",
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
        ...(count?.binary ? { binary: true as const } : {}),
        ...(entry.symlink ? { symlink: true as const } : {}),
      });
    }
    return [...byPath.values()];
  };

  const untrackedBranchPaths = async (root: string): Promise<string[]> => {
    const listed = await readGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    // A trailing slash is a nested repository, which is not this repository's content.
    return listed.stdout.split("\0").filter((path) => path !== "" && !path.endsWith("/"));
  };

  /** The worktree path's parent resolves inside `realRoot` (or no longer exists). */
  const parentInsideRoot = async (realRoot: string, absolute: string): Promise<boolean> => {
    try {
      return isInside(realRoot, await realpath(dirname(absolute)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
  };

  /** A link that resolves outside the worktree. A dangling link has nothing to read. */
  const symlinkEscapes = async (realRoot: string, absolute: string): Promise<boolean> => {
    try {
      if (!(await lstat(absolute)).isSymbolicLink()) return false;
      return !isInside(realRoot, await realpath(absolute));
    } catch {
      return false;
    }
  };

  /** A no-index diff follows parent directories. Pin every directory component
   * with O_NOFOLLOW, then give Git a kernel cwd and a single leaf name. A
   * concurrent rename cannot redirect that cwd to another workspace. */
  const readUntrackedGit = async (realRoot: string, path: string, args: string[]): Promise<RunResult> => {
    if (process.platform !== "linux") {
      throw Object.assign(new Error("Untracked branch review is unavailable on this host"), { code: "unsupported" });
    }
    const parts = path.split("/");
    if (parts.length > 64 || parts.some((part) => !part || part === "." || part === "..")) throw outsideWorktree();
    const handles: FileHandle[] = [];
    const flags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW;
    const fdPath = (handle: FileHandle) => `/proc/${process.pid}/fd/${handle.fd}`;
    try {
      const anchor = await open(realRoot, flags);
      handles.push(anchor);
      if (await realpath(fdPath(anchor)) !== realRoot) throw outsideWorktree();
      let parent = anchor;
      for (const component of parts.slice(0, -1)) {
        parent = await open(join(fdPath(parent), component), flags);
        handles.push(parent);
      }
      const cwd = fdPath(parent);
      const leaf = parts.at(-1)!;
      if (!(await lstat(join(cwd, leaf))).isFile()) throw outsideWorktree();
      const result = await readGit(cwd, [...args, leaf], true);
      if (!result.exited || (result.code !== 0 && result.code !== 1)) {
        throw Object.assign(new Error("Untracked branch review failed"), { code: "git-failed" });
      }
      return result;
    } catch (error) {
      if (["unsupported", "git-failed"].includes((error as { code?: string }).code ?? "")) throw error;
      throw outsideWorktree();
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    }
  };

  /** Keep kernel fd paths and the temporary cwd out of the returned patch. */
  const originalUntrackedPath = (patch: { diff: string; truncated?: true }, path: string): typeof patch => {
    const label = (prefix: string): string => {
      const value = `${prefix}${path}`;
      return /[\s"\\\x00-\x1f\x7f]/.test(value) ? JSON.stringify(value) : value;
    };
    let header = true;
    const diff = patch.diff.split("\n").map((line) => {
      if (!header) return line;
      if (line.startsWith("@@ ")) { header = false; return line; }
      if (line.startsWith("diff --git ")) return `diff --git ${label("a/")} ${label("b/")}`;
      if (line.startsWith("+++ ")) return `+++ ${label("b/")}`;
      return line;
    }).join("\n");
    return { ...patch, diff };
  };

  const untrackedBranchEntry = async (root: string, realRoot: string, path: string): Promise<GitBranchFile | null> => {
    const absolute = join(root, path);
    let stat;
    try { stat = await lstat(absolute); } catch { return null; }
    if (!(await parentInsideRoot(realRoot, absolute))) return null;
    if (stat.isSymbolicLink()) {
      return { path, status: "untracked", additions: 1, deletions: 0, symlink: true };
    }
    // Sockets, FIFOs and devices are not reviewable content (and must never be opened).
    if (!stat.isFile()) return null;
    const counted = await readUntrackedGit(realRoot, path, ["diff", "--no-color", "--no-index", "--numstat", "--no-ext-diff", "--no-textconv", "--", "/dev/null"]);
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(counted.stdout);
    const binary = match?.[1] === "-";
    return {
      path,
      status: "untracked",
      additions: binary ? 0 : Number(match?.[1]) || 0,
      deletions: 0,
      ...(binary ? { binary: true as const } : {}),
    };
  };

  const mapLimit = async <T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> => {
    const results = new Array<R>(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index]!);
      }
    }));
    return results;
  };

  const patchOf = (result: RunResult): { diff: string; truncated?: true } => {
    // A patch that overflowed the run buffer was killed mid-stream: keep what arrived.
    if (!result.exited && !result.stdout) throw Object.assign(new Error("git did not finish"), { code: "git-failed" });
    return capPatch(result.stdout, !result.exited);
  };

  const trackedBranchPatch = async (
    root: string,
    realRoot: string,
    mergeBase: string,
    file: GitBranchFile,
    ignoreWhitespace: boolean,
  ): Promise<Omit<GitBranchFileDiff, keyof GitBranchIdentity>> => {
    const meta = {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      ...(file.symlink ? { symlink: true as const } : {}),
    };
    if (file.binary) return { ...meta, diff: "", binary: true };
    const absolute = join(root, file.path);
    if (!(await parentInsideRoot(realRoot, absolute)) || await symlinkEscapes(realRoot, absolute)) throw outsideWorktree();
    const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", ...(ignoreWhitespace ? ["-w"] : [])];
    const pathspec = file.previousPath ? [file.previousPath, file.path] : [file.path];
    const result = await readGit(root, ["--literal-pathspecs", "diff", ...flags, mergeBase, "--", ...pathspec], true);
    if (/^Binary files .* differ$/m.test(result.stdout)) return { ...meta, diff: "", binary: true };
    return { ...meta, ...patchOf(result) };
  };

  const untrackedBranchPatch = async (
    root: string,
    realRoot: string,
    path: string,
  ): Promise<Omit<GitBranchFileDiff, keyof GitBranchIdentity>> => {
    const absolute = join(root, path);
    if (!(await parentInsideRoot(realRoot, absolute))) throw outsideWorktree();
    let stat;
    try { stat = await lstat(absolute); } catch {
      throw Object.assign(new Error("file no longer exists"), { code: "not-found" });
    }
    if (stat.isSymbolicLink()) {
      if (await symlinkEscapes(realRoot, absolute)) throw outsideWorktree();
      return { path, symlink: true, diff: symlinkPatch(path, await readlink(absolute)) };
    }
    if (!stat.isFile()) throw Object.assign(new Error("path is not a regular file"), { code: "not-found" });
    const result = await readUntrackedGit(realRoot, path, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null"]);
    if (/^Binary files .* differ$/m.test(result.stdout)) return { path, diff: "", binary: true };
    return { path, ...originalUntrackedPath(patchOf(result), path) };
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

    async branchDiff(root, input = {}) {
      const ignoreWhitespace = input.ignoreWhitespace === true;
      if (input.path !== undefined && (input.path === "" || input.path.includes("\0"))) {
        throw Object.assign(new Error("invalid path"), { code: "invalid-input" });
      }
      const head = await commitOf(root, "HEAD");
      if (!head) {
        throw branchReviewError("no-merge-base", "This repository has no commits yet, so there is nothing to compare.");
      }
      const symbolic = await readGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const headRef = symbolic.exited && symbolic.code === 0 && symbolic.stdout.trim() ? symbolic.stdout.trim() : null;
      const base = await resolveBranchBase(root, input);
      const found = await readGit(root, ["merge-base", base.commit, head], true);
      // git-merge-base: 1 = no common ancestor; anything else non-zero is a failure.
      if (!found.exited) throw Object.assign(new Error("git did not finish"), { code: "git-failed" });
      if (found.code === 1) {
        throw branchReviewError("no-merge-base", `${headRef ?? "HEAD"} and ${base.name} share no common history.`);
      }
      const mergeBase = found.stdout.trim().split("\n")[0]?.trim() ?? "";
      if (found.code !== 0 || !COMMIT_ID.test(mergeBase)) {
        throw Object.assign(new Error(shortErr(found.stderr)), { cause: found.stderr, code: "git-failed" });
      }
      const identity: GitBranchIdentity = { base: base.name, baseSource: base.source, mergeBase, head, headRef };
      const realRoot = await realpath(root);
      const tracked = await trackedBranchChanges(root, mergeBase, ignoreWhitespace);

      if (input.path !== undefined) {
        // The path must be an entry of the branch changes; membership, not a
        // pathspec, is what bounds what can be read.
        const file = tracked.find((candidate) => candidate.path === input.path);
        if (file) return { ...identity, ...(await trackedBranchPatch(root, realRoot, mergeBase, file, ignoreWhitespace)) };
        if ((await untrackedBranchPaths(root)).includes(input.path)) {
          return { ...identity, ...(await untrackedBranchPatch(root, realRoot, input.path)) };
        }
        throw Object.assign(new Error("path is not part of the branch changes"), { code: "not-found" });
      }

      const trackedPaths = new Set(tracked.map((file) => file.path));
      const others = (await untrackedBranchPaths(root)).filter((path) => !trackedPaths.has(path));
      const total = tracked.length + others.length;
      const capped = total > BRANCH_DIFF_MAX_FILES;
      const keep = capped
        ? new Set([...tracked.map((file) => file.path), ...others].sort(comparePaths).slice(0, BRANCH_DIFF_MAX_FILES))
        : null;
      const keptTracked = keep ? tracked.filter((file) => keep.has(file.path)) : tracked;
      const keptOthers = keep ? others.filter((path) => keep.has(path)) : others;
      const untrackedFiles = (await mapLimit(keptOthers, 8, (path) => untrackedBranchEntry(root, realRoot, path)))
        .filter((file): file is GitBranchFile => file !== null);
      const aheadCount = await readGit(root, ["rev-list", "--count", `${base.commit}..${head}`], true);
      return {
        ...identity,
        ahead: Number(aheadCount.stdout.trim()) || 0,
        files: [...keptTracked, ...untrackedFiles].sort((a, b) => comparePaths(a.path, b.path)),
        ...(capped ? { truncated: true as const, totalFiles: total } : {}),
      };
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

    async renameBranch(root, from, to) {
      await run(root, ["branch", "-m", from, to]);
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

    async pull(root, remote = "origin", branch?: string) {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      if (branch !== undefined) assertRev(branch, "branch");
      const branchRef = await run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const targetBranch = branch ?? (branchRef.code === 0 ? branchRef.stdout.trim() : "");
      const args = ["pull", "--ff-only", remote];
      if (targetBranch) args.push(targetBranch);
      try {
        await run(root, args);
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
      if (targetBranch) await retargetUpstream(root, remote, targetBranch);
    },

    async rebase(root, remote = "origin") {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      const branchRef = await run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const branch = branchRef.code === 0 ? branchRef.stdout.trim() : "";
      // Do not hide uncommitted work in an implicit stash. A failed rebase
      // leaves Git's conflict state available for the user or an agent.
      const args = ["pull", "--rebase", "--no-autostash", remote];
      if (branch) args.push(branch);
      await run(root, args);
      if (branch) await retargetUpstream(root, remote, branch);
    },

    async rebaseOnto(root, newBase, oldBase) {
      assertRev(newBase, "rebase ref");
      if (oldBase) assertRev(oldBase, "old rebase ref");
      await run(root, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "rebase", "--no-autostash", ...(oldBase ? ["--onto", newBase, oldBase] : [newBase])]);
    },

    async pushForceWithLease(root, input) {
      if (!/^[\w.-]{1,120}$/.test(input.remote) || !/^[A-Za-z0-9._/-]{1,200}$/.test(input.branch)) throw Object.assign(new Error("invalid push ref"), { code: "invalid-input" });
      assertRev(input.expectedRemoteSha, "expected remote SHA");
      assertRev(input.expectedLocalSha, "expected local SHA");
      if (await service.revParse(root, input.branch) !== input.expectedLocalSha) throw Object.assign(new Error("local branch changed since preview"), { code: "conflict" });
      await run(root, ["push", `--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteSha}`, input.remote, `${input.expectedLocalSha}:refs/heads/${input.branch}`]);
      return { newSha: input.expectedLocalSha };
    },

    async push(root, remote = "origin") {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      // On a normal branch with no tracking ref yet, `git push` aborts with
      // "has no upstream branch". Publish the branch and set upstream so the
      // first push (and every sync after) just works.
      const branchRef = await run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const branch = branchRef.code === 0 ? branchRef.stdout.trim() : "";
      if (branch) {
        const upstream = await run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true);
        const upstreamRemote = upstream.code === 0 ? upstream.stdout.trim().split("/")[0] : "";
        if (!upstreamRemote || upstreamRemote !== remote) {
          try {
            await run(root, ["push", "--set-upstream", remote, branch]);
          } catch (error) {
            rethrowPushFailure(error);
          }
          return;
        }
      }
      try {
        await run(root, ["push", remote]);
      } catch (error) {
        rethrowPushFailure(error);
      }
    },

    /** Publish the checked-out branch under `branch` on `remote` and track it.
     *  Used by isolated workspaces, whose managed branch name is not a useful
     *  remote identity. The caller validates ownership before this runs. */
    async pushBranch(root, input) {
      const remote = input.remote.trim();
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      const raw = input.branch.trim();
      if (!raw || (raw.includes("refs/") && !raw.startsWith("refs/heads/"))) {
        throw Object.assign(new Error("invalid branch name"), { code: "invalid-input" });
      }
      const name = raw.replace(/^refs\/heads\//, "");
      const components = name.split("/");
      if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(name)
        || name === "HEAD" || name.endsWith(".")
        || name.includes("..") || name.includes("@{") || name.includes("//")
        || components.some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
        throw Object.assign(new Error("invalid branch name"), { code: "invalid-input" });
      }
      const current = await run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const local = current.code === 0 ? current.stdout.trim() : "";
      if (!local) throw Object.assign(new Error("cannot push from a detached HEAD"), { code: "conflict" });
      try {
        await run(root, ["push", "--set-upstream", remote, `${local}:refs/heads/${name}`]);
      } catch (error) {
        rethrowPushFailure(error);
      }
    },

    async sync(root, remote = "origin") {
      if (!/^[\w.-]{1,120}$/.test(remote)) throw Object.assign(new Error("invalid remote"), { code: "invalid-input" });
      await service.fetch(root, remote);
      const branchRef = await run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
      const branch = branchRef.code === 0 ? branchRef.stdout.trim() : "";
      if (!branch) {
        await service.push(root, remote);
        return;
      }

      // Compare against the selected remote's branch, not an unrelated
      // configured upstream. This keeps choosing `personal` or `work` honest.
      const remoteBranch = `${remote}/${branch}`;
      const remoteCommit = await run(root, ["rev-parse", "--verify", `${remoteBranch}^{commit}`], true);
      if (remoteCommit.code !== 0) {
        await service.push(root, remote);
        return;
      }
      const counts = await run(root, ["rev-list", "--left-right", "--count", `HEAD...${remoteBranch}`], true);
      if (counts.code !== 0) throw Object.assign(new Error("Unable to compare the selected Git remote."), { code: "git-failed" });
      const [aheadText, behindText] = counts.stdout.trim().split(/\s+/);
      const ahead = Number(aheadText ?? 0);
      const behind = Number(behindText ?? 0);
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
        throw Object.assign(new Error("Unable to compare the selected Git remote."), { code: "git-failed" });
      }
      if (ahead > 0 && behind > 0) {
        throw Object.assign(
          new Error("Sync cannot continue because local and remote histories have diverged. Rebase or merge your local commits, then try again."),
          { code: "conflict" },
        );
      }
      if (behind > 0) {
        await service.pull(root, remote, branch);
        const afterPull = await run(root, ["rev-list", "--left-right", "--count", `HEAD...${remoteBranch}`], true);
        const [afterAheadText] = afterPull.code === 0 ? afterPull.stdout.trim().split(/\s+/) : [];
        if (Number(afterAheadText ?? 0) > 0) await service.push(root, remote);
        return;
      }
      await service.push(root, remote);
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

    async mergeBase(root, first, second) {
      const result = await run(root, ["merge-base", assertRev(first), assertRev(second)]);
      return result.stdout.trim();
    },

    async readRef(root, ref) {
      assertRev(ref);
      if (!ref.startsWith("refs/")) throw Object.assign(new Error("full ref name required"), { code: "invalid-input" });
      const result = await run(root, ["for-each-ref", "--format=%(refname) %(objectname)", ref]);
      if (result.stderr.trim()) throw Object.assign(new Error(shortErr(result.stderr)), { code: "git-failed" });
      const row = result.stdout.split("\n").find((line) => line.startsWith(`${ref} `));
      return row ? row.slice(ref.length + 1).trim() : null;
    },

    async refsMergedIntoBranches(root, prefix) {
      assertRev(prefix);
      if (!prefix.startsWith("refs/") || !prefix.endsWith("/")) {
        throw Object.assign(new Error("ref prefix must be a full refs/…/ namespace"), { code: "invalid-input" });
      }
      const heads = await run(root, ["for-each-ref", "--format=%(objectname)", "refs/heads/"]);
      const tips = [...new Set(heads.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
      if (!tips.length) return [];
      // Repeated --merged filters are OR-ed: reachable from any branch tip.
      const result = await run(root, [
        "for-each-ref", "--format=%(refname) %(objectname)",
        ...tips.flatMap((tip) => ["--merged", tip]),
        prefix,
      ]);
      return result.stdout.split("\n").flatMap((line) => {
        const [ref, sha] = line.trim().split(" ");
        return ref?.startsWith(prefix) && sha ? [{ ref, sha }] : [];
      });
    },

    async gitDir(root) {
      return (await run(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    },

    async commonDir(root) {
      const r = await run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], true);
      return (r.code === 0 && r.stdout.trim()) || (await service.gitDir(root));
    },

    async stageAll(root) {
      await run(root, ["add", "-A", "--"]);
    },

    async checkIgnored(root, paths) {
      const clean = paths.filter((rel) => rel && !/[\r\n\0]/.test(rel));
      if (clean.length === 0) return [];
      const result = await run(root, ["check-ignore", "-z", "--stdin"], {
        allowFail: true,
        input: clean.map((rel) => `${rel}\0`).join(""),
      });
      // check-ignore exits 0 with matches and 1 with none; anything else is a
      // real failure (unborn/broken repository) and must not read as "not ignored".
      if (!result.exited || (result.code !== 0 && result.code !== 1)) {
        throw Object.assign(new Error(shortErr(String(result.stderr || "git check-ignore failed"))), { code: "git-failed" });
      }
      return result.stdout.split("\0").filter(Boolean);
    },

    async fingerprint(root) {
      const head = (await run(root, ["rev-parse", "HEAD"], true)).stdout.trim() || "unborn";
      return `${head}:${await hashDirtyTree(root)}`;
    },

    async workingFingerprint(root) {
      const temp = await mkdtemp(join(tmpdir(), "polyth-git-working-fingerprint-"));
      const index = join(temp, "index");
      const env = { GIT_INDEX_FILE: index };
      try {
        await run(root, ["read-tree", "HEAD"], { env });
        await run(root, ["add", "-A", "--"], { env });
        const tree = (await run(root, ["write-tree"], { env })).stdout.trim();
        const indexState = (await run(root, ["ls-files", "--stage", "-z"], true)).stdout;
        return createHash("sha256").update(indexState).update("\0").update(tree).digest("hex").slice(0, 16);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },

    async hasUniqueChanges(root, againstRef) {
      assertRev(againstRef);
      const dirty = (await run(root, ["status", "--porcelain=v1", "-unormal"], true)).stdout.trim();
      if (dirty) return true;
      const ahead = await run(root, ["rev-list", "--count", `${againstRef}..HEAD`], true);
      return ahead.code === 0 && Number(ahead.stdout.trim()) > 0;
    },

    async workingTreeMatches(root, commit) {
      assertRev(commit, "commit");
      const temp = await mkdtemp(join(tmpdir(), "polyth-git-index-"));
      const index = join(temp, "index");
      const env = { GIT_INDEX_FILE: index };
      try {
        await run(root, ["read-tree", "HEAD"], { env });
        await run(root, ["add", "-A", "--"], { env });
        const workingTree = (await run(root, ["write-tree"], { env })).stdout.trim();
        const expected = (await run(root, ["rev-parse", `${commit}^{tree}`])).stdout.trim();
        return workingTree === expected;
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },

    async snapshotCommit(root, message, identity) {
      if (!message.trim()) throw Object.assign(new Error("commit message is empty"), { code: "invalid-input" });
      const temp = await mkdtemp(join(tmpdir(), "polyth-git-index-"));
      const index = join(temp, "index");
      const env = { GIT_INDEX_FILE: index };
      try {
        const head = (await run(root, ["rev-parse", "HEAD"])).stdout.trim();
        await run(root, ["read-tree", head], { env });
        // A private index combines HEAD with the complete working tree. This
        // honours ignore rules while leaving the user's index byte-for-byte alone.
        await run(root, ["add", "-A", "--"], { env });
        const tree = (await run(root, ["write-tree"], { env })).stdout.trim();
        const headTree = (await run(root, ["rev-parse", `${head}^{tree}`])).stdout.trim();
        if (tree === headTree) return { sha: head, created: false };
        return {
          sha: await commitTree(root, tree, head, message, identity),
          created: true,
        };
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },

    async mergeSquash(root, ref) {
      assertRev(ref);
      const r = await run(root, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "merge", "--squash", "--no-commit", ref], {
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

    async mergeConflicts(root, input) {
      return mergeConflictPreview(run, root, input);
    },

    async merge(root, ref) {
      assertRev(ref);
      const before = (await run(root, ["rev-parse", "HEAD"], true)).stdout.trim();
      const result = await run(root, [
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
        "merge", "--no-edit", ref,
      ], { allowFail: true, timeoutMs: Math.max(timeout, 120_000) });
      if (result.code === 0) {
        const head = (await run(root, ["rev-parse", "HEAD"], true)).stdout.trim();
        const said = `${result.stdout}\n${result.stderr}`;
        return {
          ok: true,
          alreadyUpToDate: head !== "" && head === before,
          fastForward: /fast[- ]forward/i.test(said),
          head,
        };
      }
      // Git reports a stopped merge through the working tree, not the exit
      // code: only an actually conflicted index means "resolve or abort".
      const conflicted = (await service.status(root)).conflicted.map((file) => file.path);
      if (conflicted.length > 0) return { ok: false, conflicted };
      throw Object.assign(new Error(shortErr(result.stderr || result.stdout || "merge failed")), {
        code: "git-failed",
      });
    },

    async abortMerge(root) {
      await run(root, ["merge", "--abort"], true);
    },

    async commitWithIdentity(root, message, identity) {
      if (!message.trim()) throw Object.assign(new Error("commit message is empty"), { code: "invalid-input" });
      const acting = identity ?? currentGitCommitIdentity();
      const name = acting?.name.trim() || (await service.identity(root)).name || "Polyth";
      const email = acting?.email.trim() || (await service.identity(root)).email || "polyth@localhost";
      await run(root, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message]);
      const { stdout } = await run(root, ["rev-parse", "HEAD"]);
      return { sha: stdout.trim() };
    },

    async commitStagedTree(root, message, identity) {
      if (!message.trim()) throw Object.assign(new Error("commit message is empty"), { code: "invalid-input" });
      const tree = (await run(root, ["write-tree"])).stdout.trim();
      const parent = (await run(root, ["rev-parse", "HEAD"])).stdout.trim();
      return { sha: await commitTree(root, tree, parent, message, identity) };
    },

    async mergeFfOnly(root, sha) {
      assertRev(sha);
      await run(root, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "merge", "--ff-only", sha], { timeoutMs: Math.max(timeout, 120_000) });
    },

    async updateRef(root, ref, newSha, expectedOldSha) {
      assertRev(ref);
      assertRev(newSha, "sha");
      assertRev(expectedOldSha, "sha");
      const r = await run(root, ["-c", "core.hooksPath=/dev/null", "update-ref", ref, newSha, expectedOldSha], true);
      return r.code === 0;
    },

    async publishRef(root, input) {
      for (const value of [input.targetRef, input.receiptRef, input.expectedHead, input.newSha]) assertRev(value);
      if (!input.targetRef.startsWith("refs/heads/") || !input.receiptRef.startsWith("refs/polyth/")) {
        throw Object.assign(new Error("publication requires a local branch and internal receipt ref"), { code: "invalid-input" });
      }
      const result = await run(root, ["-c", "core.hooksPath=/dev/null", "update-ref", "--stdin"], {
        allowFail: true,
        input: `start\nupdate ${input.targetRef} ${input.newSha} ${input.expectedHead}\ncreate ${input.receiptRef} ${input.newSha}\nprepare\ncommit\n`,
      });
      if (result.code === 0) return true;
      // A process timeout can hide a committed transaction; its receipt is the
      // durable authority even if the target has subsequently moved again.
      const receipt = await run(root, ["rev-parse", "--verify", input.receiptRef], true);
      if (receipt.code === 0) {
        if (receipt.stdout.trim() === input.newSha) return true;
        throw Object.assign(new Error("publication receipt identity mismatch"), { code: "conflict" });
      }
      const target = await service.revParse(root, input.targetRef);
      if (target !== input.expectedHead) return false;
      throw Object.assign(new Error(shortErr(result.stderr || "Git publication transaction failed")), { code: "git-failed" });
    },

    async syncPublishedCheckout(root, input) {
      const branch = input.branch.replace(/^refs\/heads\//, "");
      assertRev(branch);
      assertRev(input.expectedHead);
      assertRev(input.resultCommit);
      const refuse = () => Object.assign(new Error("published checkout changed or has overlapping local work; restore its branch or resolve the overlap before recovery"), { code: "conflict" });
      const readBranchHead = async () => {
        const symbolic = await run(root, ["symbolic-ref", "-q", "HEAD"], true);
        if (symbolic.code !== 0 || symbolic.stdout.trim() !== `refs/heads/${branch}`) throw refuse();
        return service.revParse(root, "HEAD");
      };
      const live = await readBranchHead();
      const assertBranch = async () => { if (await readBranchHead() !== live) throw refuse(); };
      // Git's two-tree carry-forward is path-level and cheap. It succeeds for a
      // pristine checkout and for local work in untouched files, and fails when
      // a path is edited on both sides or obstructed by untracked data. Those
      // cases fall through to a content-level merge below.
      const carryForward = async (checkOnly: boolean): Promise<boolean> => {
        const result = await run(root, [
          "read-tree",
          ...(checkOnly ? ["--dry-run"] : []),
          "-m",
          "-u",
          input.expectedHead,
          input.resultCommit,
        ], true);
        return result.exited && result.code === 0;
      };
      // Merge the local index and worktree states with the published tree
      // without writing to the checkout, so the preflight and the repair
      // refuse exactly the same overlaps.
      const planContentCarry = async (): Promise<{ worktree: string; index: string }> => {
        const scratch = await mkdtemp(join(tmpdir(), "polyth-carry-"));
        try {
          const incoming = await run(root, [
            "diff", "--name-only", "--diff-filter=AM", input.expectedHead, input.resultCommit,
          ], true);
          if (!incoming.exited || incoming.code !== 0) throw refuse();
          const published = new Set(incoming.stdout.split("\n").filter(Boolean));
          if (published.size > 0) {
            const untracked = await run(root, ["ls-files", "--others", "--exclude-standard"], true);
            if (!untracked.exited || untracked.code !== 0) throw refuse();
            // The repair rewrites published paths; an untracked file at one of
            // them would be destroyed without an explicit refusal.
            for (const path of untracked.stdout.split("\n")) {
              if (path && published.has(path)) throw refuse();
            }
          }
          const indexFile = join(scratch, "local.index");
          const env = { GIT_INDEX_FILE: indexFile };
          const seed = await run(root, ["read-tree", input.expectedHead], { allowFail: true, env });
          if (!seed.exited || seed.code !== 0) throw refuse();
          const staged = await run(root, ["add", "-u"], { allowFail: true, env });
          if (!staged.exited || staged.code !== 0) throw refuse();
          const worktreeTree = await run(root, ["write-tree"], { allowFail: true, env });
          if (!worktreeTree.exited || worktreeTree.code !== 0) throw refuse();
          // Copy the real index before reading it: `write-tree` refreshes and
          // rewrites the index stat cache, and the preflight must leave the
          // user's index byte-for-byte alone.
          const realIndex = await run(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], true);
          if (!realIndex.exited || realIndex.code !== 0) throw refuse();
          const indexCopy = join(scratch, "staged.index");
          await copyFile(realIndex.stdout.trim(), indexCopy);
          const indexTree = await run(root, ["write-tree"], { allowFail: true, env: { GIT_INDEX_FILE: indexCopy } });
          if (!indexTree.exited || indexTree.code !== 0) throw refuse();
          const worktree = await mergeTreeContents(
            run, root, input.expectedHead, worktreeTree.stdout.trim(), input.resultCommit, scratch, "worktree",
          );
          if (!worktree) throw refuse();
          const index = await mergeTreeContents(
            run, root, input.expectedHead, indexTree.stdout.trim(), input.resultCommit, scratch, "index",
          );
          if (!index) throw refuse();
          return { worktree, index };
        } finally {
          await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
      };
      if (input.checkOnly) {
        if (live !== input.expectedHead) throw refuse();
        if (!(await carryForward(true))) await planContentCarry();
        await assertBranch();
        return;
      }
      if (live !== input.resultCommit) {
        // A later valid commit may already have synchronized the checkout. A
        // pristine descendant needs no repair, and must never be rolled back.
        if (!(await service.isAncestor(root, input.resultCommit, live))) throw refuse();
        const tree = (await run(root, ["rev-parse", `${live}^{tree}`])).stdout.trim();
        if ((await run(root, ["write-tree"])).stdout.trim() !== tree
          || (await run(root, ["diff", "--quiet", live, "--"], true)).code !== 0) throw refuse();
        await assertBranch();
        return;
      }
      if (await carryForward(true)) {
        await assertBranch();
        await carryForward(false);
        await assertBranch();
        return;
      }
      // Overlapping files resolve content-wise: rewrite the checkout to the
      // merged worktree tree, then stage the separately merged index tree so
      // staged and unstaged work keep their identity.
      const planned = await planContentCarry();
      await assertBranch();
      const applied = await run(root, ["read-tree", "--reset", "-u", planned.worktree], true);
      if (!applied.exited || applied.code !== 0) throw refuse();
      await assertBranch();
      const restaged = await run(root, ["read-tree", planned.index], true);
      if (!restaged.exited || restaged.code !== 0) throw refuse();
      await assertBranch();
    },

    async replacePublishedCheckout(root, input) {
      const branch = input.branch.replace(/^refs\/heads\//, "");
      assertRev(branch);
      assertRev(input.expectedHead);
      assertRev(input.resultCommit);
      const expectedWorking = typeof input.expectedFingerprint === "string" ? input.expectedFingerprint : "";
      if (!/^[0-9a-f]{16}$/i.test(expectedWorking)) {
        throw Object.assign(new Error("invalid expected checkout fingerprint"), { code: "invalid-input" });
      }
      const refuse = () => Object.assign(
        new Error("published checkout changed; local repair was not installed"),
        { code: "conflict" },
      );
      const symbolic = await run(root, ["symbolic-ref", "-q", "HEAD"], true);
      if (symbolic.code !== 0 || symbolic.stdout.trim() !== `refs/heads/${branch}`) throw refuse();
      const live = await service.revParse(root, "HEAD");
      if (live !== input.resultCommit) throw refuse();
      const currentWorking = await service.workingFingerprint(root);
      if (currentWorking !== expectedWorking) throw refuse();
      const applied = await run(root, ["read-tree", "--reset", "-u", input.resultCommit], true);
      if (!applied.exited || applied.code !== 0) throw refuse();
      const tracked = await run(root, ["diff", "--quiet", input.resultCommit, "--"], true);
      if (!tracked.exited || tracked.code !== 0) throw refuse();
      const staged = await run(root, ["diff", "--cached", "--quiet"], true);
      if (!staged.exited || staged.code !== 0) throw refuse();
      const finalBranch = await run(root, ["symbolic-ref", "-q", "HEAD"], true);
      if (finalBranch.code !== 0 || finalBranch.stdout.trim() !== `refs/heads/${branch}`) throw refuse();
      if (await service.revParse(root, "HEAD") !== input.resultCommit) throw refuse();
    },

    async isAncestor(root, ancestor, descendant) {
      assertRev(ancestor, "sha");
      assertRev(descendant, "sha");
      const r = await run(root, ["merge-base", "--is-ancestor", ancestor, descendant], true);
      return r.code === 0;
    },

    async deleteRef(root, ref, expectedSha) {
      assertRev(ref);
      assertRev(expectedSha);
      const result = await run(root, ["-c", "core.hooksPath=/dev/null", "update-ref", "-d", ref, expectedSha], true);
      return result.code === 0 || await service.readRef(root, ref) === null;
    },

    async deleteBranch(root, name) {
      const branch = name.replace(/^refs\/heads\//, "").trim();
      if (!branch) throw Object.assign(new Error("branch name is required"), { code: "invalid-input" });
      const r = await run(root, ["branch", "-D", branch], true);
      return r.code === 0;
    },

    worktrees: {
      async list(root) {
        const r = await run(root, ["worktree", "list", "--porcelain"]);
        return parseWorktrees(r.stdout);
      },

      async create(root, input) {
        const branch = input.branch.trim();
        if (!branch) throw Object.assign(new Error("branch name is required"), { code: "invalid-input" });
        const target = input.path
          ? resolve(input.path)
          : join(dirname(resolve(root)), `${basename(resolve(root))}-worktrees`, sanitizeBranchDir(branch));
        await mkdir(dirname(target), { recursive: true });
        const exists = (await run(root, ["rev-parse", "--verify", `refs/heads/${branch}`], true)).code === 0;
        if (exists && input.newBranchOnly) throw Object.assign(new Error("branch already exists"), { code: "conflict" });
        if (exists) await run(root, ["worktree", "add", target, branch]);
        else {
          const base = input.base ?? "HEAD";
          await run(root, [...(input.newBranchOnly ? ["-c", "core.hooksPath=/dev/null"] : []), "worktree", "add", "-b", branch, target, base]);
        }
        return { path: target, branch };
      },

      async remove(root, input) {
        const listed = await listWorktrees(root);
        const wt = listed.trees.find((w) => resolve(w.path) === resolve(input.path));
        const args = input.force
          ? ["worktree", "remove", "--force", input.path]
          : ["worktree", "remove", input.path];
        const result = await run(root, args, true);
        if (result.code !== 0) {
          if (!input.force && isDirtyWorktreeRefusal(result.stderr)) {
            const inspectRoot = wt?.path && existsSync(wt.path) ? wt.path : input.path;
            const status = existsSync(inspectRoot)
              ? await run(inspectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true)
              : { code: 1, stdout: "", stderr: "" };
            const changes = status.code === 0 ? status.stdout.split("\0").filter(Boolean).length : 0;
            throw Object.assign(
              new Error(
                changes > 0
                  ? `This worktree has ${changes} uncommitted change${changes === 1 ? "" : "s"} that will be lost. Remove anyway?`
                  : "This worktree has uncommitted or untracked changes that will be lost. Remove anyway?",
              ),
              { code: "worktree-dirty", ...(changes > 0 ? { changes } : {}) },
            );
          }
          const after = await listWorktrees(root);
          const stillPresent = after.ok && after.trees.some((tree) => resolve(tree.path) === resolve(input.path));
          if (stillPresent || !after.ok) {
            throw Object.assign(new Error(shortErr(result.stderr)), { cause: result.stderr, code: "git-failed" });
          }
        }
        // The default `<repo>-worktrees` folder exists only for these checkouts.
        const parent = dirname(resolve(input.path));
        if (parent === join(dirname(resolve(root)), `${basename(resolve(root))}-worktrees`)) await rmdir(parent).catch(() => undefined);
        if (!input.deleteBranch) return {};
        const branch = wt?.branch
          ?? (input.ownedBranch && OWNED_BRANCH.test(input.ownedBranch) ? input.ownedBranch : null);
        if (!branch) return { branchCleanupFailed: true };
        return (await deleteOwnedBranch(root, branch)) ? {} : { branchCleanupFailed: true };
      },

      async prune(root) {
        await run(root, ["worktree", "prune"], true);
      },

      async addDetached(root, path, startPoint) {
        assertRev(startPoint);
        const target = resolve(path);
        await mkdir(dirname(target), { recursive: true });
        await run(root, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", target, startPoint]);
      },
    },
  };

  if (process.env.POLYTH_AGENT_BETA !== "1") return service;

  const denied = (): never => {
    throw Object.assign(
      new Error("Agent beta mode is read-only for the workspace; Git mutations are disabled."),
      { code: "forbidden" },
    );
  };
  const mutating = new Set<string>([
    "stage", "unstage", "discard", "commit",
    "createBranch", "renameBranch", "checkout",
    "stashPush", "stashApply", "stashDrop",
    "fetch", "pull", "rebase", "push", "pushBranch",
    "rebaseOnto", "pushForceWithLease", "sync", "setIdentity",
    "stageAll", "workingFingerprint", "workingTreeMatches", "snapshotCommit",
    "mergeSquash", "merge", "abortMerge", "commitWithIdentity",
    "commitStagedTree", "mergeFfOnly", "updateRef", "publishRef",
    "syncPublishedCheckout", "replacePublishedCheckout",
    "deleteRef", "deleteBranch",
  ]);
  const guardedWorktrees: WorktreeService = {
    list: (root) => service.worktrees.list(root),
    create: async () => denied(),
    remove: async () => denied(),
    prune: async () => denied(),
    addDetached: async () => denied(),
  };
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "worktrees") return guardedWorktrees;
      if (typeof property === "string" && mutating.has(property)) {
        return async () => denied();
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
