import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describeInstallSource, type RepositoryArchiveDownloader } from "@polyth/plugins";
import { GIT_BINARY_ENV, resolveExecutable } from "@polyth/kernel/executable";

interface ArchiveExecOptions {
  cwd?: string;
  maxBytes: number;
  timeoutMs: number;
  diskLimit?: { dir: string; bytes: number };
  sshAgent?: string;
}

export type ArchiveExec = (bin: string, args: string[], opts: ArchiveExecOptions) => Promise<Buffer>;

const failure = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });
const SSH_OPTIONS = ["-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10"];
const SSH_COMMAND = `ssh ${SSH_OPTIONS.join(" ")}`;

function directoryBytes(dir: string): number {
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    bytes += stat.isDirectory() ? directoryBytes(path) : stat.size;
  }
  return bytes;
}

const defaultExec: ArchiveExec = (bin, args, opts) => new Promise((resolve, reject) => {
  // gh owns its credentials. Never extract a token, enable debug logging, or
  // pass authentication into an arbitrary URL. Git only gets a fixed SSH host.
  const env: NodeJS.ProcessEnv = { ...process.env, GH_DEBUG: "", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
  if (opts.sshAgent) env.SSH_AUTH_SOCK = opts.sshAgent;
  if (bin === "git") {
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_")) delete env[key];
    }
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_SSH_COMMAND: SSH_COMMAND,
    });
  }
  let exceeded = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const child = execFile(resolveExecutable(bin, bin === "git" ? { overrideEnv: GIT_BINARY_ENV } : {}), args, {
    cwd: opts.cwd,
    env,
    encoding: "buffer",
    maxBuffer: opts.maxBytes,
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (monitor) clearInterval(monitor);
    if (!exceeded && opts.diskLimit) {
      try { exceeded = directoryBytes(opts.diskLimit.dir) > opts.diskLimit.bytes; } catch { /* report the command result */ }
    }
    if (exceeded) reject(Object.assign(new Error("staging limit"), { code: "ARCHIVE_STAGE_LIMIT" }));
    else if (error) reject(Object.assign(error, { stderr: stderr.toString("utf8") }));
    else resolve(stdout);
  });
  if (opts.diskLimit) {
    const limit = opts.diskLimit;
    monitor = setInterval(() => {
      try {
        if (directoryBytes(limit.dir) <= limit.bytes) return;
      } catch {
        // Git may rename/remove a pack file during inspection; recheck.
        return;
      }
      exceeded = true;
      child.kill("SIGKILL");
    }, 100);
    monitor.unref();
  }
});

function commandError(cause: unknown): { code?: string | number; stderr: string; killed?: boolean } {
  const err = cause as { code?: string | number; stderr?: string; killed?: boolean } | null;
  return { code: err?.code, stderr: err?.stderr ?? "", killed: err?.killed };
}

function downloadError(cause: unknown, method: "GitHub CLI" | "SSH"): Error {
  const { code, stderr, killed } = commandError(cause);
  if (code === "ARCHIVE_STAGE_LIMIT") return failure("Repository download exceeds the staging size limit.");
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return failure("Repository archive exceeds the download size limit.");
  if (killed) return failure(`${method} repository download timed out.`);
  if (code === "ENOENT") return failure(`Git is required to download repositories with SSH keys.`);
  if (/HTTP 404|Repository not found|couldn't find remote ref|not a valid object/i.test(stderr)) {
    return failure(`${method} cannot access this repository or ref. Check the selected account/key and repository permissions.`);
  }
  if (/HTTP 403|Permission denied/i.test(stderr)) return failure(`${method} was denied access to this repository. Check repository permissions.`);
  if (/HTTP 429|rate limit/i.test(stderr)) return failure("GitHub rate limit reached. Try again later.");
  return failure(`${method} repository download failed. Check the connection and repository access.`);
}

function sshPath(value: string): string {
  return value.replace(/^~(?=\/|$)/, homedir()).replace(/%[dhrup%]/g, token => ({
    "%d": homedir(), "%h": "github.com", "%r": "git", "%u": userInfo().username, "%p": "22", "%%": "%",
  })[token]!);
}

async function hasSshIdentity(exec: ArchiveExec): Promise<boolean> {
  let config: string;
  try {
    config = (await exec("ssh", ["-G", ...SSH_OPTIONS, "git@github.com"], { maxBytes: 64 * 1024, timeoutMs: 10_000 })).toString("utf8");
  } catch (cause) {
    if (commandError(cause).code === "ENOENT") return false;
    throw failure("GitHub SSH configuration could not be inspected.");
  }
  // Inspect filenames and agent metadata only; never open a private key.
  for (const match of config.matchAll(/^identityfile (.+)$/gm)) {
    try { if (statSync(sshPath(match[1]!)).isFile()) return true; } catch { /* no key at this configured path */ }
  }
  const agent = config.match(/^identityagent (.+)$/m)?.[1];
  if (agent === "none") return false;
  const socket = agent && agent !== "SSH_AUTH_SOCK" ? sshPath(agent) : process.env.SSH_AUTH_SOCK;
  if (!socket) return false;
  try {
    await exec("ssh-add", ["-l"], { maxBytes: 16 * 1024, timeoutMs: 10_000, sshAgent: socket });
    return true;
  } catch (cause) {
    const { code } = commandError(cause);
    if (code === "ENOENT" || code === 1 || code === 2) return false;
    throw failure("GitHub SSH agent could not be inspected.");
  }
}

/** null means no usable local authentication (or a different forge). An
 * authenticated failure must never silently downgrade to an anonymous fetch. */
export function createGithubArchiveDownloader(deps: { exec?: ArchiveExec } = {}): RepositoryArchiveDownloader {
  const exec = deps.exec ?? defaultExec;
  return async (source, maxBytes) => {
    const described = describeInstallSource(source);
    if (described.kind !== "repository" || !described.archiveUrl) return null;
    const archive = new URL(described.archiveUrl);
    if (archive.hostname !== "codeload.github.com") return null;
    const match = archive.pathname.match(/^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/zip\/(.+)$/);
    if (!match) throw failure("Invalid GitHub repository source.");
    const [, owner, repo, rawRef] = match;
    let ref: string;
    try { ref = decodeURIComponent(rawRef!); }
    catch { throw failure("Invalid GitHub repository ref."); }
    if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/.test(ref) || ref.split("/").some(part => !part || part === "." || part === "..")) {
      throw failure("Invalid GitHub repository ref.");
    }
    const options = { maxBytes, timeoutMs: 60_000 };
    try {
      return await exec("gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`], options);
    } catch (cause) {
      const { code, stderr } = commandError(cause);
      if (code !== "ENOENT" && !/gh auth login|not logged in|authentication token|HTTP 401/i.test(stderr)) {
        throw downloadError(cause, "GitHub CLI");
      }
    }

    if (!await hasSshIdentity(exec)) return null;
    // GitHub's SSH test intentionally exits 1 after successful authentication.
    // Strict host verification and BatchMode keep this probe non-interactive.
    try {
      const output = await exec("ssh", ["-T", ...SSH_OPTIONS, "git@github.com"], { maxBytes: 16 * 1024, timeoutMs: 20_000 });
      if (!/successfully authenticated/i.test(output.toString("utf8"))) throw failure("GitHub SSH authentication could not be verified.");
    } catch (cause) {
      const { code, stderr } = commandError(cause);
      if (code === "ENOENT" || /Permission denied \(publickey\)/i.test(stderr)) return null;
      if (code !== 1 || !/successfully authenticated/i.test(stderr)) {
        if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
          throw failure("GitHub SSH host verification failed. Verify github.com in your SSH configuration before installing.");
        }
        throw downloadError(cause, "SSH");
      }
    }

    const temp = mkdtempSync(join(tmpdir(), "polyth-github-archive-"));
    try {
      const gitDir = join(temp, "repository.git");
      const hooks = join(temp, "empty-hooks");
      mkdirSync(hooks);
      const config = ["-c", `core.hooksPath=${hooks}`, "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always"];
      const gitOptions = { cwd: temp, maxBytes: 64 * 1024, timeoutMs: 60_000, diskLimit: { dir: temp, bytes: maxBytes * 4 } };
      await exec("git", [...config, "init", "--bare", `--template=${hooks}`, gitDir], gitOptions);
      await exec("git", [...config, `--git-dir=${gitDir}`, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", `ssh://git@github.com/${owner}/${repo}.git`, ref], gitOptions);
      // A bare fetch avoids checkout hooks, filters and submodules. The ZIP
      // rejoins the package manager's normal hardened extraction/review path.
      return await exec("git", [...config, `--git-dir=${gitDir}`, "archive", "--format=zip", "FETCH_HEAD"], { ...gitOptions, maxBytes });
    } catch (cause) {
      throw downloadError(cause, "SSH");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };
}
