// Project source-control accounts: which code-hosting account (a GitHub `gh`
// login, a GitLab account connected in Polyth, …) clones a repository and then
// authenticates its fetch, pull and push. Provider packages own their accounts
// and credentials and register a SourceControlCredentialProvider; this module
// owns the per-project binding and the per-process transport injection.
//
// Credentials are handed to exactly one Git child process through an inline,
// origin-scoped credential helper that reads them from that child's
// environment. Nothing is written to the repository's Git config, the URL or
// any log; the helper is scoped to the account's origin, so other hosts keep
// the user's own helpers.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import {
  parseSourceControlRemoteUrl,
  sourceControlAccountMatchesRemote,
  type SourceControlAccountBinding,
  type SourceControlCommitIdentity,
  type SourceControlCredentialProvider,
  type SourceControlCredentialRegistry,
  type SourceControlHostingAccount,
  type SourceControlRemote,
  type SourceControlTransportCredential,
} from "@polyth/contracts/source-control";
import { atomicWriteSync } from "@polyth/plugins";
import { resolveConnectionOwner, type PackageServicePolicy } from "@polyth/plugins/people";
import { gitAccountRequired, type GitActor } from "./actingPerson.ts";
import { resolveGitBinary } from "./gitBinary.ts";

const fail = (code: string, message: string, status?: number): never => {
  throw Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
};

export function createSourceControlCredentialRegistry(): SourceControlCredentialRegistry {
  const providers = new Map<string, SourceControlCredentialProvider>();
  return {
    register(provider) {
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(provider.id)) fail("invalid-input", "invalid source-control provider id");
      providers.set(provider.id, provider);
      return () => { if (providers.get(provider.id) === provider) providers.delete(provider.id); };
    },
    get: (id) => providers.get(id),
    list: () => [...providers.values()],
  };
}

// ---- transport injection -----------------------------------------------------

export interface GitTransportAuth {
  /** Origin the credential applies to, e.g. "https://github.com". */
  origin: string;
  credential: SourceControlTransportCredential;
}

const transportAuth = new AsyncLocalStorage<GitTransportAuth>();
/** Git subcommands that talk to a remote. Others never see the credential. */
const TRANSPORT_COMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
const USERNAME_ENV = "POLYTH_GIT_CREDENTIAL_USERNAME";
const PASSWORD_ENV = "POLYTH_GIT_CREDENTIAL_PASSWORD";
// Answers only `get`; `store`/`erase` are no-ops so nothing is persisted by Git.
const HELPER = `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$${USERNAME_ENV}" "$${PASSWORD_ENV}"; }; f`;

const validCredential = (value: SourceControlTransportCredential): boolean =>
  typeof value.username === "string" && typeof value.password === "string"
  && value.username.length > 0 && value.password.length > 0
  && value.username.length <= 256 && value.password.length <= 8192
  && !/[\0\r\n]/.test(value.username) && !/[\0\r\n]/.test(value.password);

const validOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
  } catch { return false; }
};

const hostCredentialsOff = new AsyncLocalStorage<true>();
// No keys, no agent, no ~/.ssh/config: an SSH remote cannot sign in at all.
const NO_HOST_SSH = "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes";

/** Run `fn` with `auth` applied to every Git transport command it starts.
 *  `hostCredentials: false` (anyone but the instance owner on a local-trusted
 *  install) also hides the host's own credential helpers, askpass programs
 *  and SSH keys from every transport command, so a remote Polyth did not
 *  resolve an account for (another upstream, a submodule host) cannot borrow
 *  the installation's logins. */
export function withGitTransportAuth<T>(auth: GitTransportAuth | null, fn: () => Promise<T>, options: { hostCredentials?: boolean } = {}): Promise<T> {
  const run = options.hostCredentials === false ? () => hostCredentialsOff.run(true, fn) : fn;
  if (!auth) return run();
  if (!validOrigin(auth.origin) || !validCredential(auth.credential)) {
    return Promise.reject(Object.assign(new Error("source-control credential is invalid"), { code: "auth-required", status: 422 }));
  }
  return transportAuth.run(auth, run);
}

const transportSshKey = new AsyncLocalStorage<string>();
const SSH_KEY_PATH = /^\/[\w@%+=:,./~-]+$/;

/** Run `fn` with every Git transport command it starts signing in over SSH
 * with exactly `identityFile` (an already validated private-key path). The
 * command never prompts: a key that cannot sign unattended fails the command. */
export function withGitSshIdentity<T>(identityFile: string, fn: () => Promise<T>): Promise<T> {
  if (!SSH_KEY_PATH.test(identityFile)) {
    return Promise.reject(Object.assign(new Error("SSH key path is invalid"), { code: "invalid-input", status: 400 }));
  }
  return transportSshKey.run(identityFile, fn);
}

// ---- commit identity injection -----------------------------------------------

const commitIdentity = new AsyncLocalStorage<SourceControlCommitIdentity & { unsigned?: boolean }>();
/** Git subcommands that can write a commit (or a stash/notes/tag object). */
const COMMIT_COMMANDS = new Set(["commit", "commit-tree", "merge", "pull", "rebase", "cherry-pick", "revert", "stash", "am", "notes", "tag"]);
const IDENTITY_TEXT = /^[^\0-\x1f\x7f<>]{1,256}$/;

export const validCommitIdentity = (value: SourceControlCommitIdentity): boolean =>
  typeof value?.name === "string" && typeof value.email === "string"
  && IDENTITY_TEXT.test(value.name) && value.name.trim() === value.name
  && IDENTITY_TEXT.test(value.email) && /^[^\s@]+@[^\s@]+$/.test(value.email);

/** Run `fn` with every commit-writing Git command it starts authored and
 * committed as `identity`, passed to that one child (`-c user.name/email`,
 * committer env). Never written to any Git config. Null keeps the checkout's
 * own configuration (the installation owner's ambient identity). `unsigned`
 * also turns off the checkout's commit/tag signing for that child. */
export function withGitCommitIdentity<T>(identity: (SourceControlCommitIdentity & { unsigned?: boolean }) | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!identity) return fn();
  if (!validCommitIdentity(identity)) {
    return Promise.reject(Object.assign(new Error("Git name or email is invalid"), { code: "invalid-input", status: 400, mutationOutcome: "not-started" }));
  }
  return commitIdentity.run({ name: identity.name, email: identity.email, ...(identity.unsigned ? { unsigned: true } : {}) }, fn);
}

/** The identity of the enclosing `withGitCommitIdentity`, if any. */
export const currentGitCommitIdentity = (): SourceControlCommitIdentity | undefined => commitIdentity.getStore();

const commandOf = (args: readonly string[]): string | undefined =>
  args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c" && args[index - 1] !== "-C");

/** Extra `git` arguments and environment for the current transport context. */
export function gitTransportInvocation(args: readonly string[]): { args: string[]; env: Record<string, string | undefined> } {
  const identity = commitIdentity.getStore();
  const command = commandOf(args);
  if (identity && command && COMMIT_COMMANDS.has(command)) {
    const inner = transportInvocation(args, command);
    return {
      args: [
        "-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`,
        ...(identity.unsigned ? ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"] : []),
        ...inner.args,
      ],
      env: {
        ...inner.env,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        // A server environment's author must not override the actor's; Git
        // still keeps the original author of commits it replays.
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
      },
    };
  }
  return transportInvocation(args, command);
}

function transportInvocation(args: readonly string[], command: string | undefined): { args: string[]; env: Record<string, string> } {
  if (!command || !TRANSPORT_COMMANDS.has(command)) return { args: [...args], env: {} };
  const inner = ownTransportInvocation(args);
  if (!hostCredentialsOff.getStore()) return inner;
  return {
    // Resets every helper collected from the host's config files; the
    // account's own origin-scoped helper (if any) follows and still answers.
    args: ["-c", "credential.helper=", ...inner.args],
    env: { GIT_SSH_COMMAND: NO_HOST_SSH, GIT_ASKPASS: "", SSH_ASKPASS: "", ...inner.env, GIT_TERMINAL_PROMPT: "0" },
  };
}

function ownTransportInvocation(args: readonly string[]): { args: string[]; env: Record<string, string> } {
  const auth = transportAuth.getStore();
  const sshKey = transportSshKey.getStore();
  if (sshKey) {
    return {
      args: [...args],
      env: { GIT_SSH_COMMAND: `ssh -i ${sshKey} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new` },
    };
  }
  if (!auth) return { args: [...args], env: {} };
  return {
    // An empty helper value resets the helpers collected so far for this
    // origin (including URL-scoped global ones), then ours answers.
    args: ["-c", `credential.${auth.origin}.helper=`, "-c", `credential.${auth.origin}.helper=${HELPER}`, ...args],
    env: { [USERNAME_ENV]: auth.credential.username, [PASSWORD_ENV]: auth.credential.password },
  };
}

const gitBin = (): string => resolveGitBinary();
const execGit = (cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolvePromise) => {
    execFile(gitBin(), args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolvePromise({ ok: !error, stdout: String(stdout) }));
  });

/** The configured URL of one remote, or null when it does not exist. */
export async function gitRemoteUrl(root: string, remote: string): Promise<string | null> {
  if (!/^[\w.-]{1,120}$/.test(remote)) return null;
  const result = await execGit(root, ["remote", "get-url", "--", remote]);
  const url = result.stdout.trim().split("\n")[0]?.trim() ?? "";
  return result.ok && url ? url : null;
}

/** Record the account's login (never its secret) for the origin in the
 * repository config, so the user's own credential helpers — in Terminal or an
 * agent shell — pick the same account when Polyth is not the one pushing. */
export async function rememberCredentialUsername(root: string, binding: Pick<SourceControlAccountBinding, "origin" | "login">): Promise<void> {
  if (!validOrigin(binding.origin) || !/^[^\0\r\n\s]{1,256}$/.test(binding.login)) return;
  await execGit(root, ["config", "--local", `credential.${binding.origin}.username`, binding.login]);
}

// ---- project bindings --------------------------------------------------------

const bindingFile = (storage: SpaceStorage): string =>
  join(storage.packageDir("git"), "source-control-accounts.json");

const isBinding = (value: unknown): value is SourceControlAccountBinding => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["projectId", "provider", "accountId", "login", "origin"].every((key) =>
    typeof row[key] === "string" && (row[key] as string).length > 0 && (row[key] as string).length <= 4096)
    && typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt);
};

function loadBindings(storage: SpaceStorage): SourceControlAccountBinding[] {
  try {
    const value = JSON.parse(readFileSync(bindingFile(storage), "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isBinding);
  } catch {
    return [];
  }
}

function saveBindings(storage: SpaceStorage, rows: SourceControlAccountBinding[]): void {
  mkdirSync(storage.packageDir("git"), { recursive: true, mode: 0o700 });
  atomicWriteSync(bindingFile(storage), JSON.stringify(rows, null, 2), 0o600);
}

export interface SourceControlAccountService {
  /** Accounts of every registered provider, optionally only those that apply to `repository`. */
  accounts(space: SpaceContext, repository?: string): Promise<{
    accounts: SourceControlHostingAccount[];
    unavailable: Array<{ provider: string; reason: string }>;
  }>;
  /** Resolve one account that must apply to `repository`. */
  account(space: SpaceContext, ref: { provider: string; accountId: string }, repository: string): Promise<{
    provider: SourceControlCredentialProvider;
    account: SourceControlHostingAccount;
    remote: SourceControlRemote;
  }>;
  /** Transport auth for `repository`, or null when Git's own helpers apply. */
  transportAuth(space: SpaceContext, ref: { provider: string; accountId: string }, repository: string): Promise<GitTransportAuth | null>;
  binding(space: SpaceContext, projectId: string): SourceControlAccountBinding | null;
  bind(space: SpaceContext, input: {
    projectId: string; provider: string; accountId: string; repository: string;
  }): Promise<SourceControlAccountBinding>;
  unbind(space: SpaceContext, projectId: string): boolean;
  /** Let the account's provider record its own binding for the project. */
  bindProvider(space: SpaceContext, input: {
    projectId: string; provider: string; accountId: string; repository: string;
  }): Promise<void>;
  /** Transport auth for a bound project's remote URL; null when nothing applies.
   *  A stale or unusable binding degrades to the user's own Git helpers.
   *  Ignores who is acting: use `actorTransportAuth` for anything a person
   *  or a session asks for. */
  projectTransportAuth(space: SpaceContext, projectId: string, remoteUrl: string | null): Promise<GitTransportAuth | null>;
  /**
   * Transport credentials for `remoteUrl` on behalf of `actor` (Spaces §14.4):
   * the actor's own account turned on in this Space → the Space service
   * account (the project's bound account; for UI requests whenever it exists,
   * for agent and system work only under the Space policy) → the host's own
   * helpers, `gh` and SSH keys only for the instance owner on local-trusted.
   * Anything else is refused (`git-account-required`, nothing started).
   * Null means "run with Git's own helpers"; a remote that is not a network
   * URL (a local path) needs no credential and also yields null.
   * `space` is the actor's own context (or the system context for system
   * work): providers list only the accounts that context may use.
   */
  actorTransportAuth(input: {
    actor: GitActor;
    space: SpaceContext;
    remoteUrl: string | null;
    projectId?: string;
    /** An account the person picked explicitly (clone). */
    account?: { provider: string; accountId: string } | null;
  }): Promise<GitTransportAuth | null>;
}

export function createSourceControlAccountService(deps: {
  registry: SourceControlCredentialRegistry;
  storage(space: SpaceContext): SpaceStorage;
  /** Active membership (host.people.isMember); absent = trust the context. */
  isMember?(userId: string, spaceId: string): boolean;
  /** May agents/system work use the Space service account? Default off. */
  servicePolicy?(spaceId: string): PackageServicePolicy;
}): SourceControlAccountService {
  const remoteOf = (repository: string): SourceControlRemote =>
    parseSourceControlRemoteUrl(repository.trim()) ?? fail("invalid-input", "repository must be a valid Git remote URL", 400);

  const service: SourceControlAccountService = {
    async accounts(space, repository) {
      const remote = repository ? remoteOf(repository) : null;
      const unavailable: Array<{ provider: string; reason: string }> = [];
      const rows = await Promise.all(deps.registry.list().map(async (provider) => {
        try {
          return await provider.accounts(space);
        } catch (error) {
          unavailable.push({ provider: provider.id, reason: error instanceof Error ? error.message : "unavailable" });
          return [];
        }
      }));
      const accounts = rows.flat().filter((account) => !remote || sourceControlAccountMatchesRemote(account, remote));
      return { accounts, unavailable };
    },

    async account(space, ref, repository) {
      const remote = remoteOf(repository);
      const provider = deps.registry.get(String(ref.provider ?? "")) ?? fail("not-found", "source-control provider is unavailable", 404);
      const account = (await provider.accounts(space)).find((row) => row.accountId === ref.accountId)
        ?? fail("not-found", "source-control account not found", 404);
      if (!sourceControlAccountMatchesRemote(account, remote)) {
        fail("account-not-applicable", `${account.providerLabel} account @${account.login} belongs to another host`, 400);
      }
      return { provider, account, remote };
    },

    async transportAuth(space, ref, repository) {
      const { provider, account, remote } = await service.account(space, ref, repository);
      // SSH transport authenticates with SSH keys; tokens never apply.
      if (remote.protocol === "ssh") return null;
      const credential = await provider.credential(space, account.accountId);
      return credential ? { origin: new URL(account.origin).origin, credential } : null;
    },

    binding(space, projectId) {
      return loadBindings(deps.storage(space)).find((row) => row.projectId === projectId) ?? null;
    },

    async bind(space, input) {
      const { account } = await service.account(space, input, input.repository);
      const storage = deps.storage(space);
      const binding: SourceControlAccountBinding = {
        projectId: input.projectId,
        provider: account.provider,
        accountId: account.accountId,
        login: account.login,
        origin: account.origin,
        updatedAt: Date.now(),
      };
      saveBindings(storage, [...loadBindings(storage).filter((row) => row.projectId !== input.projectId), binding]);
      return binding;
    },

    unbind(space, projectId) {
      const storage = deps.storage(space);
      const rows = loadBindings(storage);
      const next = rows.filter((row) => row.projectId !== projectId);
      if (next.length === rows.length) return false;
      saveBindings(storage, next);
      return true;
    },

    async bindProvider(space, input) {
      const provider = deps.registry.get(input.provider);
      await provider?.bindProject?.(space, { projectId: input.projectId, accountId: input.accountId, repository: input.repository });
    },

    async projectTransportAuth(space, projectId, remoteUrl) {
      if (!remoteUrl) return null;
      const binding = service.binding(space, projectId);
      if (!binding) return null;
      const remote = parseSourceControlRemoteUrl(remoteUrl.trim());
      if (!remote || remote.protocol === "ssh" || !sourceControlAccountMatchesRemote(binding, remote)) return null;
      try {
        return await service.transportAuth(space, binding, remoteUrl.trim());
      } catch {
        return null;
      }
    },

    async actorTransportAuth({ actor, space, remoteUrl, projectId, account: chosen }) {
      const url = remoteUrl?.trim() ?? "";
      const remote = url ? parseSourceControlRemoteUrl(url) : null;
      if (!remote) {
        // A network address Polyth cannot attribute to a host must not reach
        // the host's own helpers on someone else's behalf.
        if (!actor.ambient && /^[a-z][a-z0-9+.-]*:\/\/|^[^/:]+@[^/:]+:/i.test(url) && !/^file:/i.test(url)) {
          throw gitAccountRequired("connect-your-account");
        }
        // No remote, or a local path/file remote: no network credential applies.
        return null;
      }
      if (remote.protocol === "ssh") {
        if (actor.ambient) return null;
        throw gitAccountRequired("ssh", remote.hostname);
      }
      const usable = (await service.accounts(space, url)).accounts;
      const ownerOf = (row: SourceControlHostingAccount) => row.owner ?? "service";
      const credentialOf = async (row: SourceControlHostingAccount): Promise<GitTransportAuth | null> => {
        const provider = deps.registry.get(row.provider) ?? fail("not-found", "source-control provider is unavailable", 404);
        const credential = await provider.credential(space, row.accountId);
        if (credential) return { origin: new URL(row.origin).origin, credential };
        // A "system" account authenticates through the host's own helpers.
        if (actor.ambient) return null;
        throw gitAccountRequired("installation", remote.hostname);
      };
      const policy = deps.servicePolicy?.(actor.spaceId) ?? { agentsMayUseService: false };
      const serviceAllowed = actor.origin === "person-ui" || policy.agentsMayUseService === true;

      if (chosen) {
        const row = usable.find((candidate) => candidate.provider === chosen.provider && candidate.accountId === chosen.accountId)
          ?? fail("not-found", "source-control account not found", 404);
        const owner = ownerOf(row);
        if (owner === "personal" || (owner === "service" && serviceAllowed) || (owner === "installation" && actor.ambient)) {
          return credentialOf(row);
        }
        throw gitAccountRequired(owner === "service" ? "service-not-allowed" : "installation", remote.hostname);
      }

      const binding = projectId ? service.binding(space, projectId) : null;
      const bound = binding
        ? usable.find((row) => row.provider === binding.provider && row.accountId === binding.accountId) ?? null
        : null;
      const personal = usable
        .filter((row) => ownerOf(row) === "personal" && row.transport === "token")
        .sort((a, b) => Number(b.login === binding?.login) - Number(a.login === binding?.login));
      const serviceAccount = bound && ownerOf(bound) === "service" ? bound : null;
      const decision = resolveConnectionOwner({
        ...(actor.userId ? { actorUserId: actor.userId } : {}),
        spaceId: actor.spaceId,
        isMember: (userId, spaceId) => deps.isMember?.(userId, spaceId) ?? true,
        personalEnabled: personal.map((row) => row.accountId),
        hasService: !!serviceAccount,
        policy,
        origin: actor.origin,
      });
      if (decision.kind === "personal") return credentialOf(personal[0]!);
      if (decision.kind === "service") return credentialOf(serviceAccount!);
      if (decision.reason === "not-a-member") throw gitAccountRequired(decision.reason, remote.hostname);
      if (actor.ambient) {
        // The owner keeps a project bound to one of the host's own logins.
        if (bound && ownerOf(bound) === "installation") return credentialOf(bound);
        return null;
      }
      throw gitAccountRequired(decision.reason, remote.hostname);
    },
  };
  return service;
}
