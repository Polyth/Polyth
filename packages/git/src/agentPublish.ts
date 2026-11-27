// The agent's push: `polyth_git_publish` pushes a chat's checked-out branch as
// the person the chat acts for, through the same `actingGit` boundary as every
// other Git operation Polyth performs for a session. A shell `git push` would
// use the server OS account's own logins instead.
import { execFile } from "node:child_process";
import type { AgentCapabilityContribution, JsonObject, SessionProjection, ToolExecutionContext } from "@polyth/contracts";
import { scrubInheritedEnv } from "@polyth/kernel/inherited-env";
import { resolveGitBinary } from "./gitBinary.ts";
import type { createActingGit } from "./serverEntry.ts";
import { gitTransportInvocation } from "./sourceControlAccounts.ts";

export const GIT_PUBLISH_TOOL_ID = "git.polyth-git-publish";
/** Must keep the word `publish`: @polyth/permissions/risk rates such a package
 *  tool high-risk, so Auto-Approve never answers it. */
export const GIT_PUBLISH_TOOL_NAME = "polyth_git_publish";
export const GIT_PUBLISH_INSTRUCTION_ID = "git.policy.polyth-git-publish";

export const gitPublishInstruction = {
  descriptor: {
    id: GIT_PUBLISH_INSTRUCTION_ID,
    kind: "instruction" as const,
    owner: "git",
    scope: "deployment" as const,
    revision: "1",
    title: "Pushing Git branches",
    text: "On Polyth, push with polyth_git_publish so the push uses the account of the person this chat acts for. `git push` in the shell uses the server's own logins, which on a shared server every person's chats share.",
  },
} satisfies AgentCapabilityContribution;

export interface GitPublishToolDeps {
  projection(sessionId: string): SessionProjection | undefined | Promise<SessionProjection | undefined>;
  actingGit: ReturnType<typeof createActingGit>;
  /** Pushes `branch` of `root` to `remote`; runs inside `actingGit`, so the
   *  transport carries the acting person's credential. */
  push(root: string, remote: string, branch: string): Promise<void>;
  toplevel(cwd: string): Promise<string | null>;
  currentBranch(root: string): Promise<string | null>;
  /** True when the project's checkout lives on another host: its path must
   *  never be resolved (and pushed) on this one. */
  remoteProject?(projectId: string): Promise<boolean>;
}

const readLine = (cwd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(resolveGitBinary(), args, { cwd, timeout: 10_000, windowsHide: true, env: { ...scrubInheritedEnv(), GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolve(error ? null : String(stdout).replace(/\r?\n$/, "") || null));
  });

export const gitToplevel = (cwd: string): Promise<string | null> => readLine(cwd, ["rev-parse", "--show-toplevel"]);

/** The checked-out branch; null on a detached HEAD. */
export const gitCurrentBranch = (root: string): Promise<string | null> =>
  readLine(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Git settings that could send the person's credential to another host,
 *  through someone else's proxy or certificate, or hand the transport to
 *  another program. The agent can write repository and account config, so a
 *  push that carries a person's credential refuses them in every scope. */
const RISKY_CONFIG = [
  /^http\.(?:.+\.)?(?:proxy|proxyauthmethod|proxysslcainfo|proxysslcert|proxysslkey|sslverify|sslcainfo|sslcapath|sslbackend|curloptresolve)$/,
  /^url\..+\.(?:insteadof|pushinsteadof)$/,
  /^remote\..+\.(?:pushurl|proxy|proxyauthmethod|receivepack|uploadpack|vcs)$/,
  /^core\.gitproxy$/,
];
const RISKY_ENV = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GIT_SSL_NO_VERIFY", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "GIT_PROXY_COMMAND", "GIT_EXEC_PATH"];

/** `git config --null --list --show-scope`: the keys that make a push unsafe. */
export function riskyGitConfig(listing: string): string[] {
  const parts = listing.split("\0");
  const found = new Set<string>();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const scope = parts[index];
    const entry = parts[index + 1] ?? "";
    if (scope === "command") continue;
    const key = entry.split("\n", 1)[0]!.toLowerCase();
    if (RISKY_CONFIG.some((pattern) => pattern.test(key))) found.add(key);
  }
  return [...found];
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
const safeBranch = (name: string): boolean => BRANCH.test(name) && name !== "HEAD" && !name.endsWith(".")
  && !name.includes("..") && !name.includes("@{") && !name.includes("//")
  && !name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));

interface Ran { code: number; stdout: string; stderr: string }
const runGit = (root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> =>
  new Promise((resolve) => {
    execFile(resolveGitBinary(), args, {
      cwd: root,
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...scrubInheritedEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr || (error && !stderr ? error.message : "")),
    }));
  });

/**
 * The push behind `polyth_git_publish`. It runs inside `actingGit`, so the git
 * process carries the acting person's credential; everything the agent could
 * have prepared in the checkout is kept away from it: no hooks run (a hook
 * inherits that environment), the refspec is explicit and never forces
 * (`remote.<name>.push` is ignored), and settings or proxy variables that
 * could redirect or intercept the transport refuse the push.
 */
export async function agentSafePush(root: string, remote: string, branch: string): Promise<void> {
  if (!/^[\w.-]{1,120}$/.test(remote)) throw fail("invalid-input", "invalid remote");
  if (!safeBranch(branch)) throw fail("invalid-input", "invalid branch name");
  const listing = await runGit(root, ["config", "--null", "--list", "--show-scope"]);
  if (listing.code !== 0) throw fail("conflict", "Could not read this checkout's Git settings, so nothing was pushed.");
  const risky = riskyGitConfig(listing.stdout);
  const riskyEnv = RISKY_ENV.filter((name) => process.env[name]);
  if (risky.length > 0 || riskyEnv.length > 0) {
    throw fail("conflict", `Git settings could redirect this push (${[...risky, ...riskyEnv].slice(0, 6).join(", ")}), so nothing was pushed. Remove them, or push from Source control.`);
  }
  const args = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "push", "--no-verify", "--set-upstream", remote, `refs/heads/${branch}:refs/heads/${branch}`,
  ];
  const transport = gitTransportInvocation(args);
  const ran = await runGit(root, transport.args, transport.env as NodeJS.ProcessEnv);
  if (ran.code === 0) return;
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(ran.stderr)) {
    throw fail("conflict", "Push was rejected because the remote has commits this branch does not have. Pull or rebase first, then publish again.");
  }
  const said = ran.stderr.split("\n").filter((line) => line.trim() && !line.startsWith("hint:")).slice(-4).join("\n");
  throw fail("conflict", `git push failed: ${said || "no output"}`);
}

export function createGitPublishTool(deps: GitPublishToolDeps): AgentCapabilityContribution {
  const publish = async (input: JsonObject, context: ToolExecutionContext): Promise<string> => {
    const spaceId = context.spaceId;
    if (!spaceId) throw fail("forbidden", "This chat has no Space.");
    const projection = await deps.projection(context.sessionId);
    if (!projection || projection.projectId !== context.projectId || (projection.spaceId && projection.spaceId !== spaceId)) {
      throw fail("not-found", "This chat is not available.");
    }
    if (!context.actorUserId) throw fail("forbidden", "A push acts for a person, and this turn acts for no one.");
    if (projection.actor?.userId !== context.actorUserId) {
      throw fail("forbidden", "This chat acts for a different person than this turn, so nothing was pushed.");
    }
    if (await deps.remoteProject?.(context.projectId)) {
      throw fail("unsupported", "polyth_git_publish pushes only repositories on this server.");
    }
    const remote = input.remote === undefined ? "origin" : input.remote;
    if (typeof remote !== "string") throw fail("invalid-input", "remote must be a string");
    const root = await deps.toplevel(context.cwd);
    if (!root) throw fail("invalid-input", "This chat's working directory is not a Git checkout.");
    const branch = await deps.currentBranch(root);
    if (!branch) throw fail("conflict", "Cannot push from a detached HEAD.");
    // No `requester`: the credentials are the session actor's. A session from
    // before Spaces takes the grant's, so actingGit never runs unscoped.
    const session = projection.spaceId ? projection : { ...projection, spaceId };
    await deps.actingGit({ session, transport: { root, remote } }, () => deps.push(root, remote, branch));
    return `Pushed ${branch} to ${remote}.`;
  };

  return {
    descriptor: {
      id: GIT_PUBLISH_TOOL_ID,
      kind: "tool",
      owner: "git",
      scope: "deployment",
      revision: "1",
      name: GIT_PUBLISH_TOOL_NAME,
      description: "Push this chat's checked-out branch to the same-named branch of a remote with the GitHub/GitLab account that the person this chat acts for linked in Polyth (Profile → Accounts), or a Space service account when the Space lets agents use it. The server's own logins are used only for the instance owner of a local-trusted install. Prefer it over `git push` in the shell on a shared server. It never force-pushes, runs no Git hooks, and refuses when Git settings could redirect the push. The person is asked unless the chat has Full access.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          remote: { type: "string", description: "Remote name (default \"origin\")." },
        },
      },
      trust: "credentialed",
      mutating: true,
    },
    async execute(input, context) {
      return { output: await publish(input, context) };
    },
  };
}
