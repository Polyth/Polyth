// Pure decision layer for the dev supervisor (scripts/supervisor.ts): what a
// changed path means, how a crash loop backs off, and how the CLI is parsed.
// Kept side-effect free so scripts/test/supervisorPlan.test.ts can cover it
// without spawning processes or touching the filesystem.

/** What the supervisor must do for a change. */
export type ChangeAction = "ignore" | "build" | "restart" | "build+restart";

/** Whether a web-only change also restarts the server. */
export type RestartPolicy = "auto" | "always";

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
  /** `auto` restarts only for server-side changes; `always` restarts for
   * every applied change. */
  restart: RestartPolicy;
  /** SIGTERM → SIGKILL grace period when stopping the server. */
  graceMs: number;
  /** Build the web bundles once before the first start. */
  initialBuild: boolean;
  /** Consecutive fast crashes tolerated before the supervisor stays down and
   * waits for the next change. */
  maxCrashes: number;
}

export const DEFAULT_OPTIONS: SupervisorOptions = {
  watch: "fs",
  gitIntervalMs: 10_000,
  pull: false,
  restart: "auto",
  graceMs: 5_000,
  initialBuild: true,
  maxCrashes: 5,
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

/** `always` upgrades a bundle-only change into a restart as well. */
export function applyRestartPolicy(action: ChangeAction, policy: RestartPolicy): ChangeAction {
  return policy === "always" && action === "build" ? "build+restart" : action;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff for the nth consecutive fast crash (1-based). */
export function backoffDelay(attempt: number): number {
  if (attempt <= 1) return BACKOFF_BASE_MS;
  const scaled = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Number.isFinite(scaled) ? Math.min(scaled, BACKOFF_MAX_MS) : BACKOFF_MAX_MS;
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
        if (raw !== "auto" && raw !== "always") {
          return { ok: false, error: `--restart expects auto or always (got "${raw}")` };
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
  --restart=auto|always   auto restarts only for server changes; always restarts
                          for bundle changes too (default: auto)
  --git-interval=<sec>    HEAD poll interval in git mode (default: 10)
  --pull                  git mode only: fetch and \`git pull --ff-only\` before
                          comparing (default: off, git stays read-only)
  --grace=<ms>            SIGTERM → SIGKILL grace period (default: 5000)
  --max-crashes=<n>       fast crashes before staying down (default: 5)
  --no-initial-build      start the server without building first
  -h, --help              show this help

Environment
  PORT, POLYTH_DATA_DIR and the rest of the environment pass through to the server.
`;
