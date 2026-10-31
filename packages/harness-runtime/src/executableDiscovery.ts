import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { GIT_BINARY_ENV, resolvedExecutableDirectory } from "@polyth/kernel/executable";
import { WINDOWS_NODE_DIR, WINDOWS_NPM_PREFIX } from "./installers.ts";

/** Opt out of the login-shell PATH probe in hermetic environments. */
export const POLYTH_HARNESS_SHELL_PROBE_ENV = "POLYTH_HARNESS_SHELL_PROBE";

const SHELL_PROBE_TIMEOUT_MS = 5_000;
const PATH_MARKER = "__polyth_harness_path__";
const PROBE_SCRIPT = `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`;

export type HarnessExecutableSearchStage = "path" | "well-known" | "login-shell";

export interface HarnessExecutableSearchHit {
  executablePath: string;
  /** The entry that was found before symlinks were resolved (for example
   *  `~/.local/bin/claude`). It survives CLI self-updates that replace the
   *  versioned target, so commands shown to a user should name it. */
  launcherPath?: string;
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

// Windows allows quoted PATH entries (`"C:\Program Files\x"`).
const splitPath = (value: string | undefined): string[] =>
  (value ?? "").split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "").trim()).filter(Boolean);

/** Windows environment names are case-insensitive, but a copied env object
 *  is not: `{ ...process.env }` keeps `Path`, so `env.PATH` reads nothing. */
const pathKeys = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] =>
  platform === "win32" ? Object.keys(env).filter((key) => key.toUpperCase() === "PATH") : ["PATH"];

const inheritedPath = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined => {
  if (env.PATH !== undefined) return env.PATH;
  const key = pathKeys(env, platform)[0];
  return key === undefined ? undefined : env[key];
};

/** Sets PATH as the one PATH entry: a Windows child given both `Path` and
 *  `PATH` receives whichever Node sorts first. */
const withPath = (env: NodeJS.ProcessEnv, entries: readonly string[], platform: NodeJS.Platform): NodeJS.ProcessEnv => {
  const next = { ...env };
  for (const key of pathKeys(next, platform)) delete next[key];
  next.PATH = entries.join(delimiter);
  return next;
};

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
    const local = (...segments: string[]): string | undefined => localAppData ? join(localAppData, ...segments) : undefined;
    // Vendor installers add these to the *User* PATH only, which a running
    // server never sees. Per-user directories come before system ones.
    return [
      under(".local", "bin"),
      // Polyth's own npm installer: CLI shims, then the Node.js they run on.
      local(...WINDOWS_NPM_PREFIX),
      local(...WINDOWS_NODE_DIR),
      under(".bun", "bin"),
      // Before `.grok\bin`, which also ships an `agent.exe`: Cursor's `agent`.
      local("cursor-agent"),
      local("agy", "bin"),
      local("omp"),
      under(".grok", "bin"),
      under(".opencode", "bin"),
      under(".claude", "local"),
      appData ? join(appData, "npm") : undefined,
      local("pnpm"),
      under("scoop", "shims"),
      join(programFiles, "nodejs"),
      join(programData, "chocolatey", "bin"),
      local("Microsoft", "WindowsApps"),
    ].filter((entry): entry is string => Boolean(entry));
  }

  return [
    under(".local", "bin"),
    under(".bun", "bin"),
    under(".grok", "bin"),
    under(".opencode", "bin"),
    under(".claude", "local"),
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
      return { executablePath, launcherPath: resolve(candidate), stage, directory };
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
      return { hit: { executablePath, launcherPath: resolve(binary), stage: "path", directory: dirname(executablePath) }, searched };
    }
    return { searched };
  }

  const fromPath = await scanDirectories(binary, splitPath(inheritedPath(env, options.platform ?? process.platform)), "path", options, searched);
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

const NESTING_MARKER_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
] as const;

export const harnessExecutableChildEnv = async (
  executablePath: string,
  options: HarnessExecutableDiscoveryOptions = {},
): Promise<NodeJS.ProcessEnv> => {
  const inheritedEnv = options.env ?? process.env;
  const env = { ...inheritedEnv };
  // A server launched from inside another coding-agent process must not make
  // the child look like a nested native session. These are process-shape
  // markers, not credentials, and removing them preserves the user's auth.
  for (const marker of NESTING_MARKER_ENV) delete env[marker];
  const platform = options.platform ?? process.platform;
  const inherited = splitPath(inheritedPath(env, platform));
  const binaryDirectory = dirname(executablePath);
  const onInheritedPath = inherited.some((entry) => {
    try {
      return resolve(entry) === resolve(binaryDirectory);
    } catch {
      return entry === binaryDirectory;
    }
  });
  // npm CLIs resolve to a script whose `#!/usr/bin/env node` needs `node` on
  // PATH; the Node.js that Polyth's installer provides lives in `~/.local/bin`,
  // which a service or desktop launch often does not inherit. Last, so it
  // never shadows the user's own tools. The harness's own `git`/`ssh` calls
  // reach the same binaries the server resolved, not a PATH-only guess.
  const fallback = mergeHarnessSearchPaths(
    harnessToolDirectories(options),
    wellKnownHarnessExecutableDirectories(options),
  );
  if (onInheritedPath) return withPath(env, mergeHarnessSearchPaths(inherited, fallback), platform);
  const login = await probeHarnessLoginShellPath(options).catch(() => undefined);
  // The resolved directory must win over shell aliases/shims with the same
  // command name so probe and execution can never select different CLIs.
  return withPath(env, mergeHarnessSearchPaths([binaryDirectory], login?.entries, inherited, fallback), platform);
};

const SHIM_SIZE_LIMIT = 64 * 1024;
/** A quoted path relative to the shim's own folder: npm's cmd-shim writes
 *  `"%dp0%\…"`, pnpm `"%~dp0\…"`. */
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+)"/gi;

/**
 * The native program an npm/pnpm Windows `.cmd` shim launches, when it
 * launches one directly (`@anthropic-ai/claude-code` ships `bin/claude.exe`).
 * Running that program avoids `cmd.exe`, which re-parses every argument and
 * breaks on a path with spaces. Returns undefined for a script target (a
 * `.js` needs the shim's Node.js resolution) unless `scripts` asks for it,
 * or for anything unreadable.
 */
export const windowsCmdShimTarget = async (shimPath: string, options: { scripts?: boolean } = {}): Promise<string | undefined> => {
  if (!/\.(?:cmd|bat)$/i.test(shimPath)) return undefined;
  try {
    if ((await stat(shimPath)).size > SHIM_SIZE_LIMIT) return undefined;
    const text = await readFile(shimPath, "utf8");
    const targets = [...text.matchAll(SHIM_TARGET)]
      .map((match) => match[1]!.trim())
      .filter((target) => !/(?:^|\\)node\.exe$/i.test(target));
    const target = targets.at(-1);
    if (!target || !(options.scripts ? /\.(?:exe|com|m?js)$/i : /\.(?:exe|com)$/i).test(target)) return undefined;
    const candidate = join(dirname(shimPath), ...target.split("\\"));
    return (await stat(candidate)).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
};

/** Directories of the local tools a harness child runs (`git`, `ssh`),
 *  resolved the same way the server resolves them, so a child started with a
 *  minimal PATH still finds a git/ssh that lives off the inherited PATH. */
const harnessToolDirectories = (options: HarnessExecutableDiscoveryOptions): string[] => {
  const base = {
    ...(options.env ? { env: options.env } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.home ? { home: options.home } : {}),
  };
  return [
    resolvedExecutableDirectory("git", { ...base, overrideEnv: GIT_BINARY_ENV }),
    resolvedExecutableDirectory("ssh", base),
  ].filter((entry): entry is string => Boolean(entry));
};
