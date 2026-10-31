import {
  parseSourceControlRemoteUrl,
  type SourceControlRemote,
} from "@polyth/contracts/source-control";

export interface GitRemoteLocation extends SourceControlRemote {
  remoteName: string;
}

export type GitRemoteExec = (
  bin: "git",
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

/** Shared source-control parser; kept under the existing export for provider packages. */
export const parseGitRemoteUrl = parseSourceControlRemoteUrl;

/** Enumerate every configured fetch URL using argv-only local Git commands. */
export async function detectGitRemotes(
  cwd: string,
  exec: GitRemoteExec,
): Promise<GitRemoteLocation[]> {
  const names = (await exec("git", ["remote"], { cwd })).stdout
    .split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const found: GitRemoteLocation[] = [];
  for (const remoteName of names) {
    const output = await exec("git", ["remote", "get-url", "--all", "--", remoteName], { cwd });
    for (const raw of output.stdout.split(/\r?\n/)) {
      const parsed = parseGitRemoteUrl(raw);
      if (parsed) found.push({ remoteName, ...parsed });
    }
  }
  return found;
}
