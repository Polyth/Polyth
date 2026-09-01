// Polyth dev supervisor: watch for changes, rebuild only what changed, restart
// the server, and keep it alive across crashes.
//
//   npm run watch                    working-tree changes
//   npm run watch -- --watch=both    working-tree changes + new commits
//
// The server itself runs through Node type stripping, so a change under
// packages/*/src only needs a restart; bundled UI under packages/*/widgets and
// apps/web/src needs an esbuild pass. See scripts/supervisorPlan.ts for the
// full mapping.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { createConnection } from "node:net";
import { relative, resolve, sep } from "node:path";
import {
  applyRestartPolicy,
  backoffDelay,
  classifyChange,
  mergeActions,
  parseSupervisorArgs,
  planForPaths,
  USAGE,
  type ChangeAction,
} from "./supervisorPlan.ts";

const parsed = parseSupervisorArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`polyth supervisor: ${parsed.error}`);
  process.exit(1);
}
if (parsed.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const options = parsed.options;

const repositoryRoot = resolve(import.meta.dirname, "..");
const serverEntry = resolve(repositoryRoot, "packages/server/src/index.ts");
const webDistIndex = resolve(repositoryRoot, "apps/web/dist/index.html");
const port = Number(process.env.PORT ?? 4400);

/** Coalescing window for filesystem events — editors emit several per save. */
const DEBOUNCE_MS = 150;
/** A process that survives this long is treated as a healthy start, so the
 * next crash begins a fresh backoff sequence. */
const STABLE_UPTIME_MS = 10_000;
/** A wedged build must not block the queue forever. */
const BUILD_TIMEOUT_MS = 120_000;
/** How long to wait for the old process to release the port. */
const PORT_FREE_TIMEOUT_MS = 3_000;

function log(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[supervisor ${time}] ${message}\n`);
}

// ---- child process -------------------------------------------------------

let child: ChildProcess | null = null;
let childStartedAt = 0;
/** Set while stopServer() is tearing the child down on purpose. */
let stopping = false;
let shuttingDown = false;
/** True once the crash budget is spent: stay down until the next change. */
let down = false;
let consecutiveCrashes = 0;
let restartTimer: NodeJS.Timeout | null = null;

/** Signal the child's whole process group — the server spawns OpenCode
 * children of its own, and a bare kill(pid) would orphan them. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function portFree(): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (free: boolean): void => {
      socket.destroy();
      done(free);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(500, () => finish(true));
  });
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Restarting into an EADDRINUSE is the most common dev-loop failure; give the
 * old listener a moment to let go. */
async function waitForPortFree(): Promise<void> {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portFree()) return;
    await delay(100);
  }
  log(`warning: port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms`);
}

function startServer(): void {
  const started = spawn(process.execPath, ["--experimental-strip-types", serverEntry], {
    cwd: repositoryRoot,
    stdio: "inherit",
    // Own process group so the whole tree can be signalled together, and so a
    // terminal Ctrl-C reaches the supervisor first.
    detached: true,
    env: process.env,
  });
  child = started;
  childStartedAt = Date.now();
  log(`server started (pid ${started.pid ?? "?"})`);

  started.once("error", (error) => {
    if (started !== child) return;
    log(`failed to spawn server: ${String(error)}`);
  });
  started.once("exit", (code, signal) => {
    if (started !== child) return;
    child = null;
    if (stopping || shuttingDown) return;
    const uptime = Date.now() - childStartedAt;
    const how = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    if (uptime >= STABLE_UPTIME_MS) consecutiveCrashes = 0;
    consecutiveCrashes += 1;
    if (consecutiveCrashes > options.maxCrashes) {
      down = true;
      log(`server exited (${how}) — ${consecutiveCrashes} fast exits in a row, staying down until the next change`);
      return;
    }
    const wait = backoffDelay(consecutiveCrashes);
    log(`server exited (${how}) after ${Math.round(uptime / 1000)}s — restarting in ${wait}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!shuttingDown && child === null) startServer();
    }, wait);
  });
}

async function stopServer(): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const target = child;
  if (!target || target.pid === undefined) {
    child = null;
    return;
  }
  if (target.exitCode !== null || target.signalCode !== null) {
    child = null;
    return;
  }
  stopping = true;
  const exited = new Promise<void>((done) => target.once("exit", () => done()));
  signalGroup(target.pid, "SIGTERM");
  const force = setTimeout(() => {
    log(`server did not stop in ${options.graceMs}ms — sending SIGKILL`);
    signalGroup(target.pid!, "SIGKILL");
  }, options.graceMs);
  await exited;
  clearTimeout(force);
  child = null;
  stopping = false;
  await waitForPortFree();
}

async function restartServer(): Promise<void> {
  await stopServer();
  if (shuttingDown) return;
  consecutiveCrashes = 0;
  down = false;
  startServer();
}

// ---- build ---------------------------------------------------------------

/** Run a repo script with type stripping, capturing output so a successful
 * build stays a single line and a failure shows everything. */
function runNode(scriptPath: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      output += `\nbuild exceeded ${BUILD_TIMEOUT_MS}ms — killed\n`;
      proc.kill("SIGKILL");
    }, BUILD_TIMEOUT_MS);
    proc.once("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, output: `${output}${String(error)}\n` });
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output });
    });
  });
}

/** Package bundles first: apps/web/build.ts reads every package manifest they
 * emit. The whole pass is a few seconds, so it is not split further. */
async function buildWeb(): Promise<boolean> {
  const startedAt = Date.now();
  for (const script of ["apps/web/buildPackages.ts", "apps/web/build.ts"]) {
    const result = await runNode(resolve(repositoryRoot, script));
    if (!result.ok) {
      log(`build failed in ${script} — server left running`);
      process.stdout.write(result.output.trimEnd() + "\n");
      return false;
    }
  }
  log(`web build ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return true;
}

// ---- change queue --------------------------------------------------------

let pending: ChangeAction = "ignore";
let pendingPaths = new Set<string>();
let debounceTimer: NodeJS.Timeout | null = null;
let draining = false;
let queuedBuild = false;
let queuedRestart = false;

function describe(paths: Set<string>): string {
  const [first] = paths;
  const rest = paths.size - 1;
  return rest > 0 ? `${first ?? "?"} (+${rest} more)` : (first ?? "?");
}

function noteChange(relativePath: string, action: ChangeAction): void {
  if (action === "ignore") return;
  pending = mergeActions(pending, action);
  pendingPaths.add(relativePath);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
}

function flushPending(): void {
  debounceTimer = null;
  const action = pending;
  const paths = pendingPaths;
  pending = "ignore";
  pendingPaths = new Set();
  if (action === "ignore") return;
  log(`change: ${describe(paths)} → ${action}`);
  if (action === "build" || action === "build+restart") queuedBuild = true;
  if (action === "restart" || action === "build+restart") queuedRestart = true;
  void drain();
}

async function drain(): Promise<void> {
  if (draining || shuttingDown) return;
  draining = true;
  try {
    while ((queuedBuild || queuedRestart) && !shuttingDown) {
      const build = queuedBuild;
      const restart = queuedRestart;
      queuedBuild = false;
      queuedRestart = false;
      if (build && !(await buildWeb())) continue;
      // A bundle-only change needs no restart (the server reads dist per
      // request) unless the server is down or --restart=always asked for one.
      if (restart || down || child === null) {
        await restartServer();
      } else if (build) {
        log("bundles updated — reload the browser to pick them up");
      }
    }
  } finally {
    draining = false;
  }
}

// ---- watchers ------------------------------------------------------------

const watchers: FSWatcher[] = [];
const watchedDirectories = new Set<string>();
const packagesDirectory = resolve(repositoryRoot, "packages");

/** A package directory that gains src/ or widgets/ after boot — or a package
 * added while the supervisor runs — needs its own watchers. */
function onStructureChanged(parts: readonly string[]): void {
  if (parts[0] !== "packages") return;
  if (parts.length === 2 || (parts.length === 3 && (parts[2] === "src" || parts[2] === "widgets"))) {
    attachPackageWatchers();
  }
}

function watchDirectory(directory: string, recursive: boolean): void {
  if (watchedDirectories.has(directory) || !existsSync(directory)) return;
  try {
    const watcher = watch(directory, { recursive }, (_event, filename) => {
      if (!filename) return;
      const absolute = resolve(directory, filename.toString());
      const relativePath = relative(repositoryRoot, absolute).split(sep).join("/");
      if (relativePath.length === 0 || relativePath.startsWith("..")) return;
      onStructureChanged(relativePath.split("/"));
      noteChange(relativePath, applyRestartPolicy(classifyChange(relativePath), options.restart));
    });
    watchedDirectories.add(directory);
    watcher.on("error", (error) => log(`watch error on ${relative(repositoryRoot, directory)}: ${String(error)}`));
    watchers.push(watcher);
  } catch (error) {
    log(`cannot watch ${relative(repositoryRoot, directory)}: ${String(error)}`);
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      log("hint: raise fs.inotify.max_user_watches");
    }
  }
}

/** One recursive watcher per package source root. Watching packages/
 * recursively instead would descend into every dist/ the build deletes and
 * recreates, which costs an event storm and an ENOENT per rebuild. */
function attachPackageWatchers(): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(packagesDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const packageDirectory = resolve(packagesDirectory, entry.name);
    // Non-recursive: package.json lives here, dist/ is skipped on sight.
    watchDirectory(packageDirectory, false);
    watchDirectory(resolve(packageDirectory, "src"), true);
    watchDirectory(resolve(packageDirectory, "widgets"), true);
  }
}

function startFsWatch(): void {
  // Only source roots are watched, so a build never re-triggers itself.
  watchDirectory(repositoryRoot, false);
  watchDirectory(resolve(repositoryRoot, "apps/web"), false);
  watchDirectory(resolve(repositoryRoot, "apps/web/src"), true);
  watchDirectory(packagesDirectory, false);
  attachPackageWatchers();
  log(`watching ${watchedDirectories.size} source directories`);
}

// ---- git -----------------------------------------------------------------

function runGit(args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const proc = spawn("git", [...args], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.once("error", (error) => done({ ok: false, stdout, stderr: String(error) }));
    proc.once("close", (code) => done({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function head(): Promise<string | null> {
  const result = await runGit(["rev-parse", "HEAD"]);
  return result.ok ? result.stdout : null;
}

let lastHead: string | null = null;
let gitBusy = false;
let gitTimer: NodeJS.Timeout | null = null;

async function pollGit(): Promise<void> {
  if (gitBusy || shuttingDown) return;
  gitBusy = true;
  try {
    if (options.pull) {
      const fetched = await runGit(["fetch", "--quiet"]);
      if (!fetched.ok) {
        log(`git fetch failed: ${fetched.stderr}`);
      } else {
        const behind = await runGit(["rev-list", "--count", "HEAD..@{u}"]);
        if (behind.ok && Number(behind.stdout) > 0) {
          const pulled = await runGit(["pull", "--ff-only"]);
          if (!pulled.ok) log(`git pull --ff-only failed (left untouched): ${pulled.stderr}`);
        }
      }
    }
    const current = await head();
    if (!current || current === lastHead) return;
    const previous = lastHead;
    lastHead = current;
    const short = current.slice(0, 8);
    const diff = previous ? await runGit(["diff", "--name-only", previous, current]) : { ok: false, stdout: "", stderr: "" };
    if (!diff.ok) {
      log(`HEAD moved to ${short} (diff unavailable) → build+restart`);
      queuedBuild = true;
      queuedRestart = true;
      void drain();
      return;
    }
    const files = diff.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const action = applyRestartPolicy(planForPaths(files), options.restart);
    if (action === "ignore") {
      log(`HEAD moved to ${short} — ${files.length} file(s), nothing to rebuild`);
      return;
    }
    log(`HEAD moved to ${short} — ${files.length} file(s) → ${action}`);
    if (action === "build" || action === "build+restart") queuedBuild = true;
    if (action === "restart" || action === "build+restart") queuedRestart = true;
    void drain();
  } finally {
    gitBusy = false;
  }
}

async function startGitWatch(): Promise<void> {
  lastHead = await head();
  if (lastHead === null) {
    log("git mode disabled: not a git working copy (or git is unavailable)");
    return;
  }
  log(`git mode at ${lastHead.slice(0, 8)}, polling every ${Math.round(options.gitIntervalMs / 1000)}s${options.pull ? " with --ff-only pull" : " (read-only)"}`);
  gitTimer = setInterval(() => void pollGit(), options.gitIntervalMs);
}

// ---- lifecycle -----------------------------------------------------------

let signalled = false;

function onSignal(signal: NodeJS.Signals): void {
  if (signalled) {
    // Second Ctrl-C: take the process tree down immediately.
    if (child?.pid !== undefined) signalGroup(child.pid, "SIGKILL");
    process.exit(130);
  }
  signalled = true;
  shuttingDown = true;
  log(`${signal} — stopping server`);
  if (gitTimer) clearInterval(gitTimer);
  for (const watcher of watchers) watcher.close();
  void stopServer().then(() => process.exit(0));
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function main(): Promise<void> {
  log(`watching ${repositoryRoot}`);
  log(`mode=${options.watch} restart=${options.restart} port=${port}`);
  if (options.initialBuild) {
    const ok = await buildWeb();
    if (!ok && !existsSync(webDistIndex)) {
      log("initial build failed and there is no previous bundle — exiting");
      process.exit(1);
    }
  }
  // The server starts before the watchers so an early change can never race a
  // restart against the first spawn.
  startServer();
  if (options.watch === "fs" || options.watch === "both") startFsWatch();
  if (options.watch === "git" || options.watch === "both") await startGitWatch();
}

await main();
