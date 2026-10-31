// Finding the OpenCode CLI is the single most common reason a working install
// answers "no models available": OpenCode installs itself into `~/.opencode/bin`
// (or `~/.bun/bin`, Homebrew, npm's global prefix, …) and those directories only
// reach PATH through the user's shell rc files. A Polyth server started from a
// desktop launcher, an AppImage, a systemd unit, or launchd inherits a minimal
// PATH, so a PATH-only lookup fails on a machine where `opencode` runs fine in a
// terminal — and the user sees an empty model catalog with no explanation.
//
// Discovery therefore widens in three deliberate stages, cheapest first, and
// records every location it tried so a genuine failure can name them:
//   1. `path`        — the PATH this process inherited.
//   2. `well-known`  — the documented install locations for each platform.
//   3. `login-shell` — the PATH a login shell would have produced, obtained by
//                      asking the shell for `$PATH` and nothing else.
//
// The login-shell stage is last because it costs a process spawn and sources
// user rc files. It is bounded, cached for the process lifetime, and asks only
// for PATH: importing a whole login environment into a long-lived server would
// let rc files silently override the values Polyth sets for its own children
// (OPENCODE_DB, OPENCODE_CONFIG_DIR, HOME, NODE_OPTIONS).
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** Opt out of the login-shell probe (`0`/`false`) for hermetic environments. */
export const POLYTH_OPENCODE_SHELL_PROBE_ENV = "POLYTH_OPENCODE_SHELL_PROBE";

/** A login shell that blocks on a prompt must never hold discovery hostage;
 * an overrunning probe is abandoned and the stage simply reports nothing. */
const SHELL_PROBE_TIMEOUT_MS = 5_000;

export type OpenCodeSearchStage = "path" | "well-known" | "login-shell";

export interface OpenCodeSearchHit {
  executablePath: string;
  stage: OpenCodeSearchStage;
  /** Directory the hit came from — used to keep it on the child's PATH. */
  directory: string;
}

export interface OpenCodeSearchReport {
  hit?: OpenCodeSearchHit;
  /** Every candidate file that was checked, in the order it was checked. */
  searched: string[];
  /** PATH entries the login-shell stage contributed, when it ran. */
  loginShellPath?: string[];
  /** Shell that answered the probe, when one did. */
  loginShell?: string;
}

export interface OpenCodeDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injected in tests; production resolves the user's real home. */
  home?: string;
  /** `false` skips the process spawn entirely. */
  loginShellProbe?: boolean;
}

const splitPath = (value: string | undefined): string[] =>
  (value ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);

/** Merge PATH-like values, first occurrence wins, duplicates dropped. On
 * Windows the comparison is case-insensitive because PATH there is. */
export const mergeSearchPaths = (
  ...values: ReadonlyArray<string | readonly string[] | undefined>
): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    const entries = Array.isArray(value) ? value : splitPath(value as string | undefined);
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmed);
    }
  }
  return merged;
};

const resolveHome = (options: OpenCodeDiscoveryOptions): string => {
  const env = options.env ?? process.env;
  const candidate = options.home
    ?? (options.platform === "win32" || process.platform === "win32"
      ? env.USERPROFILE ?? env.HOME
      : env.HOME);
  const trimmed = candidate?.trim();
  if (trimmed) return trimmed;
  try {
    return homedir();
  } catch {
    return "";
  }
};

/** The documented places OpenCode lands, in the order a user would expect them
 * to win. Kept as directories (not full paths) so the same list can widen the
 * PATH handed to the spawned runtime. */
export const wellKnownOpenCodeDirectories = (
  options: OpenCodeDiscoveryOptions = {},
): string[] => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = resolveHome({ ...options, platform });
  const under = (...segments: string[]): string | undefined =>
    home ? join(home, ...segments) : undefined;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    const programData = env.ProgramData?.trim() ?? "C:\\ProgramData";
    const programFiles = env.ProgramFiles?.trim() ?? "C:\\Program Files";
    return [
      under(".opencode", "bin"),
      under(".bun", "bin"),
      appData ? join(appData, "npm") : undefined,
      join(programFiles, "nodejs"),
      under("scoop", "shims"),
      join(programData, "chocolatey", "bin"),
      localAppData ? join(localAppData, "Microsoft", "WindowsApps") : undefined,
    ].filter((entry): entry is string => Boolean(entry));
  }

  return [
    under(".opencode", "bin"),
    under(".bun", "bin"),
    under(".local", "bin"),
    under(".local", "share", "pnpm"),
    under("bin"),
    under(".npm-global", "bin"),
    under(".volta", "bin"),
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/snap/bin",
  ].filter((entry): entry is string => Boolean(entry));
};

const executableNames = (
  binary: string,
  options: OpenCodeDiscoveryOptions,
): string[] => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || extname(binary)) return [binary];
  const env = options.env ?? process.env;
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return extensions.map((extension) =>
    `${binary}${extension.startsWith(".") ? extension : `.${extension}`}`);
};

/** Windows has no execute bit, so `X_OK` there answers for any readable file;
 * the extension list above already restricts candidates to executables. */
const isExecutable = async (
  candidate: string,
  options: OpenCodeDiscoveryOptions,
): Promise<boolean> => {
  const platform = options.platform ?? process.platform;
  try {
    await access(candidate, platform === "win32" ? fsConstants.R_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const scanDirectories = async (
  binary: string,
  directories: readonly string[],
  stage: OpenCodeSearchStage,
  options: OpenCodeDiscoveryOptions,
  searched: string[],
): Promise<OpenCodeSearchHit | undefined> => {
  const names = executableNames(binary, options);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (searched.includes(candidate)) continue;
      searched.push(candidate);
      if (!await isExecutable(candidate, options)) continue;
      let executablePath = candidate;
      try {
        executablePath = await realpath(candidate);
      } catch {
        executablePath = resolve(candidate);
      }
      return { executablePath, stage, directory };
    }
  }
  return undefined;
};

interface LoginShellPath {
  shell: string;
  entries: string[];
}

let loginShellPathProbe: Promise<LoginShellPath | undefined> | undefined;

const shellProbeDisabled = (env: NodeJS.ProcessEnv): boolean => {
  const raw = env[POLYTH_OPENCODE_SHELL_PROBE_ENV]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
};

// An rc file that prints a banner would otherwise be parsed as PATH, so the
// probe frames its answer and only the framed line is read.
const PATH_MARKER = "__polyth_opencode_path__";
const PROBE_SCRIPT = `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`;

const readMarkedPath = (stdout: string | undefined): string | undefined => {
  if (!stdout) return undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf(PATH_MARKER);
    if (at >= 0) return line.slice(at + PATH_MARKER.length);
  }
  return undefined;
};

const runShellPathProbe = (
  shell: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> =>
  new Promise((resolveProbe) => {
    try {
      execFile(
        shell,
        [...args],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: SHELL_PROBE_TIMEOUT_MS,
          env,
          windowsHide: true,
        },
        // A shell that fails after printing the marker (a rc-file error exit)
        // still answered the only question that was asked.
        (_error, stdout) => resolveProbe(readMarkedPath(stdout)),
      );
    } catch {
      resolveProbe(undefined);
    }
  });

/** Ask a login shell for `$PATH` — nothing else. `-lc` is tried before `-lic`
 * because a non-interactive login shell already sources the profile files that
 * carry PATH edits, without the prompt/completion machinery an interactive
 * shell would start. Cached for the process lifetime: rc files do not change
 * under a running server, and a per-call spawn would be paid on every retry. */
export const probeLoginShellPath = (
  options: OpenCodeDiscoveryOptions = {},
): Promise<LoginShellPath | undefined> => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (options.loginShellProbe === false) return Promise.resolve(undefined);
  if (platform === "win32") return Promise.resolve(undefined);
  if (shellProbeDisabled(env)) return Promise.resolve(undefined);
  loginShellPathProbe ??= (async () => {
    const shells = mergeSearchPaths([
      env.SHELL?.trim() ?? "",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
    for (const shell of shells) {
      if (!isAbsolute(shell)) continue;
      if (!await isExecutable(shell, { platform })) continue;
      for (const flags of [["-lc"], ["-lic"]]) {
        const marked = await runShellPathProbe(shell, [...flags, PROBE_SCRIPT], env);
        const entries = mergeSearchPaths(marked?.trim());
        if (entries.length > 0) return { shell, entries };
      }
    }
    return undefined;
  })();
  return loginShellPathProbe;
};

/** Test seam: forget the cached login-shell PATH. */
export const resetLoginShellPathProbe = (): void => {
  loginShellPathProbe = undefined;
};

/**
 * Locate an OpenCode executable by name, widening from the inherited PATH to
 * the documented install locations to a login-shell PATH. Always returns a
 * report: a miss carries every location that was checked so the caller can say
 * exactly where it looked instead of "not found on PATH".
 */
export const discoverOpenCodeBinary = async (
  binary = "opencode",
  options: OpenCodeDiscoveryOptions = {},
): Promise<OpenCodeSearchReport> => {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  const fromPath = await scanDirectories(
    binary,
    splitPath(env.PATH),
    "path",
    options,
    searched,
  );
  if (fromPath) return { hit: fromPath, searched };

  const fromWellKnown = await scanDirectories(
    binary,
    wellKnownOpenCodeDirectories(options),
    "well-known",
    options,
    searched,
  );
  if (fromWellKnown) return { hit: fromWellKnown, searched };

  const login = await probeLoginShellPath(options);
  if (!login) return { searched };
  const fromLoginShell = await scanDirectories(
    binary,
    login.entries,
    "login-shell",
    options,
    searched,
  );
  return {
    ...(fromLoginShell ? { hit: fromLoginShell } : {}),
    searched,
    loginShellPath: login.entries,
    loginShell: login.shell,
  };
};

/**
 * PATH for the spawned `opencode serve`. OpenCode shells out constantly (git,
 * ripgrep, the LSP servers, `bun`/`node` for plugins), and a runtime started
 * from a GUI launcher inherits the same truncated PATH that hid the CLI — so
 * the child would start and then fail every tool call.
 *
 * The widening is conditional on evidence, not unconditional: if the CLI's own
 * directory is already on the inherited PATH, that PATH is the user's and is
 * left alone. Finding the CLI somewhere PATH never listed is the proof that
 * this process did not inherit the user's environment, and only then is a
 * login-shell PATH merged in. The CLI's directory is appended rather than
 * prepended so a fallback location never outranks a toolchain the user put on
 * PATH deliberately.
 */
export const openCodeChildSearchPath = async (
  executablePath: string,
  options: OpenCodeDiscoveryOptions = {},
): Promise<string> => {
  const env = options.env ?? process.env;
  const inherited = splitPath(env.PATH);
  const binaryDirectory = dirname(executablePath);
  const onInheritedPath = inherited.some((entry) =>
    entry === binaryDirectory
    || resolve(entry) === resolve(binaryDirectory));
  if (onInheritedPath) return mergeSearchPaths(inherited).join(delimiter);
  const login = await probeLoginShellPath(options).catch(() => undefined);
  return mergeSearchPaths(login?.entries, inherited, [binaryDirectory])
    .join(delimiter);
};
