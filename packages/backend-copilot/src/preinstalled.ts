// Copies of Copilot CLI that GitHub's own installers leave outside PATH.
//
// - Windows installer (`copilot-x64.msi` / `copilot-arm64.msi`, also what
//   `winget install GitHub.Copilot` runs): `%LOCALAPPDATA%\GitHubCopilotCLI\
//   copilot.exe`, added to the *User* PATH only, which a running server never
//   sees (read from the 1.0.109 package's Directory and Environment tables).
// - GitHub Copilot app (macOS `.dmg`, Windows `-setup.exe` / `.msi`, Linux
//   packages): the app has no `copilot` file of its own. Its Copilot SDK
//   carries the CLI and unpacks it on first start into the person's cache:
//   `<cache>/github-copilot-sdk/cli/<version>/copilot[.exe]`, next to a
//   `.copilot-cli.ok` marker that says the copy is complete (app 1.2.0 and
//   the SDK's `embeddedcli.rs`). `<cache>` is `~/Library/Caches` on macOS,
//   `%LOCALAPPDATA%` on Windows and `$XDG_CACHE_HOME` or `~/.cache` on Linux.
//   The app removes versions it no longer uses, so the newest complete one is
//   taken on every lookup. An app that was installed but never opened has
//   unpacked nothing yet.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface CopilotPreinstallOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
}

const APP_CACHE = ["github-copilot-sdk", "cli"] as const;
const COMPLETE_MARKER = ".copilot-cli.ok";

/** The person's cache directory, as the Copilot SDK resolves it. */
export function copilotCacheRoot(options: CopilotPreinstallOptions = {}): string | undefined {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    if (platform === "win32") return env.LOCALAPPDATA?.trim() || undefined;
    const home = options.home ?? env.HOME?.trim() ?? homedir();
    if (!home) return undefined;
    if (platform === "darwin") return posix.join(home, "Library", "Caches");
    const xdg = env.XDG_CACHE_HOME?.trim();
    return xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".cache");
}

/**
 * Directories to search for `copilot` after PATH found nothing: the Windows
 * installer's folder, then every complete copy the Copilot app unpacked,
 * newest first.
 */
export async function preinstalledCopilotDirectories(options: CopilotPreinstallOptions = {}): Promise<string[]> {
    const platform = options.platform ?? process.platform;
    const path = platform === "win32" ? win32 : posix;
    const directories: string[] = [];
    const root = copilotCacheRoot(options);
    if (platform === "win32" && root) directories.push(path.join(root, "GitHubCopilotCLI"));
    if (!root) return directories;
    const cache = path.join(root, ...APP_CACHE);
    const versions = await readdir(cache, { withFileTypes: true }).catch(() => []);
    const complete: Array<{ directory: string; at: number }> = [];
    for (const entry of versions) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(cache, entry.name);
        const marker = await stat(path.join(directory, COMPLETE_MARKER)).catch(() => undefined);
        if (marker?.isFile()) complete.push({ directory, at: marker.mtimeMs });
    }
    complete.sort((left, right) => right.at - left.at || right.directory.localeCompare(left.directory));
    return [...directories, ...complete.map((entry) => entry.directory)];
}
