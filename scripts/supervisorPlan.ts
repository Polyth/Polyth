// Pure decision layer for the dev supervisor (scripts/supervisor.ts): what a
// changed path means, how a crash loop backs off, and how the CLI is parsed.
// Kept side-effect free so scripts/test/supervisorPlan.test.ts can cover it
// without spawning processes or touching the filesystem.

/** What the supervisor must do for a change. */
export type ChangeAction = "ignore" | "build" | "restart" | "build+restart";

/** Whether a web-only change also restarts the server. */
export type RestartPolicy = "never" | "auto" | "always";

/** Change sources the supervisor can listen to. */
export type WatchMode = "fs" | "git" | "both";

export interface SupervisorOptions {
  /** Where changes come from: the working tree, new commits, or both. */
  watch: WatchMode;
  /** How often git mode re-reads HEAD. */
  gitIntervalMs: number;
  /** Opt-in `git fetch` + `git pull --ff-only` in git mode. Off by default:
   * this working copy is shared, so the supervisor never writes to git
   * unless asked. */
  pull: boolean;
  /** `never` restarts only after crashes; `auto` also restarts for server-side
   * changes; `always` restarts for every applied change. */
  restart: RestartPolicy;
  /** SIGTERM → SIGKILL grace period when stopping the server. */
  graceMs: number;
  /** Build the web bundles once before the first start. */
  initialBuild: boolean;
  /** Consecutive fast crashes tolerated before the supervisor stays down and
   * waits for the next change. */
  maxCrashes: number;
  /** How long a server that answered before may leave /api/health unanswered
   * before it is killed and restarted; `null` disables the watchdog. */
  livenessMs: number | null;
}

export const DEFAULT_OPTIONS: SupervisorOptions = {
  watch: "fs",
  gitIntervalMs: 10_000,
  pull: false,
  restart: "auto",
  // The server's bounded shutdown can spend up to 8s draining HTTP before it
  // closes harness runtimes, whose Linux authority waits up to 5s for a
  // descendant-empty release receipt. Ten seconds could therefore SIGKILL a
  // healthy shutdown between `.ready` and `.released`, permanently fencing
  // that session on the next boot. This cap affects only a wedged shutdown;
  // normal exits still return immediately.
  graceMs: 30_000,
  initialBuild: true,
  maxCrashes: 5,
  // Long enough that a slow but finite synchronous burst (a large history
  // read, a GC pause) recovers on its own; short enough to beat a fronting
  // proxy's repeated 504s by minutes.
  livenessMs: 60_000,
};

/** Directories that never contribute a change: build output, dependencies,
 * runtime state, and scratch space. */
const IGNORED_SEGMENTS = new Set([
  ".git",
  ".github",
  ".cursor",
  "node_modules",
  "dist",
  "release",
  "data",
  "artifacts",
  "logs",
  "_inbox",
  ".polyth-build-analysis",
]);

/** Extensions that can change what the server runs or the browser loads. */
const WATCHED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".js",
  ".mjs",
  ".json",
  ".svg",
]);

/** Top-level apps/web files that are build inputs rather than bundled source. */
const WEB_BUILD_FILES = new Set([
  "build.ts",
  "buildPackages.ts",
  "buildConfig.ts",
  "webPackages.ts",
  "sw.js",
  "manifest.json",
  "index.html",
]);

/** Editor scratch files and atomic-write temporaries. */
function isTransientFile(name: string): boolean {
  return name.startsWith(".")
    || name.startsWith("#")
    || name.endsWith("~")
    || name.endsWith(".swp")
    || name.endsWith(".swx")
    || name.includes(".tmp-")
    || name.includes(".tmp.");
}

/**
 * Map a repository-relative POSIX path to the work it requires.
 *
 * - `packages/<id>/src/**` runs through Node type stripping, so it needs a
 *   restart and no build.
 * - `packages/<id>/widgets/**` and `apps/web/src/**` are bundled, so they need
 *   a build; the server reads `dist` per request, so a restart is optional.
 * - A `package.json` can move a `polyth.webEntry`/`serverEntry`, so it needs
 *   both.
 */
export function classifyChange(relativePath: string): ChangeAction {
  const parts = relativePath.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return "ignore";
  for (const part of parts) {
    if (IGNORED_SEGMENTS.has(part)) return "ignore";
  }
  const name = parts[parts.length - 1] ?? "";
  if (isTransientFile(name)) return "ignore";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !WATCHED_EXTENSIONS.has(name.slice(dot))) return "ignore";

  const root = parts[0];
  if (parts.length === 1) {
    return root === "package.json" ? "build+restart" : "ignore";
  }

  if (root === "apps") {
    // Only the web app feeds the server's static output; desktop and mobile
    // shells are packaged separately.
    if (parts[1] !== "web") return "ignore";
    if (parts[2] === "src") return "build";
    if (parts.length === 3 && WEB_BUILD_FILES.has(parts[2] ?? "")) return "build";
    if (parts.length === 3 && parts[2] === "package.json") return "build+restart";
    return "ignore";
  }

  if (root === "packages") {
    if (parts.length < 3) return "ignore";
    const area = parts[2];
    if (parts.length > 3 && area === "widgets") return "build";
    if (parts.length > 3 && area === "src") return "restart";
    if (parts.length === 3 && area === "package.json") return "build+restart";
    return "ignore";
  }

  return "ignore";
}

function needsBuild(action: ChangeAction): boolean {
  return action === "build" || action === "build+restart";
}

function needsRestart(action: ChangeAction): boolean {
  return action === "restart" || action === "build+restart";
}

function toAction(build: boolean, restart: boolean): ChangeAction {
  if (build && restart) return "build+restart";
  if (build) return "build";
  if (restart) return "restart";
  return "ignore";
}

/** Union of two actions — a batch does the most work any member asked for. */
export function mergeActions(left: ChangeAction, right: ChangeAction): ChangeAction {
  return toAction(
    needsBuild(left) || needsBuild(right),
    needsRestart(left) || needsRestart(right),
  );
}

/** Union of a batch of paths. */
export function planForPaths(paths: Iterable<string>): ChangeAction {
  let action: ChangeAction = "ignore";
  for (const path of paths) {
    action = mergeActions(action, classifyChange(path));
    if (action === "build+restart") break;
  }
  return action;
}

/** Apply the change-triggered restart policy. Crash recovery is independent. */
export function applyRestartPolicy(action: ChangeAction, policy: RestartPolicy): ChangeAction {
  if (policy === "never") return needsBuild(action) ? "build" : "ignore";
  return policy === "always" && action === "build" ? "build+restart" : action;
}

// ---- filesystem reconciliation sweep ---------------------------------------
//
// `fs.watch` is the low-latency trigger, not the source of truth: inotify can
// silently drop events (queue overflow, a watch lost while its directory is
// replaced by a build, a recursive watch that stops reporting a subtree). A
// dropped event used to mean a change that never rebuilt anything and never
// said so. The sweep below re-reads a bounded signature map of the watched
// source roots on an interval, so any event the kernel dropped is still
// noticed — the watcher only decides *how fast* a change is seen.

/** A cheap change signature. ctime and inode close the common same-size,
 *  same-mtime holes left by editor replacements and timestamp restoration. */
export function fsSignature(stat: { mtimeMs: number; ctimeMs?: number; size: number; ino?: number }): string {
  return `${stat.mtimeMs}:${stat.ctimeMs ?? "?"}:${stat.size}:${stat.ino ?? "?"}`;
}

/** Directory names the sweep never descends into: build output, dependencies,
 *  runtime state and hidden bookkeeping. */
export function isSweepDirectory(name: string): boolean {
  return !name.startsWith(".") && !IGNORED_SEGMENTS.has(name);
}

/** Paths whose signature differs between two sweeps — added, removed or
 *  rewritten. Sorted for deterministic batches. */
export function changedPaths(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [path, signature] of next) {
    if (previous.get(path) !== signature) changed.push(path);
  }
  for (const path of previous.keys()) {
    if (!next.has(path)) changed.push(path);
  }
  return changed.sort();
}

/** One entry a sweep can see, without depending on node:fs. */
export interface SweepEntry {
  name: string;
  kind: "file" | "directory" | "other";
}

export interface SweepRoot {
  path: string;
  recursive: boolean;
}

/** The filesystem seam the sweep walks through, so the walk itself is testable
 *  without touching a real disk. */
export interface SweepFs {
  readdir(directory: string): SweepEntry[];
  stat(path: string): { mtimeMs: number; ctimeMs?: number; size: number; ino?: number } | null;
  join(directory: string, name: string): string;
  /** Repository-relative POSIX path, or null when the path escapes the root. */
  relative(path: string): string | null;
}

/** Read a signature for every file under the watched roots. Skipped
 *  directories, unreadable roots and files that vanish mid-walk are simply
 *  absent — the next sweep reports them. */
export function collectSweepSignatures(
  fs: SweepFs,
  roots: readonly SweepRoot[],
): Map<string, string> {
  const signatures = new Map<string, string>();
  const visit = (directory: string, recursive: boolean): void => {
    for (const entry of fs.readdir(directory)) {
      const absolute = fs.join(directory, entry.name);
      if (entry.kind === "directory") {
        if (recursive && isSweepDirectory(entry.name)) visit(absolute, true);
        continue;
      }
      if (entry.kind !== "file") continue;
      const relativePath = fs.relative(absolute);
      if (relativePath === null) continue;
      const stat = fs.stat(absolute);
      if (stat === null) continue;
      signatures.set(relativePath, fsSignature(stat));
    }
  };
  for (const root of roots) visit(root.path, root.recursive);
  return signatures;
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;

/** Exponential backoff for the nth consecutive fast crash (1-based). */
export function backoffDelay(attempt: number): number {
  if (attempt <= 1) return BACKOFF_BASE_MS;
  const scaled = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Number.isFinite(scaled) ? Math.min(scaled, BACKOFF_MAX_MS) : BACKOFF_MAX_MS;
}

// ---- liveness watchdog -----------------------------------------------------
// A crash is visible as a child exit; a server whose event loop is blocked is
// not. It keeps its PID and its listening socket, the kernel still accepts
// connections, and nothing answers. The watchdog probes /api/health and treats
// a server that has stopped answering for a whole window as wedged.

/** How often the supervisor probes the server. */
export const LIVENESS_PROBE_INTERVAL_MS = 5_000;
/** How long one probe may wait for any HTTP response. */
export const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

/** `response` is any HTTP status — the event loop ran the handler, which is
 * all liveness means. `unreachable` is a refused/reset connection: the
 * listener is gone (boot, or a graceful shutdown draining agent turns), which
 * is not a hang and must never be killed as one. */
export type ProbeOutcome = "response" | "timeout" | "unreachable";

export interface LivenessState {
  /** The child has answered at least once. A boot that is slow to listen or
   * runs long startup work is never treated as wedged. */
  armed: boolean;
  /** Start of the current uninterrupted run of timed-out probes. */
  unresponsiveSince: number | null;
}

export const INITIAL_LIVENESS: LivenessState = { armed: false, unresponsiveSince: null };

/** Fold one probe outcome into the state; `wedged` once timeouts have spanned
 * the whole window. */
export function nextLiveness(
  state: LivenessState,
  outcome: ProbeOutcome,
  startedAt: number,
  windowMs: number,
): { state: LivenessState; wedged: boolean; stalledMs: number } {
  if (outcome === "response") return { state: { armed: true, unresponsiveSince: null }, wedged: false, stalledMs: 0 };
  if (outcome === "unreachable" || !state.armed) {
    return { state: { armed: state.armed, unresponsiveSince: null }, wedged: false, stalledMs: 0 };
  }
  const since = state.unresponsiveSince ?? startedAt;
  // Measured to the end of this probe: the window is how long nothing answered.
  const stalledMs = startedAt + LIVENESS_PROBE_TIMEOUT_MS - since;
  return { state: { armed: true, unresponsiveSince: since }, wedged: stalledMs >= windowMs, stalledMs };
}

/** Where to probe: the bound host unless it is a wildcard. */
export function livenessProbeHost(bindHost: string | undefined): string {
  const host = bindHost?.trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export type ParseResult =
  | { ok: true; help: boolean; options: SupervisorOptions }
  | { ok: false; error: string };

function parsePositiveNumber(raw: string, flag: string): number | string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return `${flag} expects a positive number (got "${raw}")`;
  return value;
}

/** Parse `--flag=value` style arguments. Unknown flags fail loudly rather
 * than being silently ignored. */
export function parseSupervisorArgs(argv: readonly string[]): ParseResult {
  const options: SupervisorOptions = { ...DEFAULT_OPTIONS };
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const raw = eq === -1 ? "" : arg.slice(eq + 1);
    switch (flag) {
      case "--watch": {
        if (raw !== "fs" && raw !== "git" && raw !== "both") {
          return { ok: false, error: `--watch expects fs, git, or both (got "${raw}")` };
        }
        options.watch = raw;
        break;
      }
      case "--restart": {
        if (raw !== "never" && raw !== "auto" && raw !== "always") {
          return { ok: false, error: `--restart expects never, auto, or always (got "${raw}")` };
        }
        options.restart = raw;
        break;
      }
      case "--git-interval": {
        const seconds = parsePositiveNumber(raw, "--git-interval");
        if (typeof seconds === "string") return { ok: false, error: seconds };
        options.gitIntervalMs = Math.round(seconds * 1000);
        break;
      }
      case "--grace": {
        const ms = parsePositiveNumber(raw, "--grace");
        if (typeof ms === "string") return { ok: false, error: ms };
        options.graceMs = Math.round(ms);
        break;
      }
      case "--max-crashes": {
        const count = parsePositiveNumber(raw, "--max-crashes");
        if (typeof count === "string") return { ok: false, error: count };
        options.maxCrashes = Math.round(count);
        break;
      }
      case "--liveness": {
        if (raw === "off") {
          options.livenessMs = null;
          break;
        }
        const seconds = parsePositiveNumber(raw, "--liveness");
        if (typeof seconds === "string") return { ok: false, error: `${seconds}; or "off"` };
        if (seconds * 1000 < LIVENESS_PROBE_INTERVAL_MS + LIVENESS_PROBE_TIMEOUT_MS) {
          return { ok: false, error: `--liveness must be at least ${(LIVENESS_PROBE_INTERVAL_MS + LIVENESS_PROBE_TIMEOUT_MS) / 1000} seconds (got "${raw}")` };
        }
        options.livenessMs = Math.round(seconds * 1000);
        break;
      }
      case "--pull": {
        options.pull = true;
        break;
      }
      case "--no-initial-build": {
        options.initialBuild = false;
        break;
      }
      default:
        return { ok: false, error: `unknown argument "${arg}" (try --help)` };
    }
  }
  if (options.pull && options.watch === "fs") {
    return { ok: false, error: "--pull requires --watch=git or --watch=both" };
  }
  return { ok: true, help, options };
}

export const USAGE = `polyth supervisor — rebuild and restart the server on change, keep it alive

  npm run watch [-- <flags>]

Flags
  --watch=fs|git|both     change source: working tree, new commits, or both (default: fs)
  --restart=never|auto|always
                          never restarts for changes (crash recovery stays on);
                          auto restarts server changes; always restarts bundle changes too
                          (default: auto)
  --git-interval=<sec>    HEAD poll interval in git mode (default: 10)
  --pull                  git mode only: fetch and \`git pull --ff-only\` before
                          comparing (default: off, git stays read-only)
  --grace=<ms>            SIGTERM → SIGKILL grace period (default: 30000)
  --max-crashes=<n>       fast crashes before staying down (default: 5)
  --liveness=<sec>|off    kill and restart a server that answered before but has
                          left /api/health unanswered this long (default: 60)
  --no-initial-build      start the server without building first
  -h, --help              show this help

Environment
  PORT, POLYTH_DATA_DIR and the rest of the environment pass through to the server.
`;
