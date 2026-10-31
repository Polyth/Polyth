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
import { existsSync, readdirSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { relative, resolve, sep } from "node:path";
import {
  applyRestartPolicy,
  backoffDelay,
  changedPaths,
  classifyChange,
  collectSweepSignatures,
  fsSignature,
  INITIAL_LIVENESS,
  LIVENESS_PROBE_INTERVAL_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  livenessProbeHost,
  mergeActions,
  nextLiveness,
  parseSupervisorArgs,
  planForPaths,
  USAGE,
  type ChangeAction,
  type LivenessState,
  type ProbeOutcome,
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
/** How often the reconciliation sweep re-reads the watched source roots. The
 *  watcher stays the low-latency trigger; the sweep is what makes a dropped
 *  inotify event recoverable instead of silent. */
const SWEEP_MS = 2_000;
/** Delay before a watcher that reported an error is re-armed. */
const WATCH_REARM_MS = 1_000;
/** A process that survives this long is treated as a healthy start, so the
 * next crash begins a fresh backoff sequence. */
const STABLE_UPTIME_MS = 15_000;
/** A build that stops producing output for this long is wedged. */
const BUILD_STALL_MS = 120_000;
/** Absolute ceiling for a build that never stops emitting output. */
const BUILD_MAX_MS = 900_000;
/** How long to wait for the old process to release the port. */
const PORT_FREE_TIMEOUT_MS = 5_000;

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

/** Signal the child's whole process group when forced cleanup is required. */
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
  liveness = INITIAL_LIVENESS;
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

async function stopServer(forceAfterMs: number | null = options.graceMs): Promise<void> {
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
  // Planned reloads let the server drain active agent turns for as long as
  // needed. Explicit supervisor shutdown still keeps the configured escape
  // hatch, and a second Ctrl-C always kills the complete process group.
  target.kill("SIGTERM");
  const force = forceAfterMs === null ? null : setTimeout(() => {
    log(`server did not stop in ${options.graceMs}ms — sending SIGKILL`);
    signalGroup(target.pid!, "SIGKILL");
  }, forceAfterMs);
  await exited;
  if (force) clearTimeout(force);
  child = null;
  stopping = false;
  await waitForPortFree();
}

async function restartServer(): Promise<void> {
  await stopServer(null);
  if (shuttingDown) return;
  consecutiveCrashes = 0;
  down = false;
  startServer();
}

// ---- liveness watchdog ---------------------------------------------------
// Exit-based restarts cannot see a server whose event loop is blocked: the
// process stays up, the kernel keeps accepting connections and every request
// hangs until a fronting proxy answers 504. See supervisorPlan.nextLiveness.

const probeHost = livenessProbeHost(process.env.HOST);
let liveness: LivenessState = INITIAL_LIVENESS;
let livenessTimer: NodeJS.Timeout | null = null;
let probing = false;

/** Any HTTP response counts as alive: the status says nothing about whether
 * the event loop is running, the response itself does. */
function probeHealth(): Promise<ProbeOutcome> {
  return new Promise((done) => {
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      request.destroy();
      done(outcome);
    };
    const request = httpRequest(
      { host: probeHost, port, path: "/api/health", method: "GET", agent: false },
      (response) => {
        response.resume();
        finish("response");
      },
    );
    request.setTimeout(LIVENESS_PROBE_TIMEOUT_MS, () => finish("timeout"));
    request.once("error", () => finish("unreachable"));
    request.end();
  });
}

async function checkLiveness(): Promise<void> {
  const windowMs = options.livenessMs;
  const target = child;
  if (windowMs === null || probing || shuttingDown || stopping || !target || target.pid === undefined) return;
  probing = true;
  try {
    const startedAt = Date.now();
    const outcome = await probeHealth();
    // The child may have exited or been replaced while the probe waited.
    if (target !== child || stopping || shuttingDown) return;
    const wasArmed = liveness.armed;
    const verdict = nextLiveness(liveness, outcome, startedAt, windowMs);
    liveness = verdict.state;
    if (!wasArmed && liveness.armed) log(`server answering on ${probeHost}:${port} — liveness watchdog armed (${windowMs / 1000}s)`);
    if (!verdict.wedged) return;
    // A blocked event loop never runs a SIGTERM handler, so a graceful stop
    // cannot work. SIGKILL only the server PID — the same thing as a crash:
    // owned runtimes keep their own containment and the next boot reconciles
    // them, and the exit handler restarts with the normal crash backoff.
    log(`server unresponsive for ${Math.round(verdict.stalledMs / 1000)}s (pid ${target.pid}) — event loop presumed blocked, sending SIGKILL`);
    try {
      process.kill(target.pid, "SIGKILL");
    } catch {
      // Already gone; the exit handler takes it from here.
    }
  } finally {
    probing = false;
  }
}

function startLivenessWatchdog(): void {
  if (options.livenessMs === null) {
    log("liveness watchdog off");
    return;
  }
  livenessTimer = setInterval(() => void checkLiveness(), LIVENESS_PROBE_INTERVAL_MS);
  livenessTimer.unref?.();
}

// ---- build ---------------------------------------------------------------

/** Run a repo script with type stripping, capturing output so a successful
 * build stays a single line and a failure shows everything. */
function runNode(scriptPath: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      // Development/watch builds change generation frequently. Auto freshness
      // reload on resume is disruptive here, so keep it off unless the operator
      // explicitly opts back in for this supervisor process.
      env: {
        ...process.env,
        POLYTH_WEB_BUILD_FRESHNESS: process.env.POLYTH_WEB_BUILD_FRESHNESS ?? "0",
      },
    });
    let output = "";
    // The watchdog is a *stall* detector, not a duration cap: a large worktree
    // can legitimately spend minutes building, and killing it on total duration
    // turns a slow build into a false "build failed". An absolute ceiling still
    // bounds a build that never stops printing.
    let stallTimer: NodeJS.Timeout | null = null;
    const armStallWatchdog = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        output += `\nbuild produced no output for ${BUILD_STALL_MS}ms — killed\n`;
        proc.kill("SIGKILL");
      }, BUILD_STALL_MS);
      stallTimer.unref?.();
    };
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      armStallWatchdog();
    };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);
    armStallWatchdog();
    const maxTimer = setTimeout(() => {
      output += `\nbuild exceeded ${BUILD_MAX_MS}ms — killed\n`;
      proc.kill("SIGKILL");
    }, BUILD_MAX_MS);
    maxTimer.unref?.();
    const stopWatchdogs = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(maxTimer);
    };
    proc.once("error", (error) => {
      stopWatchdogs();
      done({ ok: false, output: `${output}${String(error)}\n` });
    });
    proc.once("close", (code) => {
      stopWatchdogs();
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
let sweepPaths = new Set<string>();
let debounceTimer: NodeJS.Timeout | null = null;
let draining = false;
let queuedBuild = false;
let queuedRestart = false;

function describe(paths: Set<string>): string {
  const [first] = paths;
  const rest = paths.size - 1;
  return rest > 0 ? `${first ?? "?"} (+${rest} more)` : (first ?? "?");
}

function noteChange(relativePath: string, action: ChangeAction, fromSweep = false): void {
  if (action === "ignore") return;
  pending = mergeActions(pending, action);
  pendingPaths.add(relativePath);
  if (fromSweep) sweepPaths.add(relativePath);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
}

function flushPending(): void {
  debounceTimer = null;
  const action = pending;
  const paths = pendingPaths;
  const reconciled = sweepPaths;
  pending = "ignore";
  pendingPaths = new Set();
  sweepPaths = new Set();
  if (action === "ignore") return;
  // A sweep-caught batch means inotify dropped the event: say so, because the
  // watcher looked healthy while the change was invisible.
  const source = reconciled.size > 0 ? " (reconciled by sweep)" : "";
  log(`change: ${describe(paths)} → ${action}${source}`);
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
      // request) unless the server is down or the policy asks for one.
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
interface WatchRoot {
  path: string;
  recursive: boolean;
}
/** Every root the fs watchers cover, so the sweep reconciles the same set even
 *  when a watcher itself failed to attach. */
const watchedRoots: WatchRoot[] = [];
/** Last known signature per watched file (see supervisorPlan.fsSignature). */
const fsSignatures = new Map<string, string>();
let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

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
  recordWatchRoot(directory, recursive);
  try {
    const watcher = watch(directory, { recursive }, (_event, filename) => {
      if (!filename) return;
      const relativePath = repositoryRelative(directory, filename.toString());
      if (relativePath === null) return;
      // Keep the sweep's snapshot aligned: the watcher already owns this
      // change, so the reconciliation pass must not report it a second time.
      rememberSignature(relativePath);
      onStructureChanged(relativePath.split("/"));
      noteChange(relativePath, applyRestartPolicy(classifyChange(relativePath), options.restart));
    });
    watchedDirectories.add(directory);
    watchers.push(watcher);
    watcher.on("error", (error) => {
      // A watcher that dies reports nothing and still looks attached. Drop it,
      // keep the root in the sweep, and re-arm it; the sweep covers the gap.
      log(`watch error on ${relative(repositoryRoot, directory)}: ${String(error)} — re-arming`);
      dropWatcher(watcher);
      watchedDirectories.delete(directory);
      const timer = setTimeout(() => watchDirectory(directory, recursive), WATCH_REARM_MS);
      timer.unref?.();
    });
  } catch (error) {
    log(`cannot watch ${relative(repositoryRoot, directory)}: ${String(error)}`);
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      log("hint: raise fs.inotify.max_user_watches");
    }
  }
}

function dropWatcher(watcher: FSWatcher): void {
  watcher.close();
  const index = watchers.indexOf(watcher);
  if (index >= 0) watchers.splice(index, 1);
}

function repositoryRelative(directory: string, name: string): string | null {
  return repositoryRelativePath(resolve(directory, name));
}

function repositoryRelativePath(absolute: string): string | null {
  const relativePath = relative(repositoryRoot, absolute).split(sep).join("/");
  if (relativePath.length === 0 || relativePath.startsWith("..")) return null;
  return relativePath;
}

function recordWatchRoot(directory: string, recursive: boolean): void {
  if (watchedRoots.some((root) => root.path === directory)) return;
  watchedRoots.push({ path: directory, recursive });
}

/** Refresh one path's sweep signature synchronously, so the sweep can never
 *  re-report what the watcher just handled. */
function rememberSignature(relativePath: string): void {
  try {
    const stats = statSync(resolve(repositoryRoot, relativePath));
    if (stats.isFile()) fsSignatures.set(relativePath, fsSignature(stats));
    else fsSignatures.delete(relativePath);
  } catch {
    fsSignatures.delete(relativePath);
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
  startSweep();
  log(`watching ${watchedDirectories.size} source directories`);
}

/**
 * Reconcile the watched roots against a signature map on an interval.
 *
 * inotify is allowed to drop events (queue overflow, a lost watch while a
 * directory is replaced, a recursive watch that stops reporting a subtree),
 * and when it does the change is invisible: nothing rebuilds and nothing is
 * logged. The sweep is the safety net — the watcher decides how fast a change
 * is noticed, the sweep guarantees it is noticed at all.
 */
function startSweep(): void {
  if (sweepTimer) return;
  fsSignatures.clear();
  for (const [path, signature] of collectSignatures()) fsSignatures.set(path, signature);
  sweepTimer = setInterval(sweepFilesystem, SWEEP_MS);
  sweepTimer.unref?.();
}

function collectSignatures(): Map<string, string> {
  return collectSweepSignatures(
    {
      readdir: (directory) => {
        try {
          return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory() ? "directory" as const : entry.isFile() ? "file" as const : "other" as const,
          }));
        } catch {
          return []; // a root removed since it was recorded is a deletion
        }
      },
      stat: (path) => {
        try {
          const stats = statSync(path);
          return { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, ino: stats.ino };
        } catch {
          return null; // removed between readdir and stat: the next sweep sees it
        }
      },
      join: (directory, name) => resolve(directory, name),
      relative: (path) => repositoryRelativePath(path),
    },
    watchedRoots,
  );
}

function sweepFilesystem(): void {
  if (sweeping || shuttingDown || watchedRoots.length === 0) return;
  sweeping = true;
  try {
    const next = collectSignatures();
    const changed = changedPaths(fsSignatures, next);
    fsSignatures.clear();
    for (const [path, signature] of next) fsSignatures.set(path, signature);
    for (const path of changed) {
      noteChange(path, applyRestartPolicy(classifyChange(path), options.restart), true);
    }
  } finally {
    sweeping = false;
  }
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
  if (livenessTimer) clearInterval(livenessTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
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
  startLivenessWatchdog();
  if (options.watch === "fs" || options.watch === "both") startFsWatch();
  if (options.watch === "git" || options.watch === "both") await startGitWatch();
}

await main();
