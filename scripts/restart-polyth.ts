// Rebuild and restart the live Polyth server without losing it — safe to start
// from inside a Polyth session.
//
//   npm run polyth:restart [-- <flags>]        (flags: see USAGE)
//
// Why it detaches: the server drains every running agent turn before it exits,
// and the session that asked for the restart is one of those turns. A caller
// that waits for the restart waits for itself, and the supervisor's 30 s
// SIGKILL ends the stalemate by cutting every turn. So the launcher only
// schedules a worker in its own systemd unit and returns; the worker outlives
// the caller, the server and the supervisor.
//
// Worker pipeline — the live server is not touched before step 4:
//   1. build the web bundles; if that fails, put the previous bundles back
//   2. boot the working tree in an isolated beta, so a tree that cannot start
//      never reaches the live server
//   3. wait until no agent turn is running
//   4. SIGTERM the server child; the supervisor restarts it like a crash and the
//      server drains the turns running at SIGTERM before it exits. A drain
//      held by nothing visible gets 30 s, then SIGKILL (see waitForExit).
//   5. confirm the NEW process answers and the UI assets load
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- options and pure helpers ----------------------------------------------

export interface RestartOptions {
  /** Internal: run the pipeline in this process (the detached unit does). */
  worker: boolean;
  /** Restart the whole supervisor unit instead of only the server child. */
  full: boolean;
  /** Skip the idle wait and SIGKILL a server that has not drained in 30 s. */
  force: boolean;
  /** Skip the isolated boot test of the working tree. */
  skipCanary: boolean;
  /** How long to wait for agent turns to finish before refusing. */
  maxWaitMs: number;
}

export const DEFAULT_OPTIONS: RestartOptions = {
  worker: false,
  full: false,
  force: false,
  skipCanary: false,
  maxWaitMs: 15 * 60_000,
};

export const USAGE = `polyth restart — rebuild and restart the live Polyth server, safely

  npm run polyth:restart [-- <flags>]

Schedules a detached worker (systemd unit polyth-restart) and returns at once, so
it is safe to run from a Polyth session. If you are an agent: finish your turn —
a running turn holds the restart back. The server is not touched until the
bundles built and the working tree booted in an isolated beta.

Flags
  --max-wait=<sec>   wait this long for agent turns to finish, then refuse with the
                     server untouched (default: 900)
  --force            do not wait for agent turns; SIGKILL a server that has not
                     drained in 30 s. Interrupts running turns.
  --skip-canary      skip the isolated boot test of the working tree
  --full             restart the whole supervisor unit (use after changing
                     scripts/supervisor*.ts, the unit environment or Node)
  -h, --help         show this help

Progress  journalctl --user -fu polyth-restart -o cat
Outcome   cat "\${XDG_RUNTIME_DIR}/polyth-restart.result"
`;

export type ParseResult =
  | { ok: true; help: boolean; options: RestartOptions }
  | { ok: false; error: string };

/** Parse `--flag[=value]` arguments. Unknown flags fail loudly. */
export function parseRestartArgs(argv: readonly string[]): ParseResult {
  const options: RestartOptions = { ...DEFAULT_OPTIONS };
  let help = false;
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const raw = eq === -1 ? "" : arg.slice(eq + 1);
    switch (flag) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--worker":
        options.worker = true;
        break;
      case "--full":
        options.full = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--skip-canary":
        options.skipCanary = true;
        break;
      case "--max-wait": {
        const seconds = Number(raw);
        if (raw === "" || !Number.isFinite(seconds) || seconds <= 0) {
          return { ok: false, error: `--max-wait expects a positive number of seconds (got "${raw}")` };
        }
        options.maxWaitMs = Math.round(seconds * 1000);
        break;
      }
      default:
        return { ok: false, error: `unknown argument "${arg}" (try --help)` };
    }
  }
  return { ok: true, help, options };
}

/**
 * Poll `probe` until it yields a value `stable` times in a row or the deadline
 * passes. Time is injectable so the loop is testable without waiting.
 */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    stable?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T | undefined> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const stable = options.stable ?? 1;
  const deadline = now() + options.timeoutMs;
  let streak = 0;
  for (;;) {
    const value = await probe();
    streak = value === undefined ? 0 : streak + 1;
    if (value !== undefined && streak >= stable) return value;
    if (now() >= deadline) return undefined;
    await sleep(options.intervalMs);
  }
}

/** Everything a browser needs to boot the shell: the page, its entry script,
 *  the generation marker and each package module and stylesheet the manifest
 *  lists. A half-written dist is missing at least one of them. */
export function assetUrls(manifest: unknown): string[] {
  const urls = ["/", "/main.js", "/build-id.json"];
  const packages = (manifest as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages)) return urls;
  for (const entry of packages as { module?: unknown; styles?: unknown }[]) {
    if (typeof entry.module === "string") urls.push(entry.module);
    if (Array.isArray(entry.styles)) {
      for (const style of entry.styles) if (typeof style === "string") urls.push(style);
    }
  }
  return urls;
}

// ---- host deployment -------------------------------------------------------

/** Settings a newly created supervisor unit may carry. */
export const DEPLOYMENT_KEYS = [
  "HOST",
  "PORT",
  "POLYTH_PUBLIC_ORIGIN",
  "POLYTH_TRUSTED_PROXIES",
  "POLYTH_DEBUG_AGENT_ACCESS",
  "POLYTH_WEB_BUILD_FRESHNESS",
] as const;

/** `KEY=VALUE` lines of a deployment file; blank lines and `#` comments are
 *  skipped, one level of matching quotes is removed, unknown keys are ignored. */
export function parseDeploymentEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !(DEPLOYMENT_KEYS as readonly string[]).includes(match[1]!)) continue;
    values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** The worker runs in its own systemd unit, so it does not see the caller's
 *  shell: deployment settings come from the process environment, then from
 *  `$XDG_CONFIG_HOME/polyth/restart.env` (default `~/.config/polyth/restart.env`). */
function deploymentEnv(): Record<string, string> {
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "polyth", "restart.env");
  const values = existsSync(file) ? parseDeploymentEnv(readFileSync(file, "utf8")) : {};
  for (const key of DEPLOYMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== "") values[key] = value;
  }
  return values;
}

const repoRoot = resolve(import.meta.dirname, "..");
const supervisorUnit = process.env.POLYTH_RESTART_UNIT ?? "polyth-supervisor";
const workerUnit = "polyth-restart";
const deployment = deploymentEnv();
const port = Number(deployment.PORT ?? 4400);
const base = `http://127.0.0.1:${port}`;
/** Checked after the restart when the server is published behind a proxy. */
const publicOrigin = deployment.POLYTH_PUBLIC_ORIGIN ?? "";
const resultFile = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "polyth-restart.result");
/** What the supervisor unit is created with when it does not exist yet:
 *  loopback by default, published only when the deployment file says so. */
const unitEnv: Record<string, string> = {
  HOST: "127.0.0.1",
  POLYTH_WEB_BUILD_FRESHNESS: "1",
  ...deployment,
  PORT: String(port),
};
const BUILD_MAX_MS = 15 * 60_000;
/** The supervisor's own SIGTERM → SIGKILL grace (scripts/supervisorPlan.ts). */
const FORCE_GRACE_MS = 30_000;
const DRAIN_MAX_MS = 30 * 60_000;

// ---- plumbing --------------------------------------------------------------

class RestartError extends Error {}

function fail(message: string): never {
  throw new RestartError(message);
}

const log = (message: string): void => console.log(`[restart] ${message}`);
const run = (command: string, args: string[]) => spawnSync(command, args, { encoding: "utf8" });
const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
const unitProperty = (name: string): string =>
  systemctl("show", "--property", name, "--value", supervisorUnit).stdout.trim();
const writeResult = (text: string): void => {
  try {
    writeFileSync(resultFile, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // The journal still has the line.
  }
};

/** The server is the supervisor's only long-lived child. */
function serverPid(): number | undefined {
  const supervisor = Number(unitProperty("MainPID"));
  if (!supervisor) return undefined;
  const found = run("pgrep", ["-P", String(supervisor), "-f", "packages/server/src/index.ts"])
    .stdout.trim().split("\n")[0];
  return found ? Number(found) : undefined;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const healthy = async (): Promise<boolean> => {
  try {
    return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4_000) })).ok;
  } catch {
    return false;
  }
};

/** The child the abort handler must stop, and the bundles it must put back. */
let active: ChildProcess | undefined;
let inFlight: Snapshot | undefined;

const exitOf = (child: ChildProcess): Promise<number | null> =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode) return done(child.exitCode);
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
  });

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = exitOf(child);
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  await exited;
  clearTimeout(timer);
}

// ---- 1. build, with the previous bundles kept until it succeeds ------------

interface Snapshot {
  root: string;
  saved: { dir: string; copy: string }[];
}

/** The output directories the web build deletes and recreates in place: a
 *  failed build leaves them half-written under the running server. */
function bundleDirectories(): string[] {
  const packages = join(repoRoot, "packages");
  return [
    join(repoRoot, "apps/web/dist"),
    ...readdirSync(packages).map((name) => join(packages, name, "dist/web")),
  ].filter((dir) => existsSync(dir));
}

function snapshotBundles(): Snapshot {
  const root = join(repoRoot, ".scratch/restart-polyth", String(process.pid));
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const snapshot: Snapshot = { root, saved: [] };
  for (const [index, dir] of bundleDirectories().entries()) {
    // Hard links: instant, and safe because the build removes old files
    // instead of editing them.
    const copy = join(root, String(index));
    const result = run("cp", ["-al", dir, copy]);
    if (result.status !== 0) {
      dropSnapshot(snapshot);
      fail(`cannot snapshot ${dir}: ${result.stderr.trim()}`);
    }
    snapshot.saved.push({ dir, copy });
  }
  return snapshot;
}

function restoreBundles(snapshot: Snapshot): void {
  for (const { dir, copy } of snapshot.saved) {
    if (!existsSync(copy)) continue; // already restored (abort racing the build)
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(copy, dir);
  }
}

function dropSnapshot(snapshot: Snapshot): void {
  rmSync(snapshot.root, { recursive: true, force: true });
  try {
    rmdirSync(dirname(snapshot.root));
  } catch {
    // Another worker's snapshot, or already gone.
  }
}

async function buildBundles(): Promise<void> {
  const snapshot = snapshotBundles();
  inFlight = snapshot;
  log("building the web bundles (npm run build:web)");
  const build = spawn("npm", ["run", "build:web"], {
    cwd: repoRoot,
    stdio: "inherit",
    // Same bundle flavour the supervisor unit builds.
    env: { ...process.env, POLYTH_WEB_BUILD_FRESHNESS: unitEnv.POLYTH_WEB_BUILD_FRESHNESS },
  });
  active = build;
  const timer = setTimeout(() => build.kill("SIGKILL"), BUILD_MAX_MS);
  const code = await exitOf(build);
  clearTimeout(timer);
  active = undefined;
  inFlight = undefined;
  if (code !== 0) {
    restoreBundles(snapshot);
    dropSnapshot(snapshot);
    fail("the web build failed — previous bundles restored, server untouched");
  }
  dropSnapshot(snapshot);
}

// ---- 2. boot the working tree in an isolated beta --------------------------

async function bootCanary(): Promise<void> {
  log("boot test: starting the working tree in an isolated beta");
  // An empty project keeps the beta away from the real checkout.
  const project = mkdtempSync(join(tmpdir(), "polyth-restart-project-"));
  const beta = spawn(
    process.execPath,
    ["--experimental-strip-types", "scripts/agent-beta.ts", "--no-build", "--project", project],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] },
  );
  active = beta;
  try {
    await new Promise<void>((ready, failed) => {
      let output = "";
      const timer = setTimeout(() => failed(new Error("no ready signal within 150 s")), 150_000);
      beta.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        output += chunk.toString();
        if (/^POLYTH_AGENT_BETA_READY /m.test(output)) {
          clearTimeout(timer);
          ready();
        }
      });
      beta.once("exit", (code, signal) => {
        clearTimeout(timer);
        failed(new Error(`exited before it was ready (${signal ?? code})`));
      });
      beta.once("error", failed);
    });
  } catch (error) {
    fail(`boot test failed: ${(error as Error).message} — server untouched, details above`);
  } finally {
    await stop(beta);
    active = undefined;
    rmSync(project, { recursive: true, force: true });
  }
  log("boot test passed");
}

// ---- 3. wait until no agent turn is running --------------------------------

/** Sessions whose turn the server's shutdown would have to wait for. */
async function activeTurns(): Promise<string[]> {
  const getJson = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
    return await response.json() as T;
  };
  const list = async (status: string): Promise<string[]> =>
    (await getJson<{ sessions?: { session: { id: string } }[] }>(
      `/api/agent/sessions?status=${status}&limit=200&recentEvents=0`,
    )).sessions?.map((entry) => entry.session.id) ?? [];
  const ids = await list("working");
  for (const id of await list("waiting")) {
    // A question left open with no running turn does not hold the drain.
    const { debug } = await getJson<{ debug?: { runtime?: { activeTurn?: boolean } } }>(
      `/api/agent/sessions/${id}/debug`,
    );
    if (debug?.runtime?.activeTurn === true) ids.push(id);
  }
  return ids;
}

/** Resolves with how long it waited; refuses with the server untouched. */
async function waitForIdle(maxWaitMs: number): Promise<number> {
  const started = Date.now();
  let last: string[] = [];
  let loggedAt = 0;
  let errors = 0;
  const idle = await waitUntil(async () => {
    try {
      last = await activeTurns();
      errors = 0;
    } catch (error) {
      // One slow poll is not an answer; three in a row is.
      if (++errors >= 3) {
        fail(`cannot tell whether agent turns are running (${(error as Error).message}) — server untouched; --force restarts anyway`);
      }
      return undefined;
    }
    if (last.length === 0) return true;
    if (Date.now() - loggedAt >= 30_000) {
      loggedAt = Date.now();
      log(`waiting for ${last.length} running agent turn(s): ${last.map((id) => id.slice(0, 8)).join(", ")}`);
    }
    return undefined;
    // Two idle polls in a row: a queued message may start the next turn
    // right after one ends.
  }, { timeoutMs: maxWaitMs, intervalMs: 3_000, stable: 2 });
  if (!idle) {
    fail(`${last.length} agent turn(s) still running after ${Math.round(maxWaitMs / 1000)} s (${last.map((id) => id.slice(0, 8)).join(", ")}) — server untouched; finish or stop them, or use --force`);
  }
  return Date.now() - started;
}

// ---- 4. restart ------------------------------------------------------------

function restartSupervisorUnit(): void {
  const loaded = unitProperty("LoadState") === "loaded";
  const running = unitProperty("ActiveState") === "active";
  if (loaded) {
    log(`${running ? "restarting" : "starting"} ${supervisorUnit}`);
    const result = systemctl(running ? "restart" : "start", supervisorUnit);
    if (result.status !== 0) fail(`systemctl failed: ${result.stderr.trim()}`);
    return;
  }
  log(`${supervisorUnit} is not loaded — creating it`);
  const created = run("systemd-run", [
    "--user",
    `--unit=${supervisorUnit}`,
    "--property=Restart=on-failure",
    "--property=RestartSec=2s",
    `--working-directory=${repoRoot}`,
    "/usr/bin/env",
    ...Object.entries(unitEnv).map(([key, value]) => `${key}=${value}`),
    process.execPath,
    "--experimental-strip-types",
    "scripts/supervisor.ts",
    "--restart=never",
  ]);
  if (created.status !== 0) fail(`systemd-run failed: ${created.stderr.trim()}`);
}

/**
 * Wait for the draining server to exit. Only `heldBy` — the turns visible at
 * SIGTERM — are worth waiting for: the draining server admits no new turn, so
 * a session that looks busy later is a refused send, not work. The drain also
 * waits on turns the API never shows (a small-model task, a leg that never
 * sent idle) and those never end, so once `heldBy` is done the server gets
 * one grace period. A server that stays fenced refuses every turn, which is
 * an outage — the drain always ends in SIGKILL, never in leaving it fenced.
 */
async function waitForExit(pid: number, force: boolean, heldBy: readonly string[]): Promise<void> {
  const started = Date.now();
  let loggedAt = started;
  let waitingFor = force ? [] : [...heldBy];
  let graceFrom = waitingFor.length === 0 ? started : undefined;
  const gone = await waitUntil(async () => {
    if (!alive(pid)) return true;
    if (graceFrom === undefined) {
      // An unanswered poll keeps the turns we already know about.
      const ids = await activeTurns().catch(() => undefined);
      if (ids) waitingFor = waitingFor.filter((id) => ids.includes(id));
      if (waitingFor.length === 0) graceFrom = Date.now();
    }
    if (graceFrom !== undefined && Date.now() - graceFrom >= FORCE_GRACE_MS) return false;
    if (Date.now() - loggedAt >= 30_000) {
      loggedAt = Date.now();
      log(`server pid ${pid} is still draining${waitingFor.length ? ` (turns: ${waitingFor.map((id) => id.slice(0, 8)).join(", ")})` : ""}`);
    }
    return undefined;
  }, { timeoutMs: DRAIN_MAX_MS, intervalMs: 1_000 });
  if (gone) return;
  if (waitingFor.length > 0) {
    log(`server pid ${pid} still drains turn(s) ${waitingFor.map((id) => id.slice(0, 8)).join(", ")} after ${DRAIN_MAX_MS / 60_000} min — SIGKILL`);
  } else {
    log(`server pid ${pid} has no turn left to finish yet has not exited in ${FORCE_GRACE_MS / 1000} s — SIGKILL${force ? " (--force)" : ""}`);
  }
  try {
    process.kill(-pid, "SIGKILL"); // the supervisor starts the server as a group leader
  } catch {
    process.kill(pid, "SIGKILL");
  }
  await waitUntil(async () => (alive(pid) ? undefined : true), { timeoutMs: 10_000, intervalMs: 250 });
}

/** A different server process that answers: health from the old, draining
 *  process proves nothing. */
const awaitNewServer = (previous: number | undefined, timeoutMs: number): Promise<number | undefined> =>
  waitUntil(async () => {
    const pid = serverPid();
    return pid !== undefined && pid !== previous && await healthy() ? pid : undefined;
  }, { timeoutMs, intervalMs: 2_000 });

async function restartServer(options: RestartOptions): Promise<void> {
  const before = serverPid();
  let viaUnit: boolean;
  if (before === undefined || options.full || unitProperty("ActiveState") !== "active") {
    viaUnit = true;
    restartSupervisorUnit();
  } else {
    viaUnit = false;
    let heldBy: string[] = [];
    if (!options.force) {
      try {
        heldBy = await activeTurns();
      } catch (error) {
        fail(`cannot tell whether agent turns are running (${(error as Error).message}) — server untouched`);
      }
    }
    log(`stopping server pid ${before}: SIGTERM, it drains ${heldBy.length ? `turn(s) ${heldBy.map((id) => id.slice(0, 8)).join(", ")}` : "and exits"}`);
    process.kill(before, "SIGTERM");
    await waitForExit(before, options.force, heldBy);
  }
  let pid = await awaitNewServer(before, 180_000);
  if (pid === undefined && !viaUnit) {
    // Nothing is running any more, so a fresh supervisor costs nothing.
    log("the server did not come back — restarting the supervisor unit once");
    restartSupervisorUnit();
    pid = await awaitNewServer(before, 240_000);
  }
  if (pid === undefined) fail(`the server is not healthy after the restart — journalctl --user -u ${supervisorUnit} -n 80`);
  log(`server is up (pid ${before ?? "-"} → ${pid})`);
}

// ---- 5. verify what users load ---------------------------------------------

async function uiProblem(): Promise<string | undefined> {
  const get = async (path: string): Promise<{ problem?: string; body?: string }> => {
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
      return response.ok
        ? { body: await response.text() }
        : { problem: `${path} answered HTTP ${response.status}` };
    } catch (error) {
      return { problem: `${path} failed: ${(error as Error).message}` };
    }
  };
  const manifest = await get("/packages-manifest.json");
  if (manifest.problem) return manifest.problem;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.body ?? "");
  } catch {
    return "/packages-manifest.json is not JSON";
  }
  for (const path of assetUrls(parsed)) {
    const { problem } = await get(path);
    if (problem) return problem;
  }
  return undefined;
}

async function verifyUi(): Promise<void> {
  const problem = await uiProblem();
  if (!problem) return;
  // A concurrent watcher build can leave dist half-written; a rebuild heals it.
  log(`UI check failed (${problem}) — rebuilding the bundles once`);
  await buildBundles();
  const again = await uiProblem();
  if (again) fail(`UI check failed after a rebuild: ${again}`);
}

async function checkPublicSite(): Promise<void> {
  if (!publicOrigin) return;
  const answered = await waitUntil(async () => {
    try {
      return (await fetch(`${publicOrigin}/`, { signal: AbortSignal.timeout(8_000) })).ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, { timeoutMs: 60_000, intervalMs: 3_000 });
  // The proxy is not the server: report it, do not fail the restart.
  log(answered ? `public site ${publicOrigin} answers` : `WARNING: ${publicOrigin} did not answer within 60 s`);
}

// ---- entry points ----------------------------------------------------------

async function runWorker(options: RestartOptions): Promise<void> {
  // Without a running server there is nothing to protect or wait for.
  const protect = !options.force && unitProperty("ActiveState") === "active" && serverPid() !== undefined;
  await buildBundles();
  if (!options.skipCanary) await bootCanary();
  if (protect) {
    const waited = await waitForIdle(options.maxWaitMs);
    // The tree may have moved while we waited.
    if (waited > 60_000 && !options.skipCanary) await bootCanary();
  }
  const started = Date.now();
  await restartServer(options);
  await verifyUi();
  await checkPublicSite();
  const summary = `ok — restarted in ${Math.round((Date.now() - started) / 1000)} s`;
  log(`RESULT: ${summary}`);
  writeResult(summary);
}

function launch(argv: string[], options: RestartOptions): number {
  if (systemctl("show-environment").status !== 0) {
    console.error("A user systemd manager is not available.");
    return 1;
  }
  const result = run("systemd-run", [
    "--user",
    `--unit=${workerUnit}`,
    "--collect",
    "--quiet",
    "--property=MemoryMax=5G",
    "--property=MemorySwapMax=0",
    "--property=TasksMax=800",
    "--property=CPUQuota=250%",
    // Backstop above the longest legitimate wait.
    `--property=RuntimeMaxSec=${Math.round(options.maxWaitMs / 1000) + 3600}`,
    `--working-directory=${repoRoot}`,
    process.execPath,
    "--experimental-strip-types",
    fileURLToPath(import.meta.url),
    ...argv,
    "--worker",
  ]);
  if (result.status !== 0) {
    const text = (result.stderr || result.stdout).trim();
    console.error(/already|exists/i.test(text)
      ? `A restart is already running. Progress: journalctl --user -fu ${workerUnit} -o cat`
      : `Could not schedule the restart: ${text}`);
    return 1;
  }
  writeResult("scheduled");
  console.log(`Restart scheduled as ${workerUnit}.service, detached from this process.
It builds, boot-tests the working tree, waits until no agent turn is running, restarts the server and verifies it.
If you are an agent: finish your turn now — a running turn holds the restart back. Your session is idle during the restart and continues with the next message.
  progress: journalctl --user -fu ${workerUnit} -o cat
  outcome:  cat ${resultFile}`);
  return 0;
}

async function abort(signal: string): Promise<void> {
  log(`${signal} — aborting`);
  if (active) await stop(active);
  if (inFlight) {
    restoreBundles(inFlight);
    dropSnapshot(inFlight);
  }
  writeResult(`FAILED — aborted by ${signal}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseRestartArgs(argv);
  if (!parsed.ok) {
    console.error(`polyth restart: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!parsed.options.worker) process.exit(launch(argv, parsed.options));

  writeResult("running");
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void abort(signal));
  let code = 0;
  try {
    await runWorker(parsed.options);
  } catch (error) {
    const reason = error instanceof RestartError
      ? error.message
      : `unexpected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    log(`RESULT: FAILED — ${reason}`);
    writeResult(`FAILED — ${reason}`);
    code = 1;
  }
  process.exit(code); // idle keep-alive sockets must not hold the unit open
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
