import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GIT_BINARY_ENV, resolveExecutable } from "@polyth/kernel/executable";
import { extractZipBuffer } from "./zipExtract.ts";
import { MAX_INSTALL_BYTES } from "./networkBroker.ts";
import { findPackageRoot } from "./installSources.ts";

/** How a forked package integrates upstream changes into its local commits. */
export type ForkStrategy = "rebase" | "merge";

export const FORK_STRATEGIES: readonly ForkStrategy[] = ["rebase", "merge"];

export interface ForkTracking {
  strategy: ForkStrategy;
  /** Upstream ref the fork follows; "HEAD" follows the default branch. */
  ref: string;
}

/** Local branch that carries the operator's own commits on top of upstream. */
const LOCAL_BRANCH = "polyth-local";
const UPSTREAM_REMOTE = "upstream";
const CLONE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function isForkStrategy(value: unknown): value is ForkStrategy {
  return value === "rebase" || value === "merge";
}

interface CommandResult { ok: boolean; stdout: string; stderr: string }

function run(command: string, args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(commandPath(command), args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() });
    });
  });
}

const git = (dir: string, args: string[], timeout?: number) => run("git", args, dir, timeout);

/** Resolve a fork command's executable now, so a server with a minimal PATH
 *  still finds `git`/`gh`. `git` honours `POLYTH_GIT_BIN` like every call site. */
const commandPath = (command: string): string =>
  resolveExecutable(command, command === "git" ? { overrideEnv: GIT_BINARY_ENV } : {});

async function gitOrFail(dir: string, args: string[], message: string): Promise<string> {
  const result = await git(dir, args);
  if (!result.ok) fail("conflict", result.stderr ? `${message}: ${result.stderr.split("\n")[0]}` : message);
  return result.stdout;
}

/** The ref and repository path come from a pasted URL and reach git/gh as
 *  arguments. Git branch/tag names and forge owners never start with "-" or
 *  contain whitespace/control characters, so anything shaped like an option is
 *  refused instead of being parsed as one (`git fetch upstream --upload-pack=…`). */
function assertForkArgument(value: string, what: string): void {
  if (!value || value.startsWith("-") || /[\s\0-\x1f\x7f]/.test(value)) {
    fail("invalid-input", `the repository ${what} is not valid for a fork`);
  }
}

/** Remote URLs tried in order. The same order the authenticated checkout
 *  fallback uses, so a host signed in with gh or an SSH key can fork a
 *  private repository. */
export function forkCloneAttempts(
  input: { host: string; path: string; ref: string },
  dest: string,
): Array<{ command: string; args: string[] }> {
  assertForkArgument(input.path, "path");
  assertForkArgument(input.ref, "ref");
  const branch = input.ref !== "HEAD" ? ["--branch", input.ref] : [];
  const attempts: Array<{ command: string; args: string[] }> = [];
  if (input.host === "github.com" || input.host === "www.github.com") {
    attempts.push({ command: "gh", args: ["repo", "clone", input.path, dest, "--", "--no-tags", ...branch] });
  }
  attempts.push({ command: "git", args: ["clone", "--no-tags", ...branch, "--", `https://${input.host}/${input.path}.git`, dest] });
  attempts.push({ command: "git", args: ["clone", "--no-tags", ...branch, "--", `git@${input.host}:${input.path}.git`, dest] });
  return attempts;
}

/** Turn a fresh clone into a Polyth-owned fork: the clone's origin becomes
 *  `upstream`, and local work lives on its own branch. */
async function initializeFork(dest: string): Promise<void> {
  // gh adds its own `upstream` for a GitHub fork; the URL the operator gave is the upstream here.
  await git(dest, ["remote", "remove", UPSTREAM_REMOTE]);
  await gitOrFail(dest, ["remote", "rename", "origin", UPSTREAM_REMOTE], "could not configure the upstream remote");
  await gitOrFail(dest, ["checkout", "-B", LOCAL_BRANCH], "could not create the local fork branch");
  // Merge and rebase need a committer; keep a host identity when one exists.
  const identity = await git(dest, ["config", "--get", "user.email"]);
  if (!identity.ok || !identity.stdout) {
    await gitOrFail(dest, ["config", "user.name", "Polyth package fork"], "could not configure the fork");
    await gitOrFail(dest, ["config", "user.email", "packages@polyth.invalid"], "could not configure the fork");
  }
}

/** Clone `attempts` into `dest` until one succeeds, then initialize the fork. */
export async function cloneFork(
  attempts: ReadonlyArray<{ command: string; args: string[] }>,
  dest: string,
  cwd: string,
): Promise<void> {
  for (const attempt of attempts) {
    rmSync(dest, { recursive: true, force: true });
    const result = await run(attempt.command, attempt.args, cwd, CLONE_TIMEOUT_MS);
    if (!result.ok) continue;
    await initializeFork(dest);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  fail("invalid-input", "could not clone the repository to create a fork. For private repositories, sign in with gh or configure an SSH key on the Polyth host, then retry.");
}

async function fetchUpstream(dir: string, fork: ForkTracking): Promise<string> {
  assertForkArgument(fork.ref, "ref");
  const fetched = await git(dir, ["fetch", "--no-tags", UPSTREAM_REMOTE, fork.ref], CLONE_TIMEOUT_MS);
  if (!fetched.ok) fail("invalid-input", `could not fetch upstream ${fork.ref}${fetched.stderr ? `: ${fetched.stderr.split("\n")[0]}` : ""}`);
  return gitOrFail(dir, ["rev-parse", "FETCH_HEAD"], "could not resolve the fetched upstream commit");
}

async function assertClean(dir: string): Promise<void> {
  const status = await gitOrFail(dir, ["status", "--porcelain"], "could not read the fork status");
  if (status) fail("conflict", "the package fork has uncommitted changes; commit or discard them before updating");
}

export interface ForkStatus {
  head: string;
  upstream: string;
  /** Upstream commits not yet integrated into the fork. */
  behind: number;
  /** Local fork commits that upstream does not have. */
  ahead: number;
}

/** Fetch upstream and report how far the fork is behind, without changing it. */
export async function checkFork(dir: string, fork: ForkTracking): Promise<ForkStatus> {
  const upstream = await fetchUpstream(dir, fork);
  const head = await gitOrFail(dir, ["rev-parse", "HEAD"], "could not resolve the fork head");
  const counts = await gitOrFail(dir, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], "could not compare the fork with upstream");
  const [ahead, behind] = counts.split(/\s+/).map((value) => Number(value) || 0);
  return { head, upstream, behind: behind ?? 0, ahead: ahead ?? 0 };
}

/** Integrate upstream into the fork with the configured strategy. A conflict
 *  aborts the integration and leaves the fork exactly as it was. */
export async function syncFork(dir: string, fork: ForkTracking): Promise<ForkStatus & { changed: boolean }> {
  await assertClean(dir);
  const before = await checkFork(dir, fork);
  if (before.behind === 0) return { ...before, changed: false };
  if (fork.strategy === "merge") {
    const merged = await git(dir, ["merge", "--no-edit", before.upstream]);
    if (!merged.ok) {
      await git(dir, ["merge", "--abort"]);
      fail("conflict", "upstream changes conflict with the fork's local commits (merge aborted; the active version is unchanged)");
    }
  } else {
    const rebased = await git(dir, ["rebase", before.upstream]);
    if (!rebased.ok) {
      await git(dir, ["rebase", "--abort"]);
      fail("conflict", "upstream changes conflict with the fork's local commits (rebase aborted; the active version is unchanged)");
    }
  }
  const head = await gitOrFail(dir, ["rev-parse", "HEAD"], "could not resolve the fork head");
  return { head, upstream: before.upstream, behind: 0, ahead: before.ahead, changed: head !== before.head };
}

/** Stage the fork's committed tree. `git archive` excludes `.git` and
 *  untracked files, and the zip goes through the same hardened extractor as a
 *  downloaded archive. */
export async function stageFork(dir: string, staging: string): Promise<{ pkgDir: string; head: string }> {
  const head = await gitOrFail(dir, ["rev-parse", "HEAD"], "could not resolve the fork head");
  const archive = await new Promise<Buffer>((resolve, reject) => {
    execFile(commandPath("git"), ["archive", "--format=zip", head], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      encoding: "buffer",
      maxBuffer: MAX_INSTALL_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => {
      if (error) reject(Object.assign(new Error("could not archive the package fork (it may be too large)"), { code: "invalid-input" }));
      else resolve(stdout);
    });
  });
  const tree = join(staging, "tree");
  await extractZipBuffer(archive, tree);
  return { pkgDir: findPackageRoot(tree), head };
}

/** A fork publishes every integrated commit, including local ones that do not
 *  bump the manifest version, so its version records carry the commit as
 *  semver build metadata. */
export function forkVersion(manifestVersion: string, head: string): string {
  const commit = `g${head.slice(0, 12)}`;
  return manifestVersion.includes("+") ? `${manifestVersion}.${commit}` : `${manifestVersion}+${commit}`;
}

export function forkDir(pluginHome: string): string {
  return join(pluginHome, "fork");
}
