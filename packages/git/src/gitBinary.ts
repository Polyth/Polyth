// Where Polyth finds the `git` executable.
//
// Polyth shells out to a system Git; it does not ship one to the server, so a
// machine where Git exists only inside another app's private bundle — most
// commonly GitHub Desktop, which never adds its copy to PATH — used to make
// every folder look like "not a Git repository". The lookup order lives in the
// shared `@polyth/kernel/executable` resolver: an explicit binary, then
// `POLYTH_GIT_BIN`, then a `git` on PATH, then well-known install locations
// (including the newest GitHub Desktop bundle on Windows), then the bare name
// `git`, preserving the previous PATH-only behaviour.
import { resolveExecutable, GIT_BINARY_ENV, type ExecutableLookupOptions } from "@polyth/kernel/executable";

export interface GitBinaryOptions {
  /** Explicit path or command name; wins over the environment. */
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable existence check (defaults to `fs.existsSync`); tests only. */
  isFile?: (path: string) => boolean;
  /** Injectable directory listing of immediate child names; tests only. */
  listDir?: (path: string) => string[];
}

/** The Git executable Polyth should run, resolved for the current platform. */
export function resolveGitBinary(options: GitBinaryOptions = {}): string {
  return resolveExecutable("git", {
    ...(options.explicit !== undefined ? { explicit: options.explicit } : {}),
    overrideEnv: GIT_BINARY_ENV,
    ...(options.env ? { env: options.env } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.isFile ? { isFile: options.isFile } : {}),
    ...(options.listDir ? { listDir: options.listDir } : {}),
  } satisfies ExecutableLookupOptions);
}
