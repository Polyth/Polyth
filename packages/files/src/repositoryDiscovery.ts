import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveGitBinary } from "@polyth/git";
import { isBlockedHostPath, resolveHostPath } from "./browse.ts";

export interface RepositoryDiscovery {
  repositories: Array<{ name: string; path: string; linked: boolean }>;
  truncated: boolean;
}

/** Explicit host-folder selection only. Scan one level, including links, with
 * bounded directory probes and one Git child at a time. Registration always
 * revalidates the chosen root; discovery grants no session file authority. */
export async function discoverRepositories(rawPath: string): Promise<RepositoryDiscovery> {
  const selected = resolveHostPath(rawPath);
  const root = await realpath(selected);
  if (isBlockedHostPath(root)) throw Object.assign(new Error("Repository discovery is unavailable at this path"), { code: "invalid-path" });
  const found = new Map<string, RepositoryDiscovery["repositories"][number]>();
  const deadline = Date.now() + 3_000;
  let truncated = false;
  const probe = async (candidate: string) => {
    if (Date.now() > deadline) { truncated = true; return; }
    try {
      const canonical = await realpath(candidate);
      if (isBlockedHostPath(canonical) || found.has(canonical)) return;
      await lstat(join(canonical, ".git"));
      const actual = await new Promise<string | null>((done) => {
        execFile(resolveGitBinary(), ["-C", canonical, "rev-parse", "--show-toplevel"], {
          timeout: Math.max(1, deadline - Date.now()), maxBuffer: 16 * 1024, encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        }, (error, stdout) => done(error ? null : stdout.trim()));
      });
      if (actual && await realpath(actual) === canonical) found.set(canonical, {
        name: basename(candidate), path: canonical, linked: (await lstat(candidate)).isSymbolicLink(),
      });
    } catch { /* Unreadable, non-Git, and broken links are not candidates. */ }
  };
  await probe(selected);
  const directory = await opendir(root);
  let visited = 0;
  for await (const entry of directory) {
    if (++visited > 128 || Date.now() > deadline || found.size >= 32) { truncated = true; break; }
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    await probe(join(root, entry.name));
  }
  return { repositories: [...found.values()], truncated };
}
