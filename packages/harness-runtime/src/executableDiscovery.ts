import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** Opt out of the login-shell PATH probe in hermetic environments. */
export const POLYTH_HARNESS_SHELL_PROBE_ENV = "POLYTH_HARNESS_SHELL_PROBE";

const SHELL_PROBE_TIMEOUT_MS = 5_000;
const PATH_MARKER = "__polyth_harness_path__";
const PROBE_SCRIPT = `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`;

export type HarnessExecutableSearchStage = "path" | "well-known" | "login-shell";

export interface HarnessExecutableSearchHit {
  executablePath: string;
  stage: HarnessExecutableSearchStage;
  directory: string;
}

export interface HarnessExecutableSearchReport {
  hit?: HarnessExecutableSearchHit;
  searched: string[];
  loginShellPath?: string[];
  loginShell?: string;
}

export interface HarnessExecutableDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Vendor-specific directories checked after the inherited PATH. */
  additionalDirectories?: readonly string[];
  /** Skip sourcing a login shell, primarily for hermetic tests/CI. */
  loginShellProbe?: boolean;
}

const splitPath = (value: string | undefined): string[] =>
  (value ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);

export const mergeHarnessSearchPaths = (
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

const resolveHome = (options: HarnessExecutableDiscoveryOptions): string => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidate = options.home
    ?? (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME);
  if (candidate?.trim()) return candidate.trim();
  try {
    return homedir();
  } catch {
    return "";
  }
};

/** Common user-level locations used by coding-agent installers and JS package managers. */
export const wellKnownHarnessExecutableDirectories = (
  options: HarnessExecutableDiscoveryOptions = {},
): string[] => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = resolveHome({ ...options, platform });
  const under = (...segments: string[]): string | undefined => home ? join(home, ...segments) : undefined;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    const programData = env.ProgramData?.trim() ?? "C:\\ProgramData";
    const programFiles = env.ProgramFiles?.trim() ?? "C:\\Program Files";
    return [
      under(".local", "bin"),
      under(".bun", "bin"),
      under(".grok", "bin"),
      appData ? join(appData, "npm") : undefined,
      localAppData ? join(localAppData, "pnpm") : undefined,
      join(programFiles, "nodejs"),
      under("scoop", "shims"),
      join(programData, "chocolatey", "bin"),
      localAppData ? join(localAppData, "Microsoft", "WindowsApps") : undefined,
    ].filter((entry): entry is string => Boolean(entry));
  }

  return [
    under(".local", "bin"),
    under(".bun", "bin"),
    under(".grok", "bin"),
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
  ].filter((entry): entry is string => Boolean(entry));
};

const executableNames = (
  binary: string,
  options: HarnessExecutableDiscoveryOptions,
): string[] => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || extname(binary)) return [binary];
  const extensions = ((options.env ?? process.env).PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${binary}${extension.startsWith(".") ? extension : `.${extension}`}`);
};

const isExecutable = async (
  candidate: string,
  options: HarnessExecutableDiscoveryOptions,
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
  stage: HarnessExecutableSearchStage,
  options: HarnessExecutableDiscoveryOptions,
  searched: string[],
): Promise<HarnessExecutableSearchHit | undefined> => {
  for (const directory of directories) {
    for (const name of executableNames(binary, options)) {
      const candidate = join(directory, name);
      if (searched.includes(candidate)) continue;
      searched.push(candidate);
      if (!await isExecutable(candidate, options)) continue;
      const executablePath = await realpath(candidate).catch(() => resolve(candidate));
      return { executablePath, stage, directory };
    }
  }
  return undefined;
};

type LoginShellPath = { shell: string; entries: string[] };
let loginShellPathProbe: Promise<LoginShellPath | undefined> | undefined;

const shellProbeDisabled = (env: NodeJS.ProcessEnv): boolean => {
  const value = env[POLYTH_HARNESS_SHELL_PROBE_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
};

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
): Promise<string | undefined> => new Promise((resolveProbe) => {
  try {
    execFile(shell, [...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: SHELL_PROBE_TIMEOUT_MS,
      env,
      windowsHide: true,
    }, (_error, stdout) => resolveProbe(readMarkedPath(stdout)));
  } catch {
    resolveProbe(undefined);
  }
});

export const probeHarnessLoginShellPath = (
  options: HarnessExecutableDiscoveryOptions = {},
): Promise<LoginShellPath | undefined> => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (options.loginShellProbe === false || platform === "win32" || shellProbeDisabled(env)) {
    return Promise.resolve(undefined);
  }
  loginShellPathProbe ??= (async () => {
    const shells = mergeHarnessSearchPaths([
      env.SHELL?.trim() ?? "",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
    for (const shell of shells) {
      if (!isAbsolute(shell) || !await isExecutable(shell, { platform })) continue;
      for (const flags of [["-lc"], ["-lic"]]) {
        const value = await runShellPathProbe(shell, [...flags, PROBE_SCRIPT], env);
        const entries = mergeHarnessSearchPaths(value?.trim());
        if (entries.length) return { shell, entries };
      }
    }
    return undefined;
  })();
  return loginShellPathProbe;
};

export const resetHarnessLoginShellPathProbe = (): void => {
  loginShellPathProbe = undefined;
};

/**
 * Resolve a CLI from the exact environment inherited by Polyth, common desktop
 * install locations, then the user's login-shell PATH. Absolute paths remain exact.
 */
export const discoverHarnessExecutable = async (
  binary: string,
  options: HarnessExecutableDiscoveryOptions = {},
): Promise<HarnessExecutableSearchReport> => {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  if (isAbsolute(binary)) {
    searched.push(binary);
    if (await isExecutable(binary, options)) {
      const executablePath = await realpath(binary).catch(() => resolve(binary));
      return { hit: { executablePath, stage: "path", directory: dirname(executablePath) }, searched };
    }
    return { searched };
  }

  const fromPath = await scanDirectories(binary, splitPath(env.PATH), "path", options, searched);
  if (fromPath) return { hit: fromPath, searched };

  const fromWellKnown = await scanDirectories(
    binary,
    mergeHarnessSearchPaths(options.additionalDirectories, wellKnownHarnessExecutableDirectories(options)),
    "well-known",
    options,
    searched,
  );
  if (fromWellKnown) return { hit: fromWellKnown, searched };

  const login = await probeHarnessLoginShellPath(options);
  if (!login) return { searched };
  const fromLoginShell = await scanDirectories(binary, login.entries, "login-shell", options, searched);
  return {
    ...(fromLoginShell ? { hit: fromLoginShell } : {}),
    searched,
    loginShellPath: login.entries,
    loginShell: login.shell,
  };
};

export const harnessExecutableChildEnv = async (
  executablePath: string,
  options: HarnessExecutableDiscoveryOptions = {},
): Promise<NodeJS.ProcessEnv> => {
  const env = options.env ?? process.env;
  const inherited = splitPath(env.PATH);
  const binaryDirectory = dirname(executablePath);
  const onInheritedPath = inherited.some((entry) => {
    try {
      return resolve(entry) === resolve(binaryDirectory);
    } catch {
      return entry === binaryDirectory;
    }
  });
  if (onInheritedPath) return { ...env };
  const login = await probeHarnessLoginShellPath(options).catch(() => undefined);
  return {
    ...env,
    PATH: mergeHarnessSearchPaths(login?.entries, inherited, [binaryDirectory]).join(delimiter),
  };
};
