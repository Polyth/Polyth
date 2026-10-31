import type { AgentCapabilityContributionRegistry, Disposable, RouteHandler, RouteRequest } from "@polyth/contracts";
import { execFile } from "node:child_process";
import { detectGitRemotes } from "@polyth/code-hosting/remotes";
import { roleAtLeast } from "@polyth/contracts";
import { describeChangeRequest, hostingRoutes } from "@polyth/code-hosting/routes";
import { GIT_BINARY_ENV, resolveExecutable } from "@polyth/kernel/executable";

import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { resolveConnectionOwner } from "@polyth/plugins/people";
import type { GitService } from "@polyth/git";
import { contextMayUseInstallation, GIT_ACCOUNT_REQUIRED, isPersonId } from "@polyth/git/acting";
import { createPersonHostingAccounts, hostingOrigin, type PersonHostingAccounts } from "@polyth/git/person-accounts";
import { SOURCE_CONTROL_CREDENTIAL_REGISTRY, type SourceControlCredentialRegistry } from "@polyth/contracts/source-control";
import { createGithubCredentialProvider } from "./accounts.ts";
import {
  createGithubService,
  GITHUB_SIGNED_OUT,
  withGithubAuth,
  type GithubCallAuth,
  type GithubService,
  type GithubStatus,
} from "./index.ts";
import { createUserCache, type UserCache, type UserLoad } from "./userCache.ts";
import { createGithubPrWatch, type GithubPrWatch } from "./prWatch.ts";

export function githubRoutes(deps: Omit<Parameters<typeof hostingRoutes>[0], "provider" | "prefix" | "presentation" | "mergeStrategies"> & { github: GithubService }): RouteHandler {
  return hostingRoutes({ ...deps, provider: deps.github, prefix: "/api/github", mergeStrategies: ["squash", "merge", "rebase"], presentation: { changeRequest: "pull request", abbreviation: "PR", numberPrefix: "#", conflictEvent: "github/conflict-resolution-started" } });
}

/** Verify a GitHub token with the host's REST API and return its login. */
export type GithubTokenVerifier = (origin: string, token: string) => Promise<{ login: string }>;

const apiBase = (origin: string): string =>
  new URL(origin).hostname === "github.com" ? "https://api.github.com" : `${origin}/api/v3`;

const verifyWithGithub: GithubTokenVerifier = async (origin, token) => {
  const response = await fetch(`${apiBase(origin)}/user`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "Polyth" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) throw Object.assign(new Error("GitHub could not be reached."), { code: "unavailable", mutationOutcome: "not-started" });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("GitHub rejected this token."), { code: "auth-rejected", mutationOutcome: "not-started" });
  }
  const user = await response.json().catch(() => null) as { login?: unknown } | null;
  if (!response.ok || typeof user?.login !== "string") {
    throw Object.assign(new Error("GitHub returned an invalid user."), { code: "invalid-response", mutationOutcome: "not-started" });
  }
  return { login: user.login };
};

/** The remotes of a checkout, read with the local Git binary. */
const remotesAt = (path: string) => detectGitRemotes(path, (bin, args, opts) => new Promise((resolve, reject) => {
  execFile(resolveExecutable(bin, bin === "git" ? { overrideEnv: GIT_BINARY_ENV } : {}), args, { cwd: opts.cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error("Local Git inspection failed.")) : resolve({ stdout, stderr }));
}));

const CONNECT_REASON = "Connect your GitHub account in Profile → Accounts and turn it on for this Space.";

/**
 * A person's own GitHub accounts (Spaces §14.4): list (with whether each is on
 * in this Space), connect with a token, turn on/off per Space, remove. Every
 * route acts on the signed-in person only; the token never appears in a
 * response. Returns false for paths it does not own.
 */
export function githubAccountRoutes(deps: { people: PersonHostingAccounts; verify?: GithubTokenVerifier; installation(request: RouteRequest): boolean }): RouteHandler {
  const verify = deps.verify ?? verifyWithGithub;
  return async (request) => {
    const match = /^\/api\/github\/accounts(?:\/(p-[0-9a-f-]{36})(\/enabled)?)?$/.exec(request.path);
    if (!match) return false;
    const userId = request.space.userId;
    if (!isPersonId(userId)) throw Object.assign(new Error("GitHub accounts belong to a signed-in person."), { code: "forbidden" });
    const spaceId = request.space.spaceId;
    const [, accountId, enabled] = match;
    if (!accountId && request.method === "POST") {
      const input = await request.body();
      const origin = hostingOrigin(input.origin ?? "https://github.com");
      const token = String(input.token ?? "").trim();
      if (!token) throw Object.assign(new Error("Enter a GitHub token."), { code: "invalid-input", mutationOutcome: "not-started" });
      const user = await verify(origin, token);
      const label = typeof input.label === "string" ? input.label : user.login;
      const account = deps.people.connect(userId, { origin, login: user.login, label }, token, input.enabled === false ? undefined : spaceId);
      request.json(200, { ok: true, data: deps.people.view(userId, spaceId).find((row) => row.id === account.id) });
      return true;
    }
    if (accountId && enabled && request.method === "PUT") {
      const input = await request.body();
      if (typeof input.enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false"), { code: "invalid-input" });
      deps.people.setEnabled(userId, spaceId, accountId, input.enabled);
    } else if (accountId && !enabled && request.method === "DELETE") {
      if (!deps.people.remove(userId, accountId)) throw Object.assign(new Error("GitHub account not found."), { code: "not-found" });
    } else if (accountId || request.method !== "GET") {
      return false;
    }
    request.json(200, { ok: true, data: deps.people.view(userId, spaceId), installation: deps.installation(request) });
    return true;
  };
}

/** What {@link githubRequestAuth} decided; `accountId` names the person's
 *  account, never its token. */
export type GithubRequestAccess =
  | { kind: "personal"; auth: GithubCallAuth; accountId: string }
  | { kind: "installation" }
  | { kind: "refused"; reason: string };

/**
 * Whose GitHub account the hosting routes of one request use: the person's
 * own account for one of the project's hosts, turned on in this Space → the
 * host's `gh` logins for the instance owner on local-trusted (null) → refused.
 * GitHub has no Space service account.
 */
export function githubRequestAuth(input: {
  people: PersonHostingAccounts | undefined;
  request: Pick<RouteRequest, "space"> & Partial<Pick<RouteRequest, "principal">>;
  hosts: readonly string[];
  isMember(userId: string, spaceId: string): boolean;
}): GithubRequestAccess {
  const { request } = input;
  const accounts = (input.people?.enabledIn(request.space.userId, request.space.spaceId) ?? [])
    .map((row) => ({ row, host: new URL(row.origin).host.toLowerCase() }))
    .filter(({ host }) => input.hosts.length === 0 ? host === "github.com" : input.hosts.includes(host))
    .sort((a, b) => Number(b.host === "github.com") - Number(a.host === "github.com"));
  const decision = resolveConnectionOwner({
    actorUserId: request.space.userId,
    spaceId: request.space.spaceId,
    isMember: input.isMember,
    personalEnabled: accounts.map(({ row }) => row.id),
    hasService: false,
    policy: { agentsMayUseService: false },
    origin: "person-ui",
  });
  if (decision.kind === "personal") {
    const { row, host } = accounts[0]!;
    return { kind: "personal", accountId: row.id, auth: { token: input.people!.token(request.space.userId, request.space.spaceId, row.id), host } };
  }
  if (decision.kind === "refused" && decision.reason !== "not-a-member" && contextMayUseInstallation(request.space, request.principal)) {
    return { kind: "installation" };
  }
  return { kind: "refused", reason: decision.kind === "refused" && decision.reason === "not-a-member" ? "You are no longer a member of this Space." : CONNECT_REASON };
}

/** Who is signed in is remembered per Space, person and the account that
 *  answers for them, never per project: the same person sees the same avatar
 *  in every project, and another person's or Space's answer is never theirs. */
const userKey = (request: RouteRequest, access: Exclude<GithubRequestAccess, { kind: "refused" }>): string =>
  `${request.space.spaceId}:${request.space.userId}:${access.kind === "personal" ? `account:${access.accountId}` : "installation"}`;

/** Replaceable parts of the package, for tests; the host only ever passes `host`. */
export interface GithubPackageSeams {
  github?: GithubService;
  users?: UserCache;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return createGithubPackage(host);
}

export function createGithubPackage(host: ServerPackageHost, seams: GithubPackageSeams = {}): ServerPackage {
  // Shared with the walkthrough package (PR diff capture) — published at load
  // time under the well-known key.
  const github = seams.github ?? createGithubService();
  host.services.provide(serverServiceKey<GithubService>("github"), github);
  let routes: RouteHandler | null = null;
  let unregisterCredentials: (() => void) | undefined;
  let prWatch: GithubPrWatch | null = null;
  let toolRegistrations: Disposable[] = [];
  const users = seams.users ?? createUserCache();
  const people = host.people ? createPersonHostingAccounts(host.people, "github") : undefined;
  const isMember = (userId: string, spaceId: string) => host.people?.isMember(userId, spaceId) ?? true;
  const installation = (request: RouteRequest) => contextMayUseInstallation(request.space, request.principal);
  const loadUser = async (access: Exclude<GithubRequestAccess, { kind: "refused" }>, cwd: string): Promise<UserLoad> => {
    try {
      const result = await withGithubAuth(access.kind === "personal" ? access.auth : null, () => github.user(cwd));
      return result.ok ? { ok: true, user: result.data } : { ok: false, signedOut: result.code === GITHUB_SIGNED_OUT };
    } catch {
      return { ok: false, signedOut: false };
    }
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["github"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const git = host.services.require(serverServiceKey<GitService>("git"));
      // A person's own accounts and, for the instance owner, the host's gh
      // logins authenticate clones and pushes (see the Git package's
      // source-control accounts).
      unregisterCredentials = host.services
        .get(serverServiceKey<SourceControlCredentialRegistry>(SOURCE_CONTROL_CREDENTIAL_REGISTRY))
        ?.register(createGithubCredentialProvider({ allowed: (space) => contextMayUseInstallation(space), ...(people ? { people } : {}) }));
      const accountRoutes = people ? githubAccountRoutes({ people, installation }) : null;
      // A chat's pull request watch polls as the person who started it.
      prWatch = createGithubPrWatch({
        host,
        github,
        remoteHosts: async (path) => [...new Set((await remotesAt(path)).map((remote) => remote.hostname.toLowerCase()))],
        decide: (space, hosts) => {
          const access = githubRequestAuth({ people, request: { space }, hosts, isMember });
          return access.kind === "personal" ? { kind: "personal", auth: access.auth } : access;
        },
      });
      const capabilities = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      toolRegistrations = capabilities
        ? [capabilities.register("github", prWatch.skill), capabilities.register("github", prWatch.tool)]
        : [];
      const watchRoutes = prWatch;
      routes = async request => {
        if (!request.path.startsWith("/api/github/")) return false;
        if (accountRoutes && await accountRoutes(request)) return true;
        const scoped = host.forSpace(request.space);
        const input = request.method === "GET" ? {} : await request.body();
        const projectId = String(input.projectId ?? request.url.searchParams.get("projectId") ?? "");
        const project = await scoped.projects.get(projectId);
        if (!project) { request.json(404, { ok: false, reason: "Project not found." }); return true; }
        if (request.method !== "GET" && !roleAtLeast(request.space.role, "member")) { request.json(403, { ok: false, reason: "Your Space role cannot perform this operation." }); return true; }
        if (input.sessionId) {
          const session = await scoped.sessions.snapshot(String(input.sessionId));
          if (session.projectId !== projectId) { request.json(404, { ok: false, reason: "Session not found." }); return true; }
        }
        // The watch resolves the person's account itself, when it polls.
        if (await watchRoutes.route(request, projectId, input)) return true;
        const remotesOf = () => remotesAt(project.path);
        // A person's account applies to the hosts of this project's remotes.
        const accessFor = (remotes: ReadonlyArray<{ hostname: string }>) => githubRequestAuth({
          people, request, hosts: [...new Set(remotes.map((remote) => remote.hostname.toLowerCase()))], isMember,
        });
        // The header's passive status and the Git view's context only need to
        // know who is signed in: no repository lookup, and one `gh api user`
        // per account (not per project, not per request) behind `users`.
        const passive = request.path === "/api/github/status" && request.url.searchParams.get("passive") === "true";
        if (request.path === "/api/github/context" || passive) {
          const remotes = passive ? await remotesOf().catch(() => []) : await remotesOf();
          const access = accessFor(remotes);
          const user = access.kind === "refused" ? null : await users.lookup(userKey(request, access), () => loadUser(access, project.path));
          request.json(200, !passive ? { ok: true, data: { remotes, user } }
            : user ? { installed: true, authenticated: true, user, repo: null }
            : access.kind === "refused" ? { installed: true, authenticated: false, user: null, repo: null, reason: access.reason, code: GIT_ACCOUNT_REQUIRED }
            : { installed: false, authenticated: false, user: null, repo: null });
          return true;
        }
        const access = accessFor(await remotesOf().catch(() => []));
        if (access.kind === "refused") {
          if (request.path === "/api/github/status") {
            request.json(200, { installed: true, authenticated: false, user: null, repo: null, reason: access.reason, code: GIT_ACCOUNT_REQUIRED });
          } else if (request.method === "GET") {
            request.json(200, { ok: false, code: GIT_ACCOUNT_REQUIRED, reason: access.reason });
          } else {
            request.json(409, { ok: false, code: GIT_ACCOUNT_REQUIRED, reason: access.reason, mutationOutcome: "not-started" });
          }
          return true;
        }
        return withGithubAuth(access.kind === "personal" ? access.auth : null, () => githubRoutes({
        projects: scoped.projects,
        github,
        append: (sessionId, type, data) => host.events.append(
          sessionId,
          type,
          data,
          { ignorable: true, producerPlugin: "review" },
        ),
        sessions: {
          create: (input) => scoped.sessions.create(input),
          snapshot: (sessionId) => scoped.sessions.snapshot(sessionId),
          send: (sessionId, input) => scoped.sessions.send(sessionId, input),
        },
        describe: async (root, base, userId) => {
          let baseRef = base;
          if (!baseRef) {
            const repository = await github.repo(root);
            baseRef = (repository.ok && repository.data.defaultBranch) || "main";
          }
          const diff = await git.diffRange(root, baseRef, "HEAD");
          return describeChangeRequest(host, projectId, root, diff, "pull request", userId);
        },
      })({ ...request, body: async () => input, json: (status, payload) => {
        // A live status has just seen who is signed in; passive reads reuse it.
        const seen = request.path === "/api/github/status" && status === 200 ? payload as GithubStatus : null;
        if (seen?.authenticated && seen.user) users.remember(userKey(request, access), seen.user);
        request.json(status, payload);
      } }));
      };
    },
    async onDisable() {
      routes = null;
      users.clear();
      unregisterCredentials?.();
      unregisterCredentials = undefined;
      prWatch?.dispose();
      prWatch = null;
      for (const registration of toolRegistrations.toReversed()) await registration.dispose();
      toolRegistrations = [];
    },
  };
}
