// Which Polyth the CLI talks to, and how.
//
// - `socket`: the server's filesystem-protected control socket in its data
//   directory (a server checkout, Docker volume, or Polyth Desktop). No
//   credential: possession of the socket is the authority, and the server
//   limits it to health/discovery outside the single-operator profile.
// - `http`: a URL, with a bearer token from `polyth login`/an automation
//   token, or with no token when the owner enabled the no-token CLI mode.
//
// Saved targets live in one user-private JSON file (0600 in a 0700 dir). The
// token is a credential: it is never printed, logged or put on argv.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Target =
  | { kind: "socket"; name: string; dataDir: string; socketPath: string; source: string }
  | { kind: "http"; name: string; url: string; token?: string; space?: string; source: string };

export interface SavedTarget {
  url?: string;
  dataDir?: string;
  token?: string;
  space?: string;
}

export interface CliConfig {
  current?: string;
  targets: Record<string, SavedTarget>;
}

/** Same derivation as the server (`indexCore.ts`): a Unix socket in the data
 *  directory, or a named pipe keyed by the data directory on Windows. */
export function controlSocketPath(dataDir: string, os: NodeJS.Platform = platform()): string {
  const absolute = resolve(dataDir);
  return os === "win32"
    ? `\\\\.\\pipe\\polyth-control-${createHash("sha256").update(absolute).digest("hex").slice(0, 12)}`
    : join(absolute, "control.sock");
}

/** Polyth Desktop's data directory (Electron `userData` for product "Polyth"). */
export function desktopDataDir(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = platform()): string {
  if (env.POLYTH_DESKTOP_USER_DATA) return join(resolve(env.POLYTH_DESKTOP_USER_DATA), "data");
  if (os === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Polyth", "data");
  if (os === "darwin") return join(homedir(), "Library", "Application Support", "Polyth", "data");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Polyth", "data");
}

export function configPath(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = platform()): string {
  if (env.POLYTH_CLI_CONFIG) return resolve(env.POLYTH_CLI_CONFIG);
  if (os === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Polyth", "cli.json");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "polyth", "cli.json");
}

export function readConfig(path = configPath()): CliConfig {
  if (!existsSync(path)) return { targets: {} };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it`);
  }
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<CliConfig>;
  const targets: Record<string, SavedTarget> = {};
  for (const [name, target] of Object.entries(value.targets ?? {})) {
    if (!target || typeof target !== "object") continue;
    const t = target as SavedTarget;
    targets[name] = {
      ...(typeof t.url === "string" ? { url: t.url } : {}),
      ...(typeof t.dataDir === "string" ? { dataDir: t.dataDir } : {}),
      ...(typeof t.token === "string" ? { token: t.token } : {}),
      ...(typeof t.space === "string" ? { space: t.space } : {}),
    };
  }
  return { ...(typeof value.current === "string" ? { current: value.current } : {}), targets };
}

export function writeConfig(config: CliConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (platform() !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) URLs are supported");
  if (url.username || url.password) throw new Error("credentials do not belong in the URL");
  return url.origin;
}

const socketExists = (path: string): boolean => {
  if (path.startsWith("\\\\.\\pipe\\")) return true; // Pipes cannot be stat'ed; the connect decides.
  try { return statSync(path).isSocket(); } catch { return false; }
};

/** A server checkout the CLI runs from (packages/cli inside the repo). */
export function repoRoot(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "..", "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "polyth" ? root : undefined;
  } catch {
    return undefined;
  }
}

function socketTarget(name: string, dataDir: string, source: string): Target {
  const absolute = resolve(dataDir);
  return { kind: "socket", name, dataDir: absolute, socketPath: controlSocketPath(absolute), source };
}

function savedTarget(name: string, saved: SavedTarget, source: string, env: NodeJS.ProcessEnv): Target {
  if (saved.dataDir) return socketTarget(name, saved.dataDir, source);
  if (!saved.url) throw new Error(`target "${name}" has neither a url nor a data directory`);
  const token = env.POLYTH_TOKEN || saved.token;
  return {
    kind: "http", name, url: normalizeUrl(saved.url), source,
    ...(token ? { token } : {}),
    ...(saved.space ? { space: saved.space } : {}),
  };
}

export interface ResolveOptions {
  url?: string;
  target?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  config?: CliConfig;
  cwd?: string;
}

/**
 * Precedence: explicit flags, then environment, then the saved current
 * target, then discovery (a data directory here or in this checkout, then
 * Polyth Desktop). Discovery only picks sockets that exist.
 */
export function resolveTarget(opts: ResolveOptions = {}): Target {
  const env = opts.env ?? process.env;
  const config = opts.config ?? readConfig();
  const url = opts.url ?? env.POLYTH_URL;
  if (url) {
    const origin = normalizeUrl(url);
    const saved = Object.entries(config.targets).find(([, t]) => t.url && normalizeUrl(t.url) === origin);
    const token = env.POLYTH_TOKEN || saved?.[1].token;
    return {
      kind: "http", name: saved?.[0] ?? origin, url: origin, source: opts.url ? "--url" : "POLYTH_URL",
      ...(token ? { token } : {}),
      ...(saved?.[1].space ? { space: saved[1].space } : {}),
    };
  }
  const named = opts.target ?? env.POLYTH_TARGET;
  if (named) {
    if (named === "desktop") return socketTarget("desktop", desktopDataDir(env), "--target");
    const saved = config.targets[named];
    if (!saved) throw new Error(`no saved target "${named}"; see \`polyth target ls\``);
    return savedTarget(named, saved, opts.target ? "--target" : "POLYTH_TARGET", env);
  }
  const dataDir = opts.dataDir ?? env.POLYTH_DATA_DIR;
  if (dataDir) return socketTarget("local", dataDir, opts.dataDir ? "--data-dir" : "POLYTH_DATA_DIR");
  if (env.POLYTH_CONTROL_SOCKET) {
    return { kind: "socket", name: "local", dataDir: "", socketPath: env.POLYTH_CONTROL_SOCKET, source: "POLYTH_CONTROL_SOCKET" };
  }
  if (config.current && config.targets[config.current]) {
    return savedTarget(config.current, config.targets[config.current]!, "saved default", env);
  }
  const candidates: Array<[string, string, string]> = [];
  const cwd = opts.cwd ?? process.cwd();
  candidates.push(["local", join(cwd, "data"), "./data"]);
  const root = repoRoot();
  if (root) candidates.push(["local", join(root, "data"), "this checkout"]);
  candidates.push(["desktop", desktopDataDir(env), "Polyth Desktop"]);
  for (const [name, dir, source] of candidates) {
    const target = socketTarget(name, dir, source);
    if (target.kind === "socket" && !target.socketPath.startsWith("\\\\.\\pipe\\") && socketExists(target.socketPath)) return target;
  }
  // Windows pipes cannot be probed without connecting; prefer Desktop there.
  if (platform() === "win32") return socketTarget("desktop", desktopDataDir(env), "Polyth Desktop");
  throw new Error(
    "No Polyth found. Run inside a server checkout, start Polyth Desktop, or sign in to a server with `polyth login <url>`.",
  );
}

export function describeTarget(target: Target): string {
  return target.kind === "socket"
    ? `${target.name} (control socket ${target.socketPath})`
    : `${target.name} (${target.url}${target.token ? ", token" : ", no token"})`;
}
