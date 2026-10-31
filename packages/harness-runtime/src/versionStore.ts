import { lstat, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { HarnessVersionStore } from "@polyth/contracts";

export type HarnessVersionPrune =
  | { pruned: true; active: string; removed: string[]; kept: string[] }
  | { pruned: false; reason: string };

export interface HarnessVersionPruneOptions {
  platform?: NodeJS.Platform;
  /** `/proc` of the host; a fixture in tests. */
  procRoot?: string;
}

/** First path segment of `path` below `directory`, or undefined outside it. */
const entryOf = (directory: string, path: string): string | undefined => {
  const rest = relative(directory, path);
  if (!rest || rest.startsWith("..") || isAbsolute(rest)) return undefined;
  return rest.split(sep)[0];
};

/** Version entries a running process executes or names in its argv. Linux
 *  only: elsewhere use cannot be proven absent, so nothing is pruned. */
async function entriesInUse(directory: string, procRoot: string): Promise<Set<string>> {
  const used = new Set<string>();
  const pids = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
  await Promise.all(pids.map(async (pid) => {
    const exe = await readlink(join(procRoot, pid, "exe")).catch(() => undefined);
    const paths = exe ? [exe.replace(/ \(deleted\)$/, "")] : [];
    const cmdline = await readFile(join(procRoot, pid, "cmdline"), "utf8").catch(() => "");
    paths.push(...cmdline.split("\0").filter((arg) => arg.startsWith(directory + sep)));
    for (const path of paths) {
      const entry = entryOf(directory, path);
      if (entry) used.add(entry);
    }
  }));
  return used;
}

/**
 * Removes the old versions a side-by-side updater left behind: every entry
 * that matches the store's version pattern except the one `executablePath`
 * (the resolved CLI after the update) lives in and the ones a running
 * process still uses. Symlinks and unmatched names are never touched. Any
 * doubt (unknown layout, no process table) prunes nothing.
 */
export async function pruneHarnessVersions(
  store: HarnessVersionStore,
  executablePath: string,
  options: HarnessVersionPruneOptions = {},
): Promise<HarnessVersionPrune> {
  if ((options.platform ?? process.platform) !== "linux") return { pruned: false, reason: "running versions cannot be listed on this platform" };
  const located = store.directory(executablePath);
  if (!located || !isAbsolute(located)) return { pruned: false, reason: "not a side-by-side install" };
  const directory = await realpath(located).catch(() => undefined);
  const active = directory && entryOf(directory, executablePath);
  if (!directory || !active || !store.entry.test(active)) return { pruned: false, reason: "the active version is not in the version directory" };
  let inUse: Set<string>;
  try {
    inUse = await entriesInUse(directory, options.procRoot ?? "/proc");
  } catch {
    return { pruned: false, reason: "running processes cannot be listed" };
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!store.entry.test(name) || name === active) continue;
    const path = join(directory, name);
    const stat = await lstat(path).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || inUse.has(name)) {
      kept.push(name);
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      kept.push(name);
    }
  }
  return { pruned: true, active, removed, kept };
}
