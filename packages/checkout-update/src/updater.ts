// The self-update driver for a server that runs from a git checkout.
//
// It only fast-forwards: the checkout's branch follows its upstream
// (`origin/devel`), the tracked tree must be clean, and a branch with commits
// of its own is never moved. That keeps the deployment checkout a mirror of
// what was pushed; changes are made in another clone (a project) and reach
// this server through the remote. After the fast-forward it installs the
// dependencies in place (`npm install --no-save`, so the lockfile stays as
// committed and node_modules is never wiped under the running server),
// rebuilds the web app, rebuilds the Polyth Link host when its Rust sources
// changed, and loads the new server's module graph once without starting it.
// Any failure puts the previous commit and its build back, so the next
// restart starts what runs now. It never restarts anything itself: the host
// exits for the update and the service starts the new code.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { scrubInheritedEnv } from "@polyth/kernel/inherited-env";
import type { SelfUpdateResult, ServerSelfUpdater } from "@polyth/plugins";

const QUERY_TIMEOUT_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const CARGO_TIMEOUT_MS = 45 * 60_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
/** A revision as the host shows it: long enough to be unambiguous. */
const SHORT = 12;
/** What the Polyth Link host is built from. */
const RUST_SOURCES = ["Cargo.toml", "Cargo.lock", "crates"];
const LINK_HOST_BINARY = join("target", "release", "polyth-link-host");

export interface Ran { ok: boolean; stdout: string; stderr: string }

export type Runner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<Ran>;

/** One build step after the fast-forward, run in the checkout. */
export interface BuildStep {
  label: string;
  command: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CheckoutUpdaterOptions {
  /** The checkout this server runs from. */
  root: string;
  /** The server's environment (CC, PATH, CARGO_HOME…); git variables that
   *  redirect it elsewhere are dropped. */
  env?: NodeJS.ProcessEnv;
  /** The Node that runs this server; npm is taken from beside it. */
  execPath?: string;
  run?: Runner;
  /** The steps that rebuild a revision, for tests. */
  buildSteps?: (input: { rustChanged: boolean }) => Promise<BuildStep[]> | BuildStep[];
}

export const runProcess: Runner = (command, args, options) => new Promise((resolveRun) => {
  execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: OUTPUT_LIMIT,
    encoding: "utf8",
  }, (error, stdout, stderr) => resolveRun({
    ok: !error,
    stdout: String(stdout),
    stderr: String(stderr || (error && !stderr ? error.message : "")),
  }));
});

const lastLines = (text: string, count = 8): string => text.trim().split("\n").slice(-count).join("\n");
const short = (sha: string): string => sha.slice(0, SHORT);

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Why `root` is not a checkout this driver can update, or null. Cheap: no
 *  process runs. */
export function checkoutProblem(root: string): string | null {
  if (!existsSync(join(root, ".git"))) return "This server does not run from a git checkout.";
  if (!existsSync(join(root, "packages", "server", "src", "index.ts"))) return "This checkout is not a Polyth source checkout.";
  if (!writable(root) || !writable(join(root, ".git"))) return `This server's account cannot write ${root}.`;
  return null;
}

/** cargo from the server's PATH, CARGO_HOME or the account's ~/.cargo. */
function cargoCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || homedir();
  return [
    ...(env.CARGO_HOME?.trim() ? [join(env.CARGO_HOME.trim(), "bin", "cargo")] : []),
    join(home, ".cargo", "bin", "cargo"),
  ];
}

export function createCheckoutUpdater(options: CheckoutUpdaterOptions): ServerSelfUpdater {
  const root = options.root;
  const run = options.run ?? runProcess;
  const execPath = options.execPath ?? process.execPath;
  const nodeBin = dirname(execPath);
  const baseEnv = scrubInheritedEnv(options.env ?? process.env);
  // npm's shebang needs `node` on PATH; a service's PATH may hold neither.
  const env: NodeJS.ProcessEnv = { ...baseEnv, PATH: [nodeBin, baseEnv.PATH].filter(Boolean).join(":") };
  const gitEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const npm = existsSync(join(nodeBin, "npm")) ? join(nodeBin, "npm") : "npm";
  let upstreamName: string | null = null;

  const git = async (args: string[], timeoutMs = QUERY_TIMEOUT_MS): Promise<string> => {
    const ran = await run("git", args, { cwd: root, env: gitEnv, timeoutMs });
    if (!ran.ok) throw new Error(`git ${args[0]}: ${lastLines(ran.stderr, 3) || "failed"}`);
    return ran.stdout.trim();
  };
  const gitOk = async (args: string[]): Promise<boolean> =>
    (await run("git", args, { cwd: root, env: gitEnv, timeoutMs: QUERY_TIMEOUT_MS })).ok;

  /** The branch's upstream (`origin/devel`) and its remote, or a reason. */
  const upstream = async (): Promise<{ name: string; remote: string; branch: string }> => {
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (!branch) throw new Error("This checkout is not on a branch (detached HEAD); check out the branch it should follow.");
    const remote = await git(["config", "--get", `branch.${branch}.remote`]).catch(() => "");
    const merge = await git(["config", "--get", `branch.${branch}.merge`]).catch(() => "");
    if (!remote || remote === "." || !merge.startsWith("refs/heads/")) {
      throw new Error(`The branch ${branch} follows no remote branch; set one (git branch --set-upstream-to=origin/${branch}).`);
    }
    const name = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => `${remote}/${merge.slice("refs/heads/".length)}`);
    upstreamName = name;
    return { name, remote, branch: merge.slice("refs/heads/".length) };
  };

  /** Tracked files with local changes; untracked and ignored files (builds,
   *  node_modules) do not count. */
  const localChanges = async (): Promise<string[]> => {
    // Not trimmed: a porcelain line starts with its two status columns.
    const ran = await run("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: root, env: gitEnv, timeoutMs: QUERY_TIMEOUT_MS });
    if (!ran.ok) throw new Error(`git status: ${lastLines(ran.stderr, 3) || "failed"}`);
    return ran.stdout.split("\n").filter((line) => line.length > 3).map((line) => line.slice(3));
  };

  const refuseLocalChanges = async (): Promise<void> => {
    const changed = await localChanges();
    if (changed.length === 0) return;
    const named = changed.slice(0, 5).join(", ") + (changed.length > 5 ? ` and ${changed.length - 5} more` : "");
    throw new Error(`This checkout has local changes (${named}). It updates only a clean checkout: commit and push them from another clone, or discard them here (git checkout -- .).`);
  };

  const head = (): Promise<string> => git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const resolveCommit = (revision: string): Promise<string> => git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);

  const rustChanged = async (from: string, to: string): Promise<boolean> =>
    !(await gitOk(["diff", "--quiet", from, to, "--", ...RUST_SOURCES]));

  const defaultSteps = async (input: { rustChanged: boolean }): Promise<BuildStep[]> => {
    const steps: BuildStep[] = [
      { label: "npm install", command: npm, args: ["install", "--no-save", "--include=dev", "--no-audit", "--no-fund"], timeoutMs: INSTALL_TIMEOUT_MS },
      { label: "npm run build", command: npm, args: ["run", "build"], timeoutMs: BUILD_TIMEOUT_MS },
    ];
    // A Link host built before must follow the server's Link protocol.
    if (input.rustChanged && existsSync(join(root, LINK_HOST_BINARY))) {
      const cargo = cargoCandidates(env).find((candidate) => existsSync(candidate)) ?? "cargo";
      steps.push({
        label: "cargo build (Polyth Link host)",
        command: cargo,
        args: ["build", "--release", "-p", "polyth-link-host", "-p", "polyth-link-client"],
        timeoutMs: CARGO_TIMEOUT_MS,
        env: { ...env, PATH: [dirname(cargo), env.PATH].filter(Boolean).join(":") },
      });
    }
    // Loads the new server's whole module graph without starting it: the
    // entry boots only when it is the process's own script (argv[1]).
    steps.push({
      label: "server module check",
      command: execPath,
      args: [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "-e",
        "await import(process.env.POLYTH_CHECKOUT_UPDATE_ENTRY); process.exit(0);",
      ],
      timeoutMs: QUERY_TIMEOUT_MS,
      env: { ...env, POLYTH_CHECKOUT_UPDATE_ENTRY: pathToFileURL(join(root, "packages", "server", "src", "index.ts")).href },
    });
    return steps;
  };
  const buildSteps = options.buildSteps ?? defaultSteps;

  /** Builds what the checkout holds now; the first failing step's reason. */
  const build = async (changedRust: boolean): Promise<string | null> => {
    for (const step of await buildSteps({ rustChanged: changedRust })) {
      const ran = await run(step.command, step.args, { cwd: root, env: step.env ?? env, timeoutMs: step.timeoutMs });
      if (!ran.ok) return `${step.label} failed: ${lastLines(ran.stderr || ran.stdout)}`;
    }
    return null;
  };

  return {
    kind: "checkout",
    get unavailable() {
      return checkoutProblem(root);
    },
    async current() {
      return short(await head());
    },
    source: () => upstreamName,
    isNewer: (candidate, current) => candidate !== current,
    async newest() {
      const { name, remote, branch } = await upstream();
      await git(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], FETCH_TIMEOUT_MS);
      const [local, remoteHead] = await Promise.all([head(), git(["rev-parse", "--verify", "@{upstream}^{commit}"])]);
      if (local === remoteHead) return short(local);
      if (!(await gitOk(["merge-base", "--is-ancestor", local, remoteHead]))) {
        throw new Error(`This checkout has commits that are not on ${name}; it updates only by fast-forward. Push them from another clone or reset this one to ${name}.`);
      }
      await refuseLocalChanges();
      return short(remoteHead);
    },
    async apply(target, current): Promise<SelfUpdateResult> {
      const from = await head();
      if (short(from) !== current) {
        return { ok: false, installed: short(from), message: `The checkout moved to ${short(from)} since the check; it is checked again.` };
      }
      const to = await resolveCommit(target).catch(() => "");
      if (!to) return { ok: false, installed: current, message: `${target} is not a commit this checkout has fetched.` };
      if (!(await gitOk(["merge-base", "--is-ancestor", from, to]))) {
        return { ok: false, installed: current, message: `${target} does not fast-forward ${current}.` };
      }
      try {
        await refuseLocalChanges();
      } catch (error) {
        return { ok: false, installed: current, message: (error as Error).message };
      }
      const changedRust = await rustChanged(from, to);
      try {
        await git(["merge", "--ff-only", "--quiet", to], QUERY_TIMEOUT_MS);
      } catch (error) {
        return { ok: false, installed: short(await head().catch(() => from)), message: (error as Error).message };
      }
      const broken = await build(changedRust);
      if (!broken) return { ok: true, installed: short(await head()), message: `Updated the checkout to ${short(to)} and rebuilt it.` };
      // The running server keeps its loaded code; the files go back so the
      // next restart starts what runs now. The tree was clean before the
      // fast-forward, so a hard reset discards only what the update changed.
      const back = await run("git", ["reset", "--hard", "--quiet", from], { cwd: root, env: gitEnv, timeoutMs: QUERY_TIMEOUT_MS });
      if (!back.ok) {
        return { ok: false, installed: short(await head().catch(() => to)), message: `${broken}; putting ${short(from)} back failed too: ${lastLines(back.stderr, 3)}` };
      }
      const rebuilt = await build(changedRust);
      return {
        ok: false,
        installed: short(from),
        message: rebuilt
          ? `${broken}; ${short(from)} was put back, but rebuilding it failed too: ${rebuilt}`
          : `${broken}; ${short(from)} was put back.`,
      };
    },
  };
}
