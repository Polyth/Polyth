// Locating an external CLI for a Polyth server that did not inherit the user's
// shell PATH.
//
// Polyth shells out to system tools (`git`, `gh`, `glab`, `ssh`) and launches
// the agent harness CLIs. A server started from a desktop launcher, an
// AppImage, a systemd unit or launchd inherits a minimal PATH, so a PATH-only
// lookup fails on a machine where the tool runs fine in a terminal — and the
// user sees the failure as "not a Git repository", a missing `gh`, or an
// unusable SSH remote with no explanation. Resolution therefore widens from
// cheapest to most specific:
//   1. an explicit binary from the caller,
//   2. an environment override (for example `POLYTH_GIT_BIN`),
//   3. the name on the inherited PATH,
//   4. well-known install locations for the platform and the named tool,
//   5. the bare name, preserving the previous PATH-only behaviour so the
//      caller can report exactly what it looked for.
//
// This module is dependency-free (Node built-ins only) so any server package
// can reach it without pulling in a feature package, and it is never imported
// by browser code.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, posix, win32 } from "node:path";

/** Path joining that follows the *target* platform, not the host running the
 *  test. A darwin/linux lookup on a Windows host must still produce `/a/b`. */
const joinFor = (platform: NodeJS.Platform) => platform === "win32" ? win32.join : posix.join;
const dirnameFor = (platform: NodeJS.Platform) => platform === "win32" ? win32.dirname : posix.dirname;
const isAbsoluteFor = (platform: NodeJS.Platform) => platform === "win32" ? win32.isAbsolute : posix.isAbsolute;

/** Environment override honoured for the `git` executable. One name every call
 *  site agrees on, so `POLYTH_GIT_BIN` works wherever Polyth shells out to git. */
export const GIT_BINARY_ENV = "POLYTH_GIT_BIN";

export interface ExecutableLookupOptions {
  /** Explicit path or command name; wins over the environment and discovery. */
  explicit?: string;
  /** Environment variable holding an override path, e.g. `POLYTH_GIT_BIN`. */
  overrideEnv?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injected for tests; production resolves the user's real home. */
  home?: string;
  /** Extra directories checked after PATH, before the well-known locations. */
  extraDirectories?: readonly string[];
  /** Injectable existence check (defaults to `fs.existsSync`); tests only. */
  isFile?: (path: string) => boolean;
  /** Injectable directory listing of immediate child names; tests only. */
  listDir?: (path: string) => string[];
}

/** Windows environment names are case-insensitive; a plain object passed by a
 *  test is not, so match exactly first and then case-insensitively. */
const envVar = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === wanted) return env[key];
  return undefined;
};

const splitPath = (value: string | undefined, platform: NodeJS.Platform): string[] =>
  (value ?? "")
    .split(platform === "win32" ? win32.delimiter : posix.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

const resolveHome = (options: ExecutableLookupOptions, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string => {
  const candidate = options.home ?? (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME);
  if (candidate?.trim()) return candidate.trim();
  try {
    return homedir();
  } catch {
    return "";
  }
};

/** Candidate file names for `name` on the platform: Windows resolves `PATHEXT`. */
const executableNames = (name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => {
  if (platform !== "win32" || extname(name)) return [name];
  const extensions = (envVar(env, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return extensions.map((extension) => `${name}${extension.startsWith(".") ? extension : `.${extension}`}`);
};

const directoryOf = (path: string, platform: NodeJS.Platform): string | undefined => {
  if (!path) return undefined;
  return isAbsoluteFor(platform)(path) ? dirnameFor(platform)(path) : undefined;
};

/**
 * Directories where a named tool commonly lands and that the inherited PATH
 * often omits. Shared user-level locations first, then the vendor install
 * directories for the tool itself.
 */
export const wellKnownExecutableDirectories = (
  name: string,
  options: ExecutableLookupOptions = {},
): string[] => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const join = joinFor(platform);
  const home = resolveHome(options, env, platform);
  const under = (...segments: string[]): string | undefined => home ? join(home, ...segments) : undefined;

  const shared: Array<string | undefined> = platform === "win32"
    ? [
      under(".local", "bin"),
      under(".bun", "bin"),
      envVar(env, "APPDATA") ? join(envVar(env, "APPDATA")!, "npm") : undefined,
      envVar(env, "LOCALAPPDATA") ? join(envVar(env, "LOCALAPPDATA")!, "pnpm") : undefined,
      join(envVar(env, "ProgramFiles")?.trim() ?? "C:\\Program Files", "nodejs"),
      under("scoop", "shims"),
      join(envVar(env, "ProgramData")?.trim() ?? "C:\\ProgramData", "chocolatey", "bin"),
      envVar(env, "LOCALAPPDATA") ? join(envVar(env, "LOCALAPPDATA")!, "Microsoft", "WindowsApps") : undefined,
    ]
    : [
      under(".local", "bin"),
      under(".bun", "bin"),
      under(".npm-global", "bin"),
      under(".local", "share", "pnpm"),
      under(".volta", "bin"),
      under("bin"),
      "/opt/homebrew/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/snap/bin",
    ];

  return [...shared, ...vendorDirectories(name, options, env, platform)]
    .filter((entry): entry is string => Boolean(entry));
};

/** Vendor install directories that are specific to one tool. */
const vendorDirectories = (
  name: string,
  options: ExecutableLookupOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] => {
  const join = joinFor(platform);
  if (platform === "win32") {
    const roots = [envVar(env, "ProgramFiles"), envVar(env, "ProgramW6432"), envVar(env, "ProgramFiles(x86)")]
      .map((root) => root?.trim())
      .filter((root): root is string => Boolean(root));
    const underProgramFiles = (...segments: string[]): string[] => roots.map((root) => join(root, ...segments));
    switch (name) {
      case "git":
        return [
          ...underProgramFiles("Git", "cmd"),
          ...underProgramFiles("Git", "bin"),
          ...(envVar(env, "LOCALAPPDATA") ? [join(envVar(env, "LOCALAPPDATA")!, "Programs", "Git", "cmd"), join(envVar(env, "LOCALAPPDATA")!, "Programs", "Git", "bin")] : []),
          ...githubDesktopGitDirectories(options, env, platform),
        ];
      case "gh":
        return underProgramFiles("GitHub CLI");
      case "glab":
        return underProgramFiles("glab");
      case "ssh":
      case "ssh-keygen":
      case "ssh-add":
        return [
          ...(envVar(env, "SystemRoot") ? [join(envVar(env, "SystemRoot")!, "System32", "OpenSSH")] : []),
          ...underProgramFiles("Git", "usr", "bin"),
        ];
      default:
        return [];
    }
  }

  switch (name) {
    case "git":
      return platform === "darwin" ? [] : ["/usr/lib/git-core"];
    default:
      return [];
  }
};

/** GitHub Desktop bundles Git under a version-named `app-<version>` folder and
 *  never puts it on PATH, so use the newest bundle that is actually present. */
const githubDesktopGitDirectories = (
  options: ExecutableLookupOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] => {
  const join = joinFor(platform);
  const localAppData = envVar(env, "LOCALAPPDATA")?.trim();
  if (!localAppData) return [];
  const parent = join(localAppData, "GitHubDesktop");
  const listDir = options.listDir ?? ((path: string) => readdirSync(path));
  let names: string[];
  try {
    names = listDir(parent);
  } catch {
    return [];
  }
  const versions: Array<{ version: number[]; directory: string }> = [];
  for (const entry of names) {
    const match = /^app-(\d+(?:\.\d+)*)$/.exec(entry);
    if (!match) continue;
    versions.push({ version: match[1]!.split(".").map(Number), directory: join(parent, entry, "resources", "app", "git", "cmd") });
  }
  return versions
    .sort((left, right) => compareVersions(right.version, left.version))
    .map((entry) => entry.directory);
};

const compareVersions = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
};

/**
 * Resolve `name` to the executable Polyth should run. Always returns a string:
 * when nothing is discovered the bare name is kept, exactly as a PATH-only
 * lookup would have produced, so an honest "not installed" report is still
 * possible upstream.
 */
export function resolveExecutable(name: string, options: ExecutableLookupOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const explicit = options.explicit?.trim();
  if (explicit) return explicit;
  if (isAbsoluteFor(platform)(name)) return name;
  const env = options.env ?? process.env;
  if (options.overrideEnv) {
    const configured = envVar(env, options.overrideEnv)?.trim();
    if (configured) return configured;
  }
  const join = joinFor(platform);
  const isFile = options.isFile ?? existsSync;

  const names = executableNames(name, platform, env);
  for (const directory of splitPath(envVar(env, "PATH"), platform)) {
    for (const candidate of names) {
      const path = join(directory, candidate);
      if (isFile(path)) return path;
    }
  }

  const directories = [
    ...(options.extraDirectories ?? []),
    ...wellKnownExecutableDirectories(name, options),
  ];
  for (const directory of directories) {
    for (const candidate of names) {
      const path = join(directory, candidate);
      if (isFile(path)) return path;
    }
  }
  return name;
}

/**
 * The directory that holds `name`, when it is found at an absolute path. Used
 * to widen a child process's PATH so a spawned tool (a harness) can itself run
 * `git`/`ssh` that this server found off the inherited PATH.
 */
export function resolvedExecutableDirectory(
  name: string,
  options: ExecutableLookupOptions = {},
): string | undefined {
  return directoryOf(resolveExecutable(name, options), options.platform ?? process.platform);
}
