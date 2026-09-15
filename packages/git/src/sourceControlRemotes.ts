import { execFile } from "node:child_process";
import {
  parseSourceControlRemoteUrl,
  type SourceControlRemote,
} from "@polyth/contracts/source-control";

export type GitRemoteDirection = "fetch" | "push";

export interface GitSourceControlRemote extends SourceControlRemote {
  remoteName: string;
  direction: GitRemoteDirection;
}

export interface GitSourceControlRemoteInspection {
  remotes: GitSourceControlRemote[];
  rejected: Array<{ remoteName: string; direction: GitRemoteDirection }>;
}

export type GitRemoteExec = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const systemGitExec: GitRemoteExec = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.POLYTH_GIT_BIN ?? "git",
      args,
      { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(String(stderr || error.message).trim()), { cause: error }));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

const outputLines = (stdout: string): string[] =>
  stdout.split("\n").map((value) => value.endsWith("\r") ? value.slice(0, -1) : value).filter((value) => value.length > 0);

const remoteNames = (stdout: string): string[] =>
  outputLines(stdout).map((value) => value.trim()).filter(Boolean);

/**
 * Inspect the repository's configured fetch and push targets without exposing
 * credentials. Every URL is normalized through the shared source-control
 * parser; URLs that cannot be safely represented are reported only by remote
 * name/direction so the client can fail closed without receiving the raw URL.
 */
export async function inspectGitSourceControlRemotes(
  cwd: string,
  exec: GitRemoteExec = systemGitExec,
): Promise<GitSourceControlRemoteInspection> {
  const names = remoteNames((await exec(cwd, ["remote"])).stdout);
  const remotes: GitSourceControlRemote[] = [];
  const rejected: GitSourceControlRemoteInspection["rejected"] = [];
  const seen = new Set<string>();
  const rejectedSeen = new Set<string>();

  for (const remoteName of names) {
    for (const direction of ["fetch", "push"] as const) {
      const args = direction === "push"
        ? ["remote", "get-url", "--push", "--all", "--", remoteName]
        : ["remote", "get-url", "--all", "--", remoteName];
      let output: string;
      try {
        output = (await exec(cwd, args)).stdout;
      } catch {
        // A missing push URL is not an unsafe URL; Git commonly falls back to
        // the fetch URL. The fetch side still gives us a safe repository host.
        if (direction === "push") continue;
        throw new Error(`Unable to inspect Git remote ${remoteName}.`);
      }

      // Do not trim Git URLs here. The shared parser deliberately rejects
      // leading/trailing whitespace, so normalizing first would weaken its
      // validation contract.
      for (const raw of outputLines(output)) {
        const parsed = parseSourceControlRemoteUrl(raw);
        if (!parsed) {
          const key = `${remoteName}\0${direction}`;
          if (!rejectedSeen.has(key)) {
            rejectedSeen.add(key);
            rejected.push({ remoteName, direction });
          }
          continue;
        }
        const key = `${remoteName}\0${direction}\0${parsed.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        remotes.push({ remoteName, direction, ...parsed });
      }
    }
  }

  return { remotes, rejected };
}
