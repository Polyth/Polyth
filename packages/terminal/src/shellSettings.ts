// Terminal shell preference: "auto" (the user's login shell, see
// resolveLoginShell) or one shell installed on the host. The choice is stored
// per Space and applies only to interactive local terminals; remote (SSH)
// projects keep the remote account's own `$SHELL`.
//
// A stored path is honored only while it is still in the host's list of
// available shells, so a tampered or stale settings file can never turn the
// terminal into an arbitrary executable launcher — it falls back to auto.
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, win32 } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import { resolveLoginShell } from "./index.ts";

export const AUTO_SHELL = "auto";

export interface TerminalShellOption {
  /** Absolute path that is spawned. */
  path: string;
  /** Short display name (basename without `.exe`). */
  name: string;
}

export interface TerminalShellSettings {
  /** `auto` or the absolute path of an available shell. */
  shell: string;
}

export interface TerminalShellSnapshot extends TerminalShellSettings {
  /** The shell auto mode resolves to on this host right now. */
  autoShell: string;
  /** What a new local terminal will actually start. */
  effectiveShell: string;
  available: TerminalShellOption[];
}

const SETTINGS_FILE = "shell.json";

/** Account placeholders listed in /etc/shells that are not usable terminals. */
const NOT_INTERACTIVE = new Set(["nologin", "false", "true", "sync", "git-shell", "rbash"]);

const displayName = (path: string): string => {
  const base = path.includes("\\") ? win32.basename(path) : basename(path);
  return base.replace(/\.exe$/i, "");
};

const isExecutable = async (path: string, platform: NodeJS.Platform): Promise<boolean> => {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface ShellDiscoveryDeps {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  /** Contents of /etc/shells; injection seam for tests. */
  readShellsFile?: () => Promise<string>;
  isExecutable?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
  /** Login shell auto mode resolves to; defaults to resolveLoginShell(). */
  autoShell?: string;
}

/** Shells installed on this host, deduplicated by their real file (usrmerge
 *  lists /bin/bash and /usr/bin/bash for one binary). The auto shell is always
 *  included when it exists, even if /etc/shells omits it. */
export async function listAvailableShells(deps: ShellDiscoveryDeps = {}): Promise<TerminalShellOption[]> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const executable = deps.isExecutable ?? ((path: string) => isExecutable(path, platform));
  const real = deps.realpath ?? ((path: string) => realpath(path));
  const autoShell = deps.autoShell ?? resolveLoginShell(platform, env);

  const candidates: string[] = [];
  if (platform === "win32") {
    const comspec = env.COMSPEC?.trim();
    if (comspec) candidates.push(comspec);
    const dirs = (env.PATH ?? env.Path ?? "").split(";").map((dir) => dir.trim()).filter(Boolean);
    for (const exe of ["pwsh.exe", "powershell.exe", "cmd.exe", "bash.exe"]) {
      for (const dir of dirs) candidates.push(win32.join(dir, exe));
    }
  } else {
    let listed = "";
    try {
      listed = await (deps.readShellsFile ?? (() => readFile("/etc/shells", "utf8")))();
    } catch {
      // No /etc/shells (minimal container, some macOS setups): auto + PATH only.
    }
    for (const line of listed.split("\n")) {
      const entry = line.replace(/#.*/, "").trim();
      if (entry && isAbsolute(entry)) candidates.push(entry);
    }
    const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
    for (const name of ["bash", "zsh", "fish", "nu", "sh"]) {
      for (const dir of dirs) candidates.push(join(dir, name));
    }
  }
  if (isAbsolute(autoShell) || win32.isAbsolute(autoShell)) candidates.unshift(autoShell);

  const seen = new Set<string>();
  const shells: TerminalShellOption[] = [];
  for (const path of candidates) {
    const name = displayName(path);
    if (NOT_INTERACTIVE.has(name.toLowerCase())) continue;
    if (seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    if (!(await executable(path))) continue;
    let identity = path;
    try { identity = await real(path); } catch { /* keep the listed path */ }
    const key = platform === "win32" ? identity.toLowerCase() : identity;
    if (seen.has(`real:${key}`)) continue;
    seen.add(`real:${key}`);
    shells.push({ path, name });
  }
  return shells;
}

const settingsPath = (storage: SpaceStorage): string =>
  join(storage.packageDir("terminal"), SETTINGS_FILE);

/** Missing or corrupt settings mean auto. */
export async function readTerminalShellSetting(storage: SpaceStorage): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(storage), "utf8")) as Partial<TerminalShellSettings>;
    return typeof parsed.shell === "string" && parsed.shell.trim() ? parsed.shell.trim() : AUTO_SHELL;
  } catch {
    return AUTO_SHELL;
  }
}

export async function writeTerminalShellSetting(storage: SpaceStorage, shell: string): Promise<void> {
  const dir = storage.packageDir("terminal");
  await mkdir(dir, { recursive: true });
  const file = settingsPath(storage);
  const temp = `${file}.${process.pid}.tmp`;
  const payload: TerminalShellSettings = { shell };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** The explicit shell to spawn for `setting`, or undefined for auto (also when
 *  the stored shell is no longer installed). */
export const effectiveShellOverride = (
  setting: string,
  available: readonly TerminalShellOption[],
): string | undefined =>
  setting !== AUTO_SHELL && available.some((option) => option.path === setting) ? setting : undefined;

export async function terminalShellSnapshot(
  storage: SpaceStorage,
  deps: ShellDiscoveryDeps = {},
): Promise<TerminalShellSnapshot> {
  const autoShell = deps.autoShell ?? resolveLoginShell(deps.platform ?? process.platform, deps.env ?? process.env);
  const [shell, available] = await Promise.all([
    readTerminalShellSetting(storage),
    listAvailableShells({ ...deps, autoShell }),
  ]);
  return {
    shell,
    autoShell,
    effectiveShell: effectiveShellOverride(shell, available) ?? autoShell,
    available,
  };
}
