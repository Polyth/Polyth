import type { GitService } from "@polyth/git";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, RouteHandler, SecureSafeService, SpaceStorage } from "@polyth/contracts";
import { roleAtLeast } from "@polyth/contracts";
import { atomicWriteSync, localOnlyRemoteAccess, serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { GIT_BINARY_ENV, resolveExecutable } from "@polyth/kernel/executable";
import { describeChangeRequest, hostingRoutes } from "@polyth/code-hosting/routes";
import { createGitlabAccountStore, type GitlabAccountStore } from "./auth.ts";
import { createGitlabApiClient, createGlabApiClient, type GitlabApiClient } from "./client.ts";
import { detectGitRemotes, normalizeGitlabInstance, requireCurrentRemote, type GitExec, type GitlabRemoteBinding } from "./remote.ts";
import { createGitlabService } from "./resources.ts";
import {
  SOURCE_CONTROL_CREDENTIAL_REGISTRY,
  type SourceControlCredentialProvider,
  type SourceControlCredentialRegistry,
} from "@polyth/contracts/source-control";
import { resolveConnectionOwner } from "@polyth/plugins/people";
import { contextMayUseInstallation, GIT_ACCOUNT_REQUIRED, isPersonId } from "@polyth/git/acting";
import { createPersonHostingAccounts, type PersonHostingAccounts } from "@polyth/git/person-accounts";

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const gitExec: GitExec = (bin, args, opts) => new Promise((resolve, reject) => {
  execFile(resolveExecutable(bin, bin === "git" ? { overrideEnv: GIT_BINARY_ENV } : {}), args, { cwd: opts.cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error
    ? reject(Object.assign(new Error("Local Git inspection failed."), { code: "git-unavailable" })) : resolve({ stdout, stderr }));
});
function load<T>(path: string, validate: (value: unknown) => value is T, fallback: T): T {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validate(value)) return fail("invalid-state", "GitLab state is malformed; restore it before continuing.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw Object.assign(new Error("GitLab state is malformed; restore it before continuing."), { code: "invalid-state" });
  }
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const bindings = (storage: SpaceStorage) => {
  const path = join(storage.packageDir("gitlab"), "bindings.json");
  const fields = ["projectId", "remoteName", "observedUrl", "instanceId", "accountId"];
  const rows = load<GitlabRemoteBinding[]>(path, (x): x is GitlabRemoteBinding[] => Array.isArray(x)
    && new Set(x.map(r => object(r) ? r.projectId : undefined)).size === x.length
    && x.every(r => object(r) && Object.keys(r).length === fields.length && fields.every(k => typeof r[k] === "string" && (r[k] as string).length > 0 && (r[k] as string).length <= 4096)), []);
  return { rows, save() { mkdirSync(storage.packageDir("gitlab"), { recursive: true, mode: 0o700 }); atomicWriteSync(path, JSON.stringify(rows), 0o600); } };
};
const sameEndpoint = (url: string, instanceId: string, hostname: string) => {
  const instance = normalizeGitlabInstance(instanceId);
  return /^https?:/.test(url) ? new URL(url).origin === instance.origin : hostname === instance.hostname;
};

interface Receipt { digest: string; status: number; payload: JsonObject }
/** Persist an uncertain receipt before external delivery; reconnects cannot repeat writes. */
export function createMutationReceipts() {
  const inFlight = new Map<string, Promise<Receipt>>();
  return async (storage: SpaceStorage, requestId: string, operation: unknown, run: () => Promise<Receipt>): Promise<Receipt> => {
    if (!/^[\w-]{16,100}$/.test(requestId)) return fail("invalid-input", "A mutation requestId is required.");
    const path = join(storage.packageDir("gitlab"), "writes", `${requestId}.json`);
    const digest = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
    const old = load<Receipt | null>(path, (x): x is Receipt | null => object(x) && typeof x.digest === "string" && typeof x.status === "number" && object(x.payload), null);
    if (old) {
      if (old.digest !== digest) return fail("request-conflict", "This requestId was already used for another operation.");
      return inFlight.get(path) ?? old;
    }
    const unknown: Receipt = { digest, status: 409, payload: { ok: false, code: "mutation-unknown", outcome: "unknown", reason: "The operation may have completed. Inspect GitLab before trying another action." } };
    const directory = join(storage.packageDir("gitlab"), "writes");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // ponytail: bounded receipt history; archive only after external reconciliation.
    if (readdirSync(directory).length >= 10_000) return fail("receipt-limit", "GitLab write history is full; reconcile and archive receipts before continuing.");
    atomicWriteSync(path, JSON.stringify(unknown), 0o600);
    const pending = (async () => {
      try {
        const result = await run();
        const receipt = { ...result, digest };
        atomicWriteSync(path, JSON.stringify(receipt), 0o600);
        return receipt;
      } catch { return unknown; }
      finally { inFlight.delete(path); }
    })();
    inFlight.set(path, pending);
    return pending;
  };
}

/**
 * GitLab accounts for Git transport (Spaces §14.4): the person's own PAT
 * accounts turned on in this Space (`personal`), the Space's accounts
 * (`service`; PATs authenticate HTTPS Git with their token) and glab logins,
 * which defer to the host's own Git credential helpers and are therefore an
 * installation account only the instance owner on local-trusted may use.
 * Binding a cloned project also selects the account GitLab views use.
 */
export function createGitlabCredentialProvider(host: Pick<ServerPackageHost, "deployment" | "spaceStorage" | "forSpace">, deps: {
  accounts: GitlabAccountStore;
  exec?: GitExec;
  people?: PersonHostingAccounts;
}): SourceControlCredentialProvider {
  const exec = deps.exec ?? gitExec;
  const usable = (authKind: string, space: Parameters<SourceControlCredentialProvider["accounts"]>[0]) =>
    authKind === "pat" || contextMayUseInstallation(space);
  return {
    id: "gitlab",
    async accounts(space) {
      const personal = (deps.people?.enabledIn(space.userId, space.spaceId) ?? []).map((account) => ({
        provider: "gitlab",
        accountId: account.id,
        providerLabel: "GitLab",
        login: account.login,
        origin: account.origin,
        label: account.label,
        transport: "token" as const,
        owner: "personal" as const,
      }));
      return [...personal, ...deps.accounts.list(host.spaceStorage(space)).filter((account) => usable(account.authKind, space)).map((account) => ({
        provider: "gitlab",
        accountId: account.id,
        providerLabel: "GitLab",
        login: account.username,
        origin: normalizeGitlabInstance(account.instanceId).origin,
        label: account.label,
        transport: account.authKind === "pat" ? "token" as const : "system" as const,
        owner: account.authKind === "pat" ? "service" as const : "installation" as const,
      }))];
    },
    async credential(space, accountId) {
      if (accountId.startsWith("p-")) {
        const row = deps.people?.enabledIn(space.userId, space.spaceId).find((candidate) => candidate.id === accountId)
          ?? fail("not-found", "GitLab account not found.");
        return { username: row.login, password: deps.people!.token(space.userId, space.spaceId, accountId) };
      }
      const storage = host.spaceStorage(space);
      const account = deps.accounts.get(storage, accountId) ?? fail("not-found", "GitLab account not found.");
      if (!usable(account.authKind, space)) return fail("permission-denied", "System CLI credentials are available only to the instance owner.");
      const auth = deps.accounts.resolve(space, storage, accountId);
      return auth.kind === "pat" ? { username: auth.username, password: auth.token } : null;
    },
    async bindProject(space, input) {
      if (!roleAtLeast(space.role, "admin")) return;
      const storage = host.spaceStorage(space);
      const account = deps.accounts.get(storage, input.accountId) ?? fail("not-found", "GitLab account not found.");
      const project = await host.forSpace(space).projects.get(input.projectId);
      if (!project) return fail("not-found", "Project not found.");
      const remotes = await detectGitRemotes(project.path, exec);
      // Bind only the endpoint the user cloned, never another matching remote.
      const remote = remotes.find(r => r.url === input.repository.trim() && sameEndpoint(r.url, account.instanceId, r.hostname));
      if (!remote) return;
      const state = bindings(storage);
      const binding = { projectId: input.projectId, remoteName: remote.remoteName, observedUrl: remote.url, accountId: account.id, instanceId: account.instanceId };
      state.rows.splice(0, state.rows.length, ...state.rows.filter(r => r.projectId !== input.projectId), binding);
      state.save();
    },
  };
}

export function gitlabRoutes(host: ServerPackageHost, deps: {
  accounts: GitlabAccountStore;
  exec?: GitExec;
  /** Test seam: the API client of one account id (Space or personal). */
  client?: (accountId: string) => GitlabApiClient;
  /** Person-owned PAT accounts (Spaces §14.4). */
  people?: PersonHostingAccounts;
  /** Test seam for verifying a personal token: returns its username. */
  verifyToken?: (instanceOrigin: string, token: string) => Promise<{ username: string }>;
} ): RouteHandler {
  const exec = deps.exec ?? gitExec;
  const write = createMutationReceipts();
  const isMember = (userId: string, spaceId: string) => host.people?.isMember(userId, spaceId) ?? true;
  return async rc => {
    if (rc.path !== "/api/gitlab" && !rc.path.startsWith("/api/gitlab/")) return false;
    try {
      const scoped = host.forSpace(rc.space);
      const storage = host.spaceStorage(rc.space);
      const input = rc.method === "GET" ? {} : await rc.body();
      const installation = contextMayUseInstallation(rc.space, rc.principal);
      // ---- the signed-in person's own GitLab accounts --------------------------
      const mine = rc.path.match(/^\/api\/gitlab\/me\/accounts(?:\/(p-[0-9a-f-]{36})(\/enabled)?)?$/);
      if (mine) {
        if (!deps.people) return fail("unavailable", "Personal accounts are unavailable on this server.");
        if (!isPersonId(rc.space.userId)) return fail("permission-denied", "GitLab accounts belong to a signed-in person.");
        const [, accountId, enabled] = mine;
        const userId = rc.space.userId;
        if (!accountId && rc.method === "POST") {
          const instance = normalizeGitlabInstance(String(input.instance ?? ""));
          const token = String(input.token ?? "").trim();
          if (!token) return fail("invalid-input", "Enter a GitLab token.");
          const user = deps.verifyToken
            ? await deps.verifyToken(instance.origin, token)
            : await createGitlabApiClient({ instance, deployment: host.deployment, token }).request<{ username: string }>("user");
          if (!user || typeof user.username !== "string") return fail("invalid-response", "GitLab returned an invalid user.");
          deps.people.connect(userId, { origin: instance.origin, login: user.username, label: String(input.label || user.username) }, token, input.enabled === false ? undefined : rc.space.spaceId);
        } else if (accountId && enabled && rc.method === "PUT") {
          if (typeof input.enabled !== "boolean") return fail("invalid-input", "enabled must be true or false");
          deps.people.setEnabled(userId, rc.space.spaceId, accountId, input.enabled);
        } else if (accountId && !enabled && rc.method === "DELETE") {
          if (!deps.people.remove(userId, accountId)) return fail("not-found", "GitLab account not found.");
        } else if (accountId || rc.method !== "GET") return false;
        rc.json(200, { ok: true, data: deps.people.view(userId, rc.space.spaceId) });
        return true;
      }
      if (rc.method !== "GET") {
        const authority = rc.path.startsWith("/api/gitlab/accounts") || rc.path === "/api/gitlab/binding" ? "admin" : "member";
        if (!roleAtLeast(rc.space.role, authority)) return fail("permission-denied", "Your Space role cannot perform this GitLab operation.");
      }
      const accountClient = (accountId: string): GitlabApiClient => {
        const account = deps.accounts.get(storage, accountId) ?? fail("not-found", "GitLab account not found.");
        if (deps.client) return deps.client(accountId);
        const instance = normalizeGitlabInstance(account.instanceId);
        const auth = deps.accounts.resolve(rc.space, storage, accountId);
        if (auth.kind === "glab") {
          // A glab login is the host's own account: the instance owner's.
          if (!installation) return fail("permission-denied", "System CLI credentials are available only to the instance owner.");
          return createGlabApiClient({ instance, deployment: host.deployment, expectedUsername: auth.username });
        }
        return createGitlabApiClient({ instance, deployment: host.deployment, token: auth.token });
      };
      if (rc.path === "/api/gitlab/accounts") {
        if (rc.method === "GET") { rc.json(200, { ok: true, data: deps.accounts.list(storage) }); return true; }
        if (rc.method !== "POST") return false;
        const instance = normalizeGitlabInstance(String(input.instance ?? ""));
        const username = String(input.username ?? "").trim();
        const accountInput = { instanceId: instance.origin, username, label: String(input.label || username) };
        const verify = async (client: GitlabApiClient) => {
          const user = await client.request<{ username: string }>("user");
          if (!user || typeof user.username !== "string") return fail("invalid-response", "GitLab returned an invalid user.");
          return user;
        };
        let result;
        if (input.authKind === "glab") {
          if (!installation) return fail("permission-denied", "System CLI credentials are available only to the instance owner.");
          result = await deps.accounts.connectGlab(rc.space, storage, accountInput, () => verify(createGlabApiClient({ instance, deployment: host.deployment, expectedUsername: username })));
        } else if (input.authKind === "pat") {
          result = await deps.accounts.connectPat(rc.space, storage, accountInput, String(input.token ?? ""), token => verify(createGitlabApiClient({ instance, deployment: host.deployment, token })));
        } else return fail("invalid-input", "Choose PAT or an existing glab login.");
        rc.json(200, { ok: true, data: result }); return true;
      }
      const accountPath = rc.path.match(/^\/api\/gitlab\/accounts\/([\w-]+)(\/verify)?$/);
      if (accountPath) {
        const accountId = accountPath[1]!;
        if (!deps.accounts.get(storage, accountId)) return fail("not-found", "GitLab account not found.");
        if (rc.method === "DELETE" && !accountPath[2]) { deps.accounts.remove(rc.space, storage, accountId); rc.json(200, { ok: true }); return true; }
        if (rc.method === "POST" && accountPath[2]) {
          const user = await accountClient(accountId).request<{ username: string }>("user");
          rc.json(200, { ok: true, data: { username: user.username } }); return true;
        }
        return false;
      }
      const projectId = String(input.projectId ?? rc.url.searchParams.get("projectId") ?? "");
      const project = await scoped.projects.get(projectId);
      if (!project) return fail("not-found", "Project not found.");
      // Validate before any external write or unscoped event append.
      if (input.sessionId) {
        const session = await scoped.sessions.snapshot(String(input.sessionId));
        if (session.projectId !== projectId) return fail("not-found", "Session not found.");
      }
      const remotes = await detectGitRemotes(project.path, exec);
      const state = bindings(storage);
      let binding = state.rows.find(b => b.projectId === projectId) ?? null;
      if (rc.path === "/api/gitlab/context" && rc.method === "GET") {
        let reason: string | undefined;
        if (binding) try { requireCurrentRemote(binding, remotes); if (!deps.accounts.get(storage, binding.accountId)) reason = "The selected account was removed."; } catch { reason = "Git remote changed; select the account again."; }
        rc.json(200, { ok: true, data: { remotes, accounts: deps.accounts.list(storage), binding, ...(reason ? { reason } : {}) } }); return true;
      }
      if (rc.path === "/api/gitlab/binding" && rc.method === "POST") {
        const account = deps.accounts.get(storage, String(input.accountId ?? "")) ?? fail("not-found", "GitLab account not found.");
        const remote = remotes.find(r => r.remoteName === input.remoteName && r.url === input.observedUrl) ?? fail("stale-state", "Remote changed; refresh the repository settings.");
        if (!sameEndpoint(remote.url, account.instanceId, remote.hostname)) return fail("account-not-applicable", "This account belongs to another GitLab instance.");
        binding = { projectId, remoteName: remote.remoteName, observedUrl: remote.url, accountId: account.id, instanceId: account.instanceId };
        state.rows.splice(0, state.rows.length, ...state.rows.filter(r => r.projectId !== projectId), binding);
        state.save(); rc.json(200, { ok: true, data: binding }); return true;
      }
      // Whose account the GitLab views use (Spaces §14.4): the person's own
      // account for this instance turned on in this Space → the project's
      // Space (service) account → refused. A personal account also works on a
      // project nobody bound yet, on its first matching remote.
      const personalFor = (instanceId: string) => (deps.people?.enabledIn(rc.space.userId, rc.space.spaceId) ?? [])
        .filter((row) => row.origin === normalizeGitlabInstance(instanceId).origin);
      if (!binding && deps.people) {
        const mineHere = deps.people.enabledIn(rc.space.userId, rc.space.spaceId);
        const remote = remotes.find((candidate) => mineHere.some((row) => sameEndpoint(candidate.url, row.origin, candidate.hostname)));
        const row = remote && mineHere.find((candidate) => sameEndpoint(remote.url, candidate.origin, remote.hostname));
        if (remote && row) binding = { projectId, remoteName: remote.remoteName, observedUrl: remote.url, instanceId: row.origin, accountId: row.id };
      }
      if (!binding) {
        const reason = "Select a GitLab account and remote in repository settings, or connect your own GitLab account in Profile → Accounts.";
        rc.json(200, rc.path.endsWith("/status") ? { installed: true, authenticated: false, user: null, repo: null, reason } : { ok: false, code: "not-configured", reason }); return true;
      }
      const remote = requireCurrentRemote(binding, remotes);
      if (!sameEndpoint(remote.url, binding.instanceId, remote.hostname)) return fail("stale-state", "Repository identity changed; select the account again.");
      const personal = personalFor(binding.instanceId);
      const service = binding.accountId.startsWith("p-") ? undefined : deps.accounts.get(storage, binding.accountId);
      if (service && service.instanceId !== binding.instanceId) return fail("stale-state", "Repository identity changed; select the account again.");
      const decision = resolveConnectionOwner({
        actorUserId: rc.space.userId,
        spaceId: rc.space.spaceId,
        isMember,
        personalEnabled: personal.map((row) => row.id),
        hasService: !!service && (service.authKind === "pat" || installation),
        policy: { agentsMayUseService: false },
        origin: "person-ui",
      });
      if (decision.kind === "refused") {
        const reason = decision.reason === "not-a-member"
          ? "You are no longer a member of this Space."
          : "Connect your GitLab account in Profile → Accounts and turn it on for this Space.";
        if (rc.method !== "GET") { rc.json(409, { ok: false, code: GIT_ACCOUNT_REQUIRED, reason, mutationOutcome: "not-started" }); return true; }
        rc.json(200, rc.path.endsWith("/status") ? { installed: true, authenticated: false, user: null, repo: null, reason } : { ok: false, code: GIT_ACCOUNT_REQUIRED, reason }); return true;
      }
      const acting = decision.kind === "personal"
        ? { client: deps.client ? deps.client(personal[0]!.id) : createGitlabApiClient({ instance: normalizeGitlabInstance(binding.instanceId), deployment: host.deployment, token: deps.people!.token(rc.space.userId, rc.space.spaceId, personal[0]!.id) }), username: personal[0]!.login }
        : { client: accountClient(service!.id), username: service!.username };
      const provider = createGitlabService({ client: acting.client, projectPath: remote.fullPath, instance: binding.instanceId, user: { login: acting.username, avatarUrl: "" }, currentBranch: cwd => exec("git", ["branch", "--show-current"], { cwd }).then(r => r.stdout.trim()) });
      const handler = hostingRoutes({
        projects: scoped.projects, provider, prefix: "/api/gitlab", mergeStrategies: ["merge", "squash"],
        presentation: { changeRequest: "merge request", abbreviation: "MR", numberPrefix: "!", conflictEvent: "gitlab/conflict-resolution-started" },
        describe: async (root, base, userId) => {
          const repository = await provider.repo(root);
          if (!repository.ok) throw new Error(repository.reason);
          const target = base || repository.data.defaultBranch;
          const git = host.services.require(serverServiceKey<GitService>("git"));
          return describeChangeRequest(host, projectId, root, await git.diffRange(root, target, "HEAD"), "merge request", userId);
        },
        sessions: { create: input => scoped.sessions.create(input), snapshot: id => scoped.sessions.snapshot(id), send: (id, input) => scoped.sessions.send(id, input) },
        append: (id, type, data) => host.events.append(id, type, data, { ignorable: true, producerPlugin: "gitlab" }),
      });
      if (rc.method === "GET") return handler(rc);
      const result = await write(storage, String(input.requestId ?? ""), { path: rc.path, input, binding }, async () => {
        let response: Receipt | undefined;
        const handled = await handler({ ...rc, body: async () => input, json: (status, payload) => { response = { digest: "", status, payload: payload as JsonObject }; } });
        if (!handled || !response) return fail("unsupported-operation", "Unsupported GitLab operation.");
        return response;
      });
      rc.json(result.status, result.payload); return true;
    } catch (error) {
      const e = error as { code?: string; message?: string };
      rc.json(e.code === "not-found" ? 404 : e.code === "permission-denied" ? 403 : 400, { ok: false, code: e.code ?? "gitlab-unavailable", reason: e.message ?? "GitLab is unavailable." }); return true;
    }
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | undefined;
  let unregisterCredentials: (() => void) | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["gitlab"]),
    routes: async rc => routes ? routes(rc) : false,
    onEnable() {
      const vault = host.services.require(serverServiceKey<SecureSafeService>("secure-safe"));
      const accounts = createGitlabAccountStore(vault);
      const people = host.people ? createPersonHostingAccounts(host.people, "gitlab") : undefined;
      routes = gitlabRoutes(host, { accounts, ...(people ? { people } : {}) });
      unregisterCredentials = host.services
        .get(serverServiceKey<SourceControlCredentialRegistry>(SOURCE_CONTROL_CREDENTIAL_REGISTRY))
        ?.register(createGitlabCredentialProvider(host, { accounts, ...(people ? { people } : {}) }));
    },
    onDisable() { routes = undefined; unregisterCredentials?.(); unregisterCredentials = undefined; },
  };
}
