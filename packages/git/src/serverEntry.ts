import { createCommitSettingsStore } from "./commitSettingsStore.ts";
import { applyAnonymous, applySigningKey, applySshKey, createSourceControlProfilesStore, getAnonymous, getSigningKey, getSshKey, listSshKeys, profileSshKey, testSshKey } from "./sourceControlProfilesStore.ts";
import { readManagedMarker, isManagedBranch } from "./managedWorktrees.ts";
import { rmSync } from "node:fs";
import { posix, resolve } from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentRuntime,
  CreateIsolatedSessionInput,
  JsonObject,
  ModelRef,
  ProjectCloneInput,
  RemoteAccessPolicy,
  RemoteHost,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import type { ProjectService, RouteHandler, SessionAccessLevel, SessionEvent, SessionPersistence, SessionService } from "@polyth/contracts";
import { REMOTE_CAPABILITY, roleAtLeast, sessionAccessAtLeast } from "@polyth/contracts";
import {
  SOURCE_CONTROL_CREDENTIAL_REGISTRY,
  parseSourceControlRemoteUrl,
  resolveSourceControlContext,
  type PersonGitProfileDto,
  type SourceControlCommitIdentity,
  type SourceControlCredentialRegistry,
  type SourceControlProfileState,
} from "@polyth/contracts/source-control";
import { resolveWorkspaceContext, workspaceExecutionPath, workspaceRepository } from "@polyth/contracts/workspace";
import {
  SERVER_SESSION_ISOLATION,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  buildLocalConflictResolutionPrompt,
  createGitService,
  cloneRepository,
  pathsUnder,
  type GitService,
} from "./index.ts";
import { registerGitHandoffSources } from "./handoffSources.ts";
import {
  createSourceControlAccountService,
  createSourceControlCredentialRegistry,
  gitRemoteUrl,
  rememberCredentialUsername,
  withGitCommitIdentity,
  withGitSshIdentity,
  withGitTransportAuth,
  type SourceControlAccountService,
} from "./sourceControlAccounts.ts";
import {
  contextMayUseInstallation,
  createPersonGitProfiles,
  gitAccountRequired,
  isPersonId,
  requestGitActor,
  resolveGitCommitIdentity,
  type GitActor,
  type PersonGitProfiles,
} from "./actingPerson.ts";
import type { PackageServicePolicy } from "@polyth/plugins/people";
import { createWorktreeTopologyWatch } from "./worktreeTopology.ts";
import {
  createIsolationService,
  type IsolationExistingSessions,
  type IsolationRequesterSessions,
  type IsolationService,
  type PreserveSessionMedia,
} from "./sessionIntegration.ts";
import { clientOperationIdInput, sessionIdForCreateOperation } from "@polyth/session/create-operation";
import { createTemporaryWorktreeBranchService, type TemporaryWorktreeBranchService } from "./temporaryWorktreeBranches.ts";

const COMMIT_PROMPT_VERSION = 2;
const COMMIT_OUTPUT_TOKENS = 120;
const COMMIT_CACHE_TTL_MS = 60_000;
// Commit-message generation runs on the session transport (create throwaway
// session → reconcile → turn), and a free/rate-limited or subscription-auth
// model (e.g. Haiku over OAuth) legitimately needs far longer than the old 30s
// cap, which surfaced as a spurious "timed out". Match the oneShot default.
const COMMIT_TIMEOUT_MS = 90_000;

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Keep both ends of a large diff: file headers and the final change are often
 * the most useful identity signals. The caller supplies a model-aware global
 * budget, so this is never a per-file arbitrary limit. */
export function buildCommitMessagePrompt(diff: string, inputBudget: number): string {
  const prefix = [
    "Write a git commit message. Output only the message.",
    "Use one imperative subject of at most 72 characters; add a short body only when necessary.",
    "Do not use markdown fences.",
    "<diff>",
  ].join("\n");
  const suffix = "\n</diff>";
  const available = Math.max(0, inputBudget - prefix.length - suffix.length);
  const marker = "\n… diff truncated …\n";
  const compact = diff.length <= available ? diff : available < 256
    ? diff.slice(0, available)
    : `${diff.slice(0, Math.floor((available - marker.length) * 0.7))}${marker}${diff.slice(-Math.floor((available - marker.length) * 0.3))}`;
  return `${prefix}\n${compact}${suffix}`;
}

export interface CommitMessageGeneratorDeps {
  diff(root: string, opts?: { staged?: boolean }): Promise<{ diff: string }>;
  runtime(root: string, model: (ModelRef & { harnessId?: string }) | undefined): Promise<AgentRuntime>;
  model?: (userId?: string) => (ModelRef & { harnessId?: string }) | undefined;
  inputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
  complete(runtime: AgentRuntime, options: {
    cwd: string; prompt: string; model?: ModelRef; maxOutputTokens: number; timeoutMs?: number;
  }): Promise<{ text: string }>;
  now?: () => number;
}

/** Content-addressed, short-lived commit utility cache with single-flight
 * coalescing. It intentionally stores only generated text, never secrets. */
export function createCommitMessageGenerator(deps: CommitMessageGeneratorDeps): (root: string, userId?: string, selectedModel?: ModelRef & { harnessId?: string }) => Promise<string> {
  const cache = new Map<string, { text: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();
  const now = deps.now ?? Date.now;
  return async (root, userId, selectedModel) => {
    const staged = await deps.diff(root, { staged: true });
    const stagedSelected = !!staged.diff.trim();
    const diff = stagedSelected ? staged.diff : (await deps.diff(root)).diff;
    if (!diff.trim()) throw Object.assign(new Error("nothing to describe"), { code: "invalid-input" });
    const model = selectedModel ?? deps.model?.(userId);
    const modelKey = model ? `${model.harnessId ?? "auto"}/${model.providerID}/${model.modelID}/${model.variant ?? "default"}` : "default";
    const key = `${root}:${userId ?? ""}:${digest(diff)}:${stagedSelected ? "staged" : "unstaged"}:${modelKey}:v${COMMIT_PROMPT_VERSION}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.text;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async () => {
      const runtime = await deps.runtime(root, model);
      const budget = await deps.inputBudget(runtime, model, COMMIT_OUTPUT_TOKENS);
      const result = await deps.complete(runtime, {
        cwd: root,
        model,
        maxOutputTokens: COMMIT_OUTPUT_TOKENS,
        timeoutMs: COMMIT_TIMEOUT_MS,
        prompt: buildCommitMessagePrompt(diff, budget),
      });
      const text = result.text.replace(/^```[a-z]*\n?|```$/g, "").trim();
      if (!text) throw new Error("small model returned an empty commit message");
      cache.set(key, { text, expiresAt: now() + COMMIT_CACHE_TTL_MS });
      return text;
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
  };
}

export function assertGitRelativePath(value: string, allowEmpty = false): string {
  if (value.length === 0 && allowEmpty) return value;
  const portable = value.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (
    value.length === 0
    || value.includes("\0")
    || posix.isAbsolute(portable)
    || /^[a-z]:\//i.test(portable)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw Object.assign(new Error("Git path must stay within the project workspace."), {
      code: "invalid-path",
    });
  }
  return value;
}

/** Service key of the Git package's source-control account service. */
export const GIT_SOURCE_CONTROL_ACCOUNTS = "git.source-control-accounts";

/** Routes whose Git commands may write commits (or stash/merge commits). */
const COMMIT_ROUTES = new Set([
  "/api/git/commit", "/api/git/stash", "/api/git/merge",
  "/api/git/pull", "/api/git/rebase", "/api/git/sync",
]);

async function ownedBranchForWorktree(
  sessions: SessionService,
  projectId: string,
  worktreePath: string,
): Promise<string | null> {
  let listed: SessionProjection[];
  try {
    listed = await sessions.list(projectId);
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const session of listed) {
    if (!session.worktreePath || !session.branch) continue;
    if (resolve(session.worktreePath) !== resolve(worktreePath)) continue;
    names.add(session.branch);
  }
  return names.size === 1 ? [...names][0]! : null;
}

export function gitRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  git: GitService;
  commitMessage(root: string, userId?: string): Promise<string>;
  /** Session-log append seam for the conflict-resolution handoff. Optional so
   *  minimal deployments and existing test fakes stay valid; when absent the
   *  handoff still sends the prompt, it just skips the marker event. */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  remote?: { host(connectionId: string): RemoteHost };
  /** Announce that one project's worktree topology changed. Optional so
   *  minimal deployments and existing test fakes stay valid. */
  worktreesChanged?: (projectId: string) => void;
  /** Project source-control accounts (clone/fetch/pull/push credentials).
   *  Optional so minimal deployments and existing test fakes stay valid. */
  accounts?: SourceControlAccountService;
  /** Space-scoped projects for request routes (clone registration, account
   *  routes); defaults to `projects`. */
  scopedProjects?: (space: import("@polyth/contracts").SpaceContext) => Pick<ProjectService, "get" | "add" | "addRemote">;
  /** The requester's scoped sessions, so a chat a person starts here is
   *  theirs; defaults to `sessions`. */
  scopedSessions?: (space: import("@polyth/contracts").SpaceContext) => Pick<SessionService, "create">;
  /** Space source-control identities (profiles), for cloning with an
   *  identity's SSH key. Optional so existing test fakes stay valid. */
  profiles?: { read(space: import("@polyth/contracts").SpaceContext): { state: SourceControlProfileState } };
  /** Home whose ~/.ssh holds identity keys; tests only. */
  sshHome?: string;
  /** Each person's own commit identity (Profile → Git). Optional so existing
   *  test fakes stay valid; without it nobody has a profile. */
  personProfiles?: PersonGitProfiles;
  /** The Space policy for agent/system use of the service account. */
  servicePolicy?: {
    read(spaceId: string): PackageServicePolicy;
    write(spaceId: string, policy: PackageServicePolicy): void;
  };
}): RouteHandler {
  const { git } = deps;
  const NO_PROFILES: Pick<PersonGitProfiles, "read"> = { read: () => null };
  /** The commit identity of a UI request: the signed-in person's profile, the
   *  owner's checkout configuration (null), or a refusal before any work. */
  const commitIdentityOf = (request: Parameters<RouteHandler>[0]): SourceControlCommitIdentity | null =>
    resolveGitCommitIdentity({ actor: requestGitActor(request), profiles: deps.personProfiles ?? NO_PROFILES });
  /** A remote name, or the URL Git would use for it. */
  const remoteUrlOf = async (root: string, remote: string | undefined): Promise<string | null> => {
    const name = remote ?? "origin";
    return await gitRemoteUrl(root, name) ?? (/^[\w.-]{1,120}$/.test(name) ? null : name);
  };
  const topology = createWorktreeTopologyWatch((projectId) => deps.worktreesChanged?.(projectId));
  /** Announce a topology change this server just made, and record it so the
   *  next observation does not announce the same change a second time. */
  const announceTopology = async (projectId: string, root: string): Promise<void> => {
    await topology.settle(projectId, root);
    deps.worktreesChanged?.(projectId);
  };
  const projectOf = async (projectId: string | null | undefined) => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project;
  };
  const projectRootOf = async (projectId: string | null | undefined): Promise<string> => (await projectOf(projectId)).path;
  /** The checkout's own Git identity as Polyth manages it. */
  const checkoutIdentity = async (root: string) => ({
    ...(await git.identity(root)),
    sshKey: await getSshKey(root),
    signingKey: await getSigningKey(root),
    anonymous: await getAnonymous(root),
  });
  /** Resolve a client-named checkout to a root Git itself vouches for. The
   *  supplied path is only ever a selector: it must match a row of this
   *  project's live `git worktree list`, so a traversal, a symlink hop or
   *  another project's checkout can never become an operating root. */
  const worktreeRootOf = async (projectRoot: string, worktreePath: string): Promise<string> => {
    if (!(await git.isRepo(projectRoot))) {
      throw Object.assign(new Error("this project is not a git repository"), { code: "conflict" });
    }
    const wanted = resolve(worktreePath);
    const match = (await git.worktrees.list(projectRoot))
      .find((worktree) => resolve(worktree.path) === wanted);
    if (!match) {
      throw Object.assign(new Error("unknown worktree for this project"), { code: "not-found" });
    }
    return match.path;
  };
  const rootOf = async (
    projectId: string | null | undefined,
    sessionId?: string | null,
    worktreePath?: string | null,
    repositoryId?: string | null,
  ): Promise<string> => {
    const project = await projectOf(projectId);
    const projectRoot = project.path;
    let session: SessionProjection | undefined;
    if (sessionId) {
      session = await deps.sessions.snapshot(sessionId);
      if (session.projectId !== projectId) {
        throw Object.assign(new Error("session does not belong to this project"), { code: "not-found" });
      }
      if (session.worktreeState === "missing" && (repositoryId === undefined || repositoryId === null)) {
        throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
      }
    }
    const context = resolveWorkspaceContext(project, session);
    if (repositoryId !== undefined && repositoryId !== null) {
      if (!repositoryId) throw Object.assign(new Error("repositoryId required"), { code: "invalid-input" });
      const repository = workspaceRepository(context, repositoryId);
      if (repository.state === "missing") {
        throw Object.assign(new Error("repository checkout is missing"), { code: "not-found" });
      }
      if (worktreePath && resolve(worktreePath) !== resolve(repository.path)) {
        throw Object.assign(new Error("worktreePath does not match the selected repository"), { code: "invalid-path" });
      }
      return repository.path;
    }
    // The scalar runtime anchor is canonical workspace state. A session may
    // intentionally exclude the project's primary repository, so falling
    // back to projectRoot here would silently run Git against the wrong repo.
    if (session) return workspaceExecutionPath(project, session);
    if (worktreePath) return worktreeRootOf(projectRoot, worktreePath);
    return projectRoot;
  };
  const conflictRootOf = async (
    projectId: string,
    target: string,
    givenSessionId: string,
    repositoryId?: string,
  ): Promise<{ root: string } | { status: 400 | 404 | 409; reason: string }> => {
    const project = await projectOf(projectId);
    const projectRoot = project.path;
    if (target !== "new-session" && target !== "current-session") {
      return { status: 400, reason: "target must be new-session or current-session" };
    }
    if (target === "new-session") {
      if (repositoryId !== undefined) {
        try {
          const context = resolveWorkspaceContext(project);
          const repository = workspaceRepository(context, repositoryId);
          const primary = project.primaryRepositoryId
            ?? context.repositories.find((candidate) => candidate.path === project.path)?.repositoryId
            ?? (context.repositories.length === 1 ? context.repositories[0]!.repositoryId : undefined);
          if (repository.repositoryId !== primary) return { status: 409, reason: "repository-scoped conflict-agent repair is unsupported" };
          if (repository.state === "missing") return { status: 404, reason: "repository checkout is missing" };
          return { root: repository.path };
        } catch (error) {
          const code = (error as { code?: string }).code;
          return { status: code === "not-found" ? 404 : 400, reason: (error as Error).message };
        }
      }
      return { root: projectRoot };
    }
    if (!givenSessionId) return { status: 400, reason: "sessionId is required for current-session" };
    let session: SessionProjection;
    try {
      session = await deps.sessions.snapshot(givenSessionId);
    } catch {
      return { status: 404, reason: "target session not found" };
    }
    if (session.projectId !== projectId) return { status: 400, reason: "target session belongs to another project" };
    if (session.worktreeState === "missing" && repositoryId === undefined) return { status: 409, reason: "the target session's worktree is missing" };
    if (repositoryId !== undefined) {
      try {
        const context = resolveWorkspaceContext(project, session);
        const repository = workspaceRepository(context, repositoryId);
        const primary = project.primaryRepositoryId
          ?? context.repositories.find((candidate) => candidate.path === project.path)?.repositoryId
          ?? (context.repositories.length === 1 ? context.repositories[0]!.repositoryId : undefined);
        if (repository.repositoryId !== primary) return { status: 409, reason: "repository-scoped conflict-agent repair is unsupported" };
        if (repository.state === "missing") return { status: 404, reason: "repository checkout is missing" };
        return { root: repository.path };
      } catch (error) {
        const code = (error as { code?: string }).code;
        return { status: code === "not-found" ? 404 : 400, reason: (error as Error).message };
      }
    }
    return { root: session.worktreePath ?? projectRoot };
  };
  const paths = (body: Record<string, unknown>): string[] =>
    Array.isArray(body.paths) ? body.paths.map((path) => assertGitRelativePath(String(path))) : [];
  const optionalRepositoryId = (value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const id = String(value).trim();
    if (!id) throw Object.assign(new Error("repositoryId required"), { code: "invalid-input" });
    return id;
  };

  const parseAccountRef = (value: unknown): { provider: string; accountId: string } | null => {
    if (value === undefined || value === null) return null;
    const row = value as { provider?: unknown; accountId?: unknown };
    if (typeof row.provider !== "string" || !row.provider || typeof row.accountId !== "string" || !row.accountId) {
      throw Object.assign(new Error("account must contain provider and accountId"), { code: "invalid-input" });
    }
    return { provider: row.provider, accountId: row.accountId };
  };
  const parseIdentityRef = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    const profileId = (value as { profileId?: unknown }).profileId;
    if (typeof profileId !== "string" || !profileId) {
      throw Object.assign(new Error("identity must contain profileId"), { code: "invalid-input" });
    }
    return profileId;
  };
  // Choosing which account a project authenticates with is a Space-admin
  // decision, matching provider account bindings.
  const requireAccountAuthority = (space: import("@polyth/contracts").SpaceContext): void => {
    if (!roleAtLeast(space.role, "admin")) {
      throw Object.assign(new Error("Your Space role cannot choose a project's source-control account."), { code: "permission-denied", status: 403 });
    }
  };
  // `git config --local` and core.sshCommand land in the checkout every Space
  // member shares, so only a Space admin may rewrite them.
  const requireIdentityAuthority = (space: import("@polyth/contracts").SpaceContext): void => {
    if (!roleAtLeast(space.role, "admin")) {
      throw Object.assign(new Error("Your Space role cannot change the Git identity of a shared checkout."), {
        code: "permission-denied",
        status: 403,
        mutationOutcome: "not-started",
      });
    }
  };
  const bindProjectAccount = async (
    space: import("@polyth/contracts").SpaceContext,
    projectId: string,
    root: string,
    ref: { provider: string; accountId: string },
    repository: string,
    actor: GitActor,
  ) => {
    const binding = await deps.accounts!.bind(space, { projectId, ...ref, repository });
    // The checkout's config is the installation owner's: only they get the
    // login recorded for their own helpers.
    if (actor.ambient && /^https?:/i.test(repository)) await rememberCredentialUsername(root, binding);
    // The provider records its own project binding (e.g. the account its
    // pull/merge-request views use). The project and the Git binding already
    // exist, so a provider-side failure leaves that provider unbound rather
    // than failing the clone the user can already see.
    await deps.accounts!.bindProvider(space, { projectId, ...ref, repository }).catch(() => undefined);
    return binding;
  };

  /** Only service accounts are bound to projects: a personal account applies
   *  to its owner automatically wherever they turned it on. */
  const accountOwner = async (space: import("@polyth/contracts").SpaceContext, ref: { provider: string; accountId: string }, repository: string) =>
    (await deps.accounts!.account(space, ref, repository)).account.owner ?? "service";

  return async (rc) => {
    const { path, method, url, body, json } = rc;
    const query = (key: string) => url.searchParams.get(key);
    // Resolved on first use: a request this handler declines (the public
    // SPA shell) must never resolve the Space.
    let actorMemo: ReturnType<typeof requestGitActor> | undefined;
    const gitActor = () => (actorMemo ??= requestGitActor(rc));

    if (path === "/api/git/profile") {
      if (!isPersonId(rc.space.userId)) throw Object.assign(new Error("Git profiles belong to a signed-in person."), { code: "forbidden" });
      if (method === "PUT") {
        if (!deps.personProfiles) throw Object.assign(new Error("Git profiles are unavailable on this server."), { code: "unavailable" });
        deps.personProfiles.save(rc.space.userId, await body());
      } else if (method === "DELETE") {
        deps.personProfiles?.clear(rc.space.userId);
      } else if (method !== "GET") return false;
      const profile = deps.personProfiles?.read(rc.space.userId) ?? null;
      json(200, {
        profile: profile ? { name: profile.name, email: profile.email, updatedAt: profile.updatedAt } : null,
        usesInstallationFallback: gitActor().ambient,
      } satisfies PersonGitProfileDto);
      return true;
    }

    if (path === "/api/git/service-policy" && (method === "GET" || method === "PUT")) {
      if (!deps.servicePolicy) throw Object.assign(new Error("Space account policy is unavailable on this server."), { code: "unavailable" });
      if (method === "PUT") {
        requireAccountAuthority(rc.space);
        const input = await body();
        if (typeof input.agentsMayUseService !== "boolean") {
          throw Object.assign(new Error("agentsMayUseService must be true or false"), { code: "invalid-input" });
        }
        deps.servicePolicy.write(rc.space.spaceId, { agentsMayUseService: input.agentsMayUseService });
      }
      json(200, deps.servicePolicy.read(rc.space.spaceId));
      return true;
    }

    if (path === "/api/projects/clone" && method === "POST") {
      const input = await body() as Partial<ProjectCloneInput>;
      if (typeof input.repository !== "string" || typeof input.parentPath !== "string") {
        throw Object.assign(new Error("repository and parentPath are required"), { code: "invalid-input" });
      }
      const remote = input.remote;
      if (remote && (remote.kind !== "ssh" || typeof remote.connectionId !== "string" || !remote.connectionId)) {
        throw Object.assign(new Error("remote must contain an SSH connectionId"), { code: "invalid-input" });
      }
      const host = remote ? deps.remote?.host(remote.connectionId) : undefined;
      if (remote && !host) {
        throw Object.assign(new Error("SSH support unavailable"), { code: "unavailable" });
      }
      const account = parseAccountRef(input.account);
      const identityId = parseIdentityRef(input.identity);
      if (account && identityId) throw Object.assign(new Error("choose either an account or an SSH identity"), { code: "invalid-input" });
      let bindAccount = false;
      if (account) {
        if (remote) throw Object.assign(new Error("an account can be chosen only for clones on this server"), { code: "invalid-input" });
        if (!deps.accounts) throw Object.assign(new Error("source-control accounts are unavailable"), { code: "unavailable" });
        // Cloning with a Space account also binds the project to it, a
        // Space-admin decision; one's own account binds nothing.
        bindAccount = (await accountOwner(rc.space, account, input.repository)) !== "personal";
        if (bindAccount) requireAccountAuthority(rc.space);
      }
      if (identityId) {
        if (remote) throw Object.assign(new Error("an SSH identity can be chosen only for clones on this server"), { code: "invalid-input" });
        if (!deps.profiles) throw Object.assign(new Error("source-control identities are unavailable"), { code: "unavailable" });
        requireAccountAuthority(rc.space);
        // Identity keys live in this host's ~/.ssh: an installation account.
        if (!gitActor().ambient) throw gitAccountRequired("ssh");
      }
      // Resolve (and validate) the account or identity before anything touches the disk.
      const { parentPath } = input;
      let repository = input.repository;
      let sshKey: string | null = null;
      if (identityId) {
        const parsed = parseSourceControlRemoteUrl(repository.trim())
          ?? (() => { throw Object.assign(new Error("repository must be a valid Git remote URL"), { code: "invalid-input" }); })();
        sshKey = profileSshKey(deps.profiles!.read(rc.space).state, identityId, parsed.hostname, deps.sshHome).identityFile;
        // A key signs in over SSH only, so an HTTPS address clones from (and
        // keeps as `origin`) the same repository's SSH address.
        if (parsed.protocol !== "ssh") repository = `git@${parsed.hostname}:${parsed.fullPath}.git`;
      }
      // A clone over SSH to another host keeps that host's own transport.
      const auth = remote || sshKey || !deps.accounts
        ? null
        : await deps.accounts.actorTransportAuth({ actor: gitActor(), space: rc.space, remoteUrl: repository, account });
      const clone = () => cloneRepository(
        { repository, parentPath, ...(typeof input.name === "string" ? { name: input.name } : {}), ...(remote ? { remote } : {}) },
        host,
      );
      const result = sshKey
        ? await withGitSshIdentity(sshKey, clone)
        : await withGitTransportAuth(auth, clone, { hostCredentials: gitActor().ambient || !!remote });
      // The checkout must be registered in the caller's Space: the package
      // host's unscoped project service refuses to create projects.
      const projects = deps.scopedProjects?.(rc.space) ?? deps.projects;
      if (remote) {
        if (!projects.addRemote) throw Object.assign(new Error("remote projects are not supported"), { code: "unsupported" });
        json(200, await projects.addRemote(result.path, remote, result.name));
      } else {
        let project;
        try {
          if (sshKey) await applySshKey(result.path, sshKey, deps.sshHome);
          project = await projects.add(result.path, result.name);
        } catch (error) {
          // Nothing refers to a checkout that never became a project; removing
          // it lets the user retry instead of hitting "destination already exists".
          rmSync(result.path, { recursive: true, force: true });
          throw error;
        }
        if (account && bindAccount) await bindProjectAccount(rc.space, project.id, result.path, account, repository, gitActor());
        json(200, project);
      }
      return true;
    }

    if (path === "/api/git/accounts" && method === "GET") {
      if (!deps.accounts) { json(200, { accounts: [], unavailable: [] }); return true; }
      json(200, await deps.accounts.accounts(rc.space, query("repository") ?? undefined));
      return true;
    }

    if (path === "/api/git/account") {
      if (!deps.accounts) throw Object.assign(new Error("source-control accounts are unavailable"), { code: "unavailable" });
      const input = method === "GET" || method === "DELETE" ? {} : await body();
      const projectId = String(input.projectId ?? query("projectId") ?? "");
      const project = projectId
        ? await (deps.scopedProjects?.(rc.space) ?? deps.projects).get(projectId).catch(() => null)
        : null;
      if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
      if (method === "GET") {
        json(200, { binding: deps.accounts.binding(rc.space, project.id) });
        return true;
      }
      requireAccountAuthority(rc.space);
      if (method === "DELETE") {
        deps.accounts.unbind(rc.space, project.id);
        json(200, { binding: null });
        return true;
      }
      if (method !== "PUT") return false;
      const ref = parseAccountRef(input) ?? (() => { throw Object.assign(new Error("provider and accountId are required"), { code: "invalid-input" }); })();
      if (project.remote) throw Object.assign(new Error("accounts apply to repositories on this server"), { code: "unsupported" });
      const remoteName = typeof input.remote === "string" && input.remote ? input.remote : "origin";
      const url = await gitRemoteUrl(project.path, remoteName);
      if (!url) throw Object.assign(new Error(`remote ${remoteName} is not configured`), { code: "invalid-input" });
      if (await accountOwner(rc.space, ref, url) === "personal") {
        throw Object.assign(new Error("Personal accounts are not bound to projects: yours applies to you wherever you turned it on."), { code: "invalid-input", mutationOutcome: "not-started" });
      }
      json(200, { binding: await bindProjectAccount(rc.space, project.id, project.path, ref, url, gitActor()) });
      return true;
    }

    if (!path.startsWith("/api/git") && !path.startsWith("/api/worktrees")) return false;

    if (path === "/api/git/status" && method === "GET") {
      const root = await rootOf(query("projectId"), query("sessionId"), query("worktreePath"), query("repositoryId"));
      // Status is the Git interaction the UI makes most often, so it is where
      // an externally created or removed worktree is cheapest to notice. The
      // fingerprint is always taken on the project checkout, never on `root`,
      // which may be a session's own worktree.
      if (query("projectId")) {
        void topology.observe(query("projectId")!, await projectRootOf(query("projectId")))
          .catch(() => undefined);
      }
      if (!(await git.isRepo(root))) {
        json(200, { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, isRepo: false });
        return true;
      }
      json(200, { ...(await git.status(root)), isRepo: true });
      return true;
    }
    if (path === "/api/git/diff" && method === "GET") {
      const root = await rootOf(query("projectId"), query("sessionId"), null, query("repositoryId"));
      json(200, await git.diff(root, {
        ...(query("path") ? { path: assertGitRelativePath(query("path")!) } : {}),
        staged: query("staged") === "true",
        ignoreWhitespace: query("ignoreWhitespace") === "true",
      }));
      return true;
    }
    if (path === "/api/git/show" && method === "GET") {
      const root = await rootOf(query("projectId"), query("sessionId"), null, query("repositoryId"));
      const sha = query("sha");
      if (!sha) throw Object.assign(new Error("sha required"), { code: "invalid-input" });
      json(200, await git.show(root, sha, { ignoreWhitespace: query("ignoreWhitespace") === "true" }));
      return true;
    }
    if (path === "/api/git/log" && method === "GET") {
      json(200, await git.log(
        await rootOf(query("projectId"), query("sessionId"), null, query("repositoryId")),
        Number(query("limit") ?? 20),
      ));
      return true;
    }
    if (path === "/api/git/graph" && method === "GET") {
      json(200, await git.graph(await rootOf(query("projectId"), query("sessionId"), null, query("repositoryId")), {
        limit: Number(query("limit") ?? 40),
        skip: Number(query("skip") ?? 0),
      }));
      return true;
    }
    if (path === "/api/git/branches" && method === "GET") {
      json(200, await git.branches(await rootOf(query("projectId"), query("sessionId"), null, query("repositoryId"))));
      return true;
    }
    if (path === "/api/git/stashes" && method === "GET") {
      json(200, await git.stashList(await rootOf(query("projectId"), query("sessionId"), null, query("repositoryId"))));
      return true;
    }
    if (path === "/api/git/identity" && method === "GET") {
      const root = await rootOf(query("projectId"), null, null, query("repositoryId"));
      json(200, await checkoutIdentity(root));
      return true;
    }
    if (path === "/api/worktrees" && method === "GET") {
      if (query("repositoryId") !== null) {
        throw Object.assign(new Error("repository-scoped worktree management is unsupported"), { code: "unsupported" });
      }
      const root = await projectRootOf(query("projectId"));
      // Reading the list is also observing it: one client asking tells every
      // other open surface that the topology moved. The refetch that answer
      // provokes observes an unchanged fingerprint, so this cannot loop.
      await topology.observe(query("projectId")!, root);
      // A failed listing throws. It must never be flattened into "no
      // worktrees" — an empty list and an unreadable repository are different
      // answers, and only one of them is safe to act on.
      const worktrees = (await git.isRepo(root)) ? await git.worktrees.list(root) : [];
      // Per-checkout Git state is what makes push/merge meaningful, but it is
      // one `git status` per worktree — only read it when a caller asks.
      const withStatus = query("status") === "1";
      const visible = await Promise.all(worktrees.map(async (worktree) => {
        if (isManagedBranch(worktree.branch)) return null;
        const marker = await readManagedMarker(git, worktree.path);
        if (marker) return null;
        if (!withStatus) return worktree;
        try {
          const status = await git.status(worktree.path);
          return {
            ...worktree,
            ahead: status.ahead,
            behind: status.behind,
            changed: status.staged.length + status.unstaged.length
              + status.untracked.length + status.conflicted.length,
            conflicted: status.conflicted.length,
            ...(status.upstream ? { upstream: status.upstream } : {}),
          };
        } catch {
          // A checkout Git cannot describe right now is still a real worktree.
          // Omitting the counts says "unknown"; inventing zeros would not.
          return worktree;
        }
      }));
      json(200, visible.filter((worktree) => worktree !== null));
      return true;
    }

    // Build the live local-conflict prompt without creating a session or
    // sending anything. The browser opens it as an editable composer draft.
    if (path === "/api/git/conflict-prompt" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const target = String(input.target ?? "");
      const resolved = await conflictRootOf(projectId, target, input.sessionId ? String(input.sessionId) : "", optionalRepositoryId(input.repositoryId));
      if ("status" in resolved) {
        json(resolved.status, { ok: false, reason: resolved.reason });
        return true;
      }
      const root = resolved.root;
      if (!(await git.isRepo(root))) {
        json(409, { ok: false, reason: "this project is not a git repository" });
        return true;
      }
      const status = await git.status(root);
      const problem = typeof input.problem === "string" && input.problem.trim() ? input.problem.trim() : undefined;
      const prompt = buildLocalConflictResolutionPrompt({
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        conflictedPaths: status.conflicted.map((file) => file.path),
        diverged: status.ahead > 0 && status.behind > 0,
        ...(problem ? { problem } : {}),
      }, String(input.prompt ?? ""));
      json(200, { ok: true, data: { prompt } });
      return true;
    }

    // Backward-compatible server-side handoff for non-browser clients. The
    // GitView uses /api/git/conflict-prompt so the user can edit before send.
    if (path === "/api/git/resolve-conflict-agent" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const target = String(input.target ?? "");
      const givenSessionId = input.sessionId ? String(input.sessionId) : "";
      const resolved = await conflictRootOf(projectId, target, givenSessionId, optionalRepositoryId(input.repositoryId));
      if ("status" in resolved) {
        json(resolved.status, { ok: false, reason: resolved.reason });
        return true;
      }
      const root = resolved.root;

      if (!(await git.isRepo(root))) {
        json(409, { ok: false, reason: "this project is not a git repository" });
        return true;
      }
      const status = await git.status(root);
      const conflictedPaths = status.conflicted.map((file) => file.path);
      const diverged = status.ahead > 0 && status.behind > 0;
      const problem = typeof input.problem === "string" && input.problem.trim() ? input.problem.trim() : undefined;
      const hasConflict = conflictedPaths.length > 0 || diverged;

      let sessionId = givenSessionId;
      if (target === "new-session") {
        sessionId = (await (deps.scopedSessions?.(rc.space) ?? deps.sessions).create({
          projectId,
          title: hasConflict ? "Resolve git conflicts" : "Resolve git problem",
        })).id;
      }

      const prompt = buildLocalConflictResolutionPrompt(
        {
          branch: status.branch,
          ahead: status.ahead,
          behind: status.behind,
          conflictedPaths,
          diverged,
          ...(problem ? { problem } : {}),
        },
        String(input.prompt ?? ""),
      );
      await deps.append?.(sessionId, "git/conflict-resolution-started", {
        branch: status.branch ?? "",
        ahead: status.ahead,
        behind: status.behind,
        conflictedCount: conflictedPaths.length,
        diverged,
        ...(problem ? { problem } : {}),
      });
      await deps.sessions.send(sessionId, { text: prompt, githubConflictResolution: true });
      json(200, { ok: true, data: { sessionId } });
      return true;
    }

    if (method !== "POST") return false;
    if (path === "/api/git/identity") {
      requireIdentityAuthority(rc.space);
      // `git config --local` and core.sshCommand are the installation owner's
      // ambient identity; everyone else commits with their own profile.
      if (!gitActor().ambient) {
        throw Object.assign(new Error("The checkout's own Git configuration belongs to the instance owner. Set your git name and email in Profile → Git."), {
          code: "permission-denied",
          status: 403,
          mutationOutcome: "not-started",
        });
      }
    }
    // Commit-writing operations run as the signed-in person; resolve (or
    // refuse) before touching the checkout.
    let commitIdentity = COMMIT_ROUTES.has(path) ? commitIdentityOf(rc) : null;
    const input = await body();
    const projectId = String(input.projectId ?? "");
    if (path.startsWith("/api/worktrees") && input.repositoryId !== undefined) {
      throw Object.assign(new Error("repository-scoped worktree management is unsupported"), { code: "unsupported" });
    }
    const root = path.startsWith("/api/worktrees")
      ? await projectRootOf(projectId)
      : await rootOf(
        projectId,
        input.sessionId ? String(input.sessionId) : undefined,
        input.worktreePath ? String(input.worktreePath) : undefined,
        optionalRepositoryId(input.repositoryId),
      );
    // The instance owner commits as the project's own identity when one applies.
    if (COMMIT_ROUTES.has(path) && gitActor().ambient && deps.profiles) {
      let state: SourceControlProfileState | null = null;
      try { state = deps.profiles.read(rc.space).state; } catch { /* unreadable: keep the person's identity */ }
      commitIdentity = await projectCommitIdentity(state, projectId, root) ?? commitIdentity;
    }

    switch (path) {
      case "/api/git/stage": await git.stage(root, paths(input)); break;
      case "/api/git/unstage": await git.unstage(root, paths(input)); break;
      case "/api/git/discard": await git.discard(root, paths(input)); break;
      case "/api/git/folder": {
        const operation = String(input.op ?? "");
        const folder = assertGitRelativePath(String(input.folder ?? ""), true);
        const expanded = pathsUnder(await git.status(root), folder);
        if (operation === "stage") await git.stage(root, [...expanded.unstaged, ...expanded.untracked, ...expanded.conflicted]);
        else if (operation === "unstage") await git.unstage(root, expanded.staged);
        else if (operation === "discard") await git.discard(root, [...expanded.unstaged, ...expanded.untracked]);
        else {
          json(400, { error: "invalid-input", message: "op must be stage|unstage|discard" });
          return true;
        }
        break;
      }
      case "/api/git/commit":
        json(200, await withGitCommitIdentity(commitIdentity, () => git.commit(root, String(input.message ?? ""))));
        return true;
      case "/api/git/commit-message":
        json(200, { message: await deps.commitMessage(root, rc.space.userId) });
        return true;
      case "/api/git/branch":
        await git.createBranch(root, String(input.name ?? ""), input.from ? String(input.from) : undefined);
        break;
      case "/api/git/checkout": await git.checkout(root, String(input.name ?? "")); break;
      case "/api/git/stash":
        json(200, await withGitCommitIdentity(commitIdentity, () => git.stashPush(root, input.message ? String(input.message) : undefined)));
        return true;
      case "/api/git/stash/apply": await git.stashApply(root, input.ref ? String(input.ref) : undefined); break;
      case "/api/git/stash/drop": await git.stashDrop(root, input.ref ? String(input.ref) : undefined); break;
      case "/api/git/fetch":
      case "/api/git/pull":
      case "/api/git/rebase":
      case "/api/git/push":
      case "/api/git/sync": {
        const remoteName = input.remote ? String(input.remote) : undefined;
        // The signed-in person's account (or the project's Space account)
        // authenticates its own host; the host's own helpers only for the
        // instance owner on a local-trusted install.
        const auth = deps.accounts
          ? await deps.accounts.actorTransportAuth({ actor: gitActor(), space: rc.space, remoteUrl: await remoteUrlOf(root, remoteName), projectId })
          : null;
        await withGitCommitIdentity(commitIdentity, () => withGitTransportAuth(auth, () => {
          if (path === "/api/git/fetch") return git.fetch(root, remoteName);
          if (path === "/api/git/pull") return git.pull(root, remoteName);
          if (path === "/api/git/rebase") return git.rebase(root, remoteName);
          if (path === "/api/git/push") return git.push(root, remoteName);
          return git.sync(root, remoteName);
        }, { hostCredentials: gitActor().ambient }));
        break;
      }
      case "/api/git/merge": {
        const ref = String(input.ref ?? "").trim();
        if (!ref) throw Object.assign(new Error("ref required"), { code: "invalid-input" });
        // Managed isolation branches are published through the isolation
        // service, which owns snapshotting, compare-and-swap and rebind. A raw
        // merge would bypass every one of those guarantees.
        if (isManagedBranch(ref)) {
          throw Object.assign(new Error("isolated sessions are integrated from the session, not by a raw merge"), {
            code: "invalid-input",
          });
        }
        json(200, await withGitCommitIdentity(commitIdentity, () => git.merge(root, ref)));
        return true;
      }
      case "/api/git/merge/abort":
        await git.abortMerge(root);
        break;
      case "/api/git/identity": {
        const anonymous = typeof input.anonymous === "boolean" ? input.anonymous : undefined;
        if (anonymous && typeof input.sshKey === "string") {
          throw Object.assign(new Error("an anonymous checkout cannot sign in with an SSH key"), { code: "invalid-input" });
        }
        await git.setIdentity(root, { name: String(input.name ?? ""), email: String(input.email ?? "") });
        // Both write core.sshCommand: release the other's value first.
        if (anonymous) await applySshKey(root, null);
        else await applyAnonymous(root, anonymous);
        await applySshKey(root, input.sshKey as string | null | undefined);
        if (anonymous) await applyAnonymous(root, true);
        await applySigningKey(root, input.signingKey as string | null | undefined);
        json(200, await checkoutIdentity(root));
        return true;
      }
      case "/api/worktrees": {
        const branch = String(input.branch ?? "");
        if (isManagedBranch(branch)) {
          throw Object.assign(new Error("managed isolation branches cannot be used for ordinary worktrees"), {
            code: "invalid-input",
          });
        }
        const created = await git.worktrees.create(root, {
          branch,
          ...(input.path ? { path: String(input.path) } : {}),
          ...(input.base ? { base: String(input.base) } : {}),
          ...(input.newBranchOnly === true ? { newBranchOnly: true } : {}),
        });
        // Git has accepted the topology change and the checkout is complete —
        // `worktree add` does not return until it is. Announce before
        // responding so other open surfaces converge with the caller's.
        await announceTopology(projectId, root);
        json(200, created);
        return true;
      }
      case "/api/worktrees/remove": {
        const worktreePath = String(input.path ?? "");
        const activeIsolation = (await deps.sessions.list(projectId)).find((session) =>
          session.isolation?.kind === "git-worktree"
          && resolve(session.isolation.worktreePath) === resolve(worktreePath));
        if (activeIsolation) {
          throw Object.assign(new Error("merge or discard the isolated session before removing its workspace"), {
            code: "conflict",
          });
        }
        const deleteBranch = input.deleteBranch === true;
        const force = input.force === true;
        const ownedBranch = deleteBranch
          ? await ownedBranchForWorktree(deps.sessions, projectId, worktreePath)
          : null;
        // GitService owns physical removal and postcondition verification.
        // The route must not reinterpret Git state through the lossy public list.
        const cleanup = await git.worktrees.remove(root, {
          path: worktreePath,
          deleteBranch,
          force,
          ...(ownedBranch ? { ownedBranch } : {}),
        }) ?? {};
        await announceTopology(projectId, root);
        let metadataCleanupFailed = false;
        try {
          await deps.sessions.markWorktreeMissing?.(projectId, worktreePath);
        } catch (error) {
          metadataCleanupFailed = true;
          console.error("[polyth] worktree metadata cleanup failed after removal", error);
        }
        json(200, {
          ok: true,
          ...(metadataCleanupFailed ? { metadataCleanupFailed: true } : {}),
          ...(cleanup.branchCleanupFailed ? { branchCleanupFailed: true } : {}),
        });
        return true;
      }
      default:
        return false;
    }
    json(200, { ok: true });
    return true;
  };
}

/** The newest durable event of `type` from the indexed fact query, without
 *  loading the session's whole log. `eventsOfTypes` pages oldest-first. */
export async function latestEventOfType(
  store: Pick<SessionPersistence, "events" | "latestSeq"> & Partial<Pick<SessionPersistence, "eventsOfTypes">>,
  sessionId: string,
  type: string,
): Promise<SessionEvent | undefined> {
  if (!store.eventsOfTypes) return (await store.events(sessionId)).findLast((event) => event.type === type);
  const through = await store.latestSeq(sessionId);
  let last: SessionEvent | undefined;
  for (let after = 0; ;) {
    const page = await store.eventsOfTypes(sessionId, [type], after, through, 500);
    if (page.length) { last = page.at(-1); after = last!.seq; }
    if (page.length < 500) return last;
  }
}

/** A `{ branch, path }` naming a checked-out branch and its checkout. */
function checkoutTarget(raw: unknown): { branch: string; path: string } {
  const target = raw as { branch?: unknown; path?: unknown } | null;
  if (!target || typeof target !== "object"
    || typeof target.branch !== "string" || !target.branch.trim()
    || typeof target.path !== "string" || !target.path.trim()) {
    throw Object.assign(new Error("target needs a branch and the path of its checkout"), { code: "invalid-input" });
  }
  return { branch: target.branch, path: target.path };
}

export function isolationRoutes(deps: {
  isolation: IsolationService;
  /** The requester's scoped sessions, so a new isolated chat is owned by the
   *  person who started it rather than by system work. */
  scopedSessions?: (space: import("@polyth/contracts").SpaceContext) => IsolationRequesterSessions & IsolationExistingSessions;
}): RouteHandler {
  const { isolation } = deps;
  return async (rc) => {
    const { path, method, url, body, json, space } = rc;
    if (!path.startsWith("/api/isolation")) return false;
    // Git work the person asks for here runs as the session's actor (commit
    // identity) and with the asking person's own credentials (push).
    const requester = requestGitActor(rc);

    if (path === "/api/isolation/sessions" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-input" });
      const rawHarness = input.harness as { mode?: unknown; harnessId?: unknown } | undefined;
      const harness = rawHarness?.mode === "auto"
        ? { mode: "auto" as const }
        : rawHarness?.mode === "pinned" && typeof rawHarness.harnessId === "string" && /^[a-z][a-z0-9-]*$/.test(rawHarness.harnessId)
          ? { mode: "pinned" as const, harnessId: rawHarness.harnessId }
          : undefined;
      if (input.harness !== undefined && !harness) throw Object.assign(new Error("invalid harness selection"), { code: "invalid-input" });
      let repositoryIds: string[] | undefined;
      if (input.repositoryIds !== undefined) {
        if (!Array.isArray(input.repositoryIds)
          || !input.repositoryIds.every((repositoryId: unknown) => typeof repositoryId === "string")) {
          throw Object.assign(new Error("repositoryIds must be a list of strings"), { code: "invalid-input" });
        }
        repositoryIds = [...input.repositoryIds] as string[];
      }
      // Keyed create: the canonical id is derived from (account, Space, key),
      // so a resend after a lost response returns the same session and its
      // managed checkouts instead of allocating a second worktree.
      const requestedOperationId = clientOperationIdInput(input.clientOperationId);
      json(200, await isolation.createIsolatedSession({
        projectId,
        ...(input.purpose !== undefined ? { purpose: input.purpose as string } : {}),
        ...(repositoryIds !== undefined ? { repositoryIds } : {}),
        ...(harness ? { harness } : {}),
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(input.model && typeof input.model === "object" ? { model: input.model as CreateIsolatedSessionInput["model"] } : {}),
        ...(typeof input.agent === "string" ? { agent: input.agent } : {}),
        ...(typeof input.sourceSessionId === "string" ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(typeof input.targetBranch === "string" ? { targetBranch: input.targetBranch } : {}),
      }, {
        ...(requestedOperationId ? { sessionId: sessionIdForCreateOperation(requestedOperationId, space) } : {}),
        ...(deps.scopedSessions ? { sessions: deps.scopedSessions(space) } : {}),
      }));
      return true;
    }

    const match = /^\/api\/isolation\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!match) return false;
    const sessionId = decodeURIComponent(match[1]!);
    const action = match[2];
    if (method !== "GET" && method !== "POST") return false;

    // The isolation service works on unscoped sessions, so every route that
    // names one resolves it through the requester's own scope first: a chat of
    // another Space, or one this person cannot open, is not-found and its
    // existence never leaks. Reads need view access; lifecycle actions change
    // the chat's workspace and need `manage`, like any other workspace rebind.
    // Handing a conflict to the chat's agent is working in it (`collaborate`).
    if (deps.scopedSessions) {
      const row = await deps.scopedSessions(space).snapshot(sessionId);
      const required: SessionAccessLevel = method === "GET" ? "view" : action === "resolve" ? "collaborate" : "manage";
      if (row.sharing && !sessionAccessAtLeast(row.sharing.access, required)) {
        throw Object.assign(new Error(required === "manage"
          ? "Only people who manage this chat can do that"
          : "You can view this chat but not work in it"), { code: "forbidden" });
      }
    }

    if (!action && method === "GET") {
      json(200, await isolation.getStatus(sessionId));
      return true;
    }
    if (action === "conflicts" && method === "GET") {
      json(200, await isolation.conflictPreview(sessionId));
      return true;
    }
    if (method !== "POST") return false;
    let actionInput: Record<string, unknown> | undefined;
    const readRepositoryId = async (): Promise<string | undefined> => {
      const fromQuery = url.searchParams.get("repositoryId");
      if (fromQuery) return fromQuery;
      actionInput ??= await body() as Record<string, unknown>;
      return typeof actionInput.repositoryId === "string" && actionInput.repositoryId
        ? actionInput.repositoryId
        : undefined;
    };
    const repositoryId = action === "merge" || action === "keep" || action === "discard" || action === "recover"
      ? await readRepositoryId()
      : undefined;
    if (repositoryId) {
      if (action === "merge") {
        json(200, await isolation.mergeRepository(sessionId, repositoryId, { requester }));
        return true;
      }
      if (action === "keep") {
        json(200, await isolation.keepRepository(sessionId, repositoryId));
        return true;
      }
      if (action === "discard") {
        json(200, await isolation.discardRepository(sessionId, repositoryId));
        return true;
      }
      if (action === "recover") {
        json(200, await isolation.recoverRepository(sessionId, repositoryId));
        return true;
      }
    }
    if (action === "recover") {
      json(200, await isolation.recover(sessionId));
      return true;
    }
    if (action === "merge") {
      const input = actionInput ?? await body() as Record<string, unknown>;
      const target = input.target === undefined ? undefined : checkoutTarget(input.target);
      if (input.push !== undefined && typeof input.push !== "boolean") {
        throw Object.assign(new Error("push must be true or false"), { code: "invalid-input" });
      }
      json(200, await isolation.mergeBack(sessionId, {
        requester,
        ...(target ? { target } : {}),
        ...(input.push === true ? { push: true } : {}),
      }));
      return true;
    }
    if (action === "retarget") {
      json(200, await isolation.retarget(sessionId, checkoutTarget(actionInput ?? await body())));
      return true;
    }
    if (action === "keep") {
      json(200, await isolation.keepIsolated(sessionId));
      return true;
    }
    if (action === "discard") {
      json(200, await isolation.discard(sessionId));
      return true;
    }
    if (action === "abandon") {
      json(200, await isolation.abandonCleanup(sessionId));
      return true;
    }
    if (action === "return") {
      json(200, await isolation.returnUnchanged(sessionId));
      return true;
    }
    if (action === "isolate") {
      json(200, await isolation.isolateSession(sessionId, deps.scopedSessions ? { sessions: deps.scopedSessions(space) } : {}));
      return true;
    }
    if (action === "resolve") {
      json(200, await isolation.resolveWithAgent(sessionId, { requester }));
      return true;
    }
    if (action === "push") {
      const input = actionInput ?? await body();
      json(200, await isolation.push(sessionId, {
        ...(typeof input.remote === "string" ? { remote: input.remote } : {}),
        ...(typeof input.branch === "string" ? { branch: input.branch } : {}),
        ...(typeof input.message === "string" ? { message: input.message } : {}),
        requester,
      }));
      return true;
    }
    return false;
  };
}

export const GIT_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["git", "worktrees", "isolation"],
  http: [
    { methods: ["GET"], path: "/api/git/status", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/diff", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/show", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/log", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/graph", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/branches", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/stashes", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/identity", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/source-control-profiles", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["PUT"], path: "/api/git/source-control-profiles", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["GET"], path: "/api/git/ssh-keys", capability: REMOTE_CAPABILITY.gitWrite, mutation: false },
    { methods: ["POST"], path: "/api/git/ssh-keys/test", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["GET"], path: "/api/git/profile", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["PUT", "DELETE"], path: "/api/git/profile", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["GET"], path: "/api/git/service-policy", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["PUT"], path: "/api/git/service-policy", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["GET"], path: "/api/git/accounts", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/account", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["PUT", "DELETE"], path: "/api/git/account", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["GET"], path: "/api/worktrees", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/isolation/:sessionId", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["POST"], path: "/api/git/resolve-conflict-agent", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/conflict-prompt", capability: REMOTE_CAPABILITY.gitRead, mutation: true },
    { methods: ["POST"], path: "/api/git/stage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/unstage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/folder", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/commit", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/commit-message", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/branch", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/checkout", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stash", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stash/apply", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stash/drop", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/fetch", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/pull", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/rebase", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/push", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/sync", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/merge", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/merge/abort", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/identity", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/worktrees", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/worktrees/remove", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/sessions", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/merge", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/retarget", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/keep", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/abandon", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/return", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/isolate", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/resolve", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/isolation/:sessionId/push", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
  ],
};

/** The commit author of the identity a project uses (its own, else the default
 *  for all projects), or null for System Git, an identity without an author,
 *  or one that does not apply to the repository's `origin` host. */
export async function projectCommitIdentity(
  state: SourceControlProfileState | null | undefined,
  projectId: string,
  root: string | null,
): Promise<SourceControlCommitIdentity | null> {
  if (!state || !projectId) return null;
  const id = state.repositoryProfileIds[projectId] ?? state.globalDefaultProfileId;
  if (!id) return null;
  const url = root ? await gitRemoteUrl(root, "origin").catch(() => null) : null;
  const resolution = resolveSourceControlContext({
    profiles: state.profiles,
    remote: url ? parseSourceControlRemoteUrl(url) : null,
    repositoryProfileId: state.repositoryProfileIds[projectId],
    globalProfileId: state.globalDefaultProfileId,
  });
  return resolution.ok ? resolution.profile?.commitAuthor ?? null : null;
}

/**
 * Git work done for a session (Spaces §14.4), for the isolation service:
 *
 * - commits carry the session's actor (`SessionProjection.actor`, while they
 *   are a member), else the person who asked, else the Space's service
 *   identity (its default identity's author) or the checkout's configuration;
 * - credentials are the asking person's own (a UI push), else the actor's as
 *   agent work, else system work — never another member's account.
 *
 * Both are resolved, or refused, before `fn` runs.
 */
export function createActingGit(deps: {
  /** A person's own context in a Space; null unless they are an active member. */
  personContext(userId: string, spaceId: string): SpaceContext | null;
  systemContext(spaceId: string): SpaceContext;
  projectSpace(projectId: string): Promise<string | undefined>;
  profiles: Pick<PersonGitProfiles, "read">;
  serviceIdentity(spaceId: string): SourceControlCommitIdentity | null;
  /** The commit author of the project's own identity; null for System Git.
   *  Optional so existing test fakes stay valid. */
  projectIdentity?(spaceId: string, projectId: string): Promise<SourceControlCommitIdentity | null>;
  accounts: Pick<SourceControlAccountService, "actorTransportAuth">;
}) {
  return async <T,>(input: { session: SessionProjection; requester?: GitActor; transport?: { root: string; remote: string } }, fn: () => Promise<T>): Promise<T> => {
    const { session, requester } = input;
    const spaceId = session.spaceId ?? await deps.projectSpace(session.projectId) ?? requester?.spaceId;
    if (!spaceId) return fn();
    const actorId = session.actor?.userId;
    const actorSpace = isPersonId(actorId) ? deps.personContext(actorId, spaceId) : null;
    const sessionActor: GitActor | null = actorSpace
      ? { spaceId, userId: actorId!, space: actorSpace, origin: "agent", ambient: contextMayUseInstallation(actorSpace) }
      : null;
    const systemSpace = deps.systemContext(spaceId);
    const system: GitActor = { spaceId, space: systemSpace, origin: "system", ambient: false };
    const commitActor = sessionActor ?? requester ?? system;
    const projectAuthor = deps.projectIdentity && (commitActor.ambient || !commitActor.userId)
      ? await deps.projectIdentity(spaceId, session.projectId).catch(() => null)
      : undefined;
    const identity = resolveGitCommitIdentity({
      actor: commitActor,
      profiles: deps.profiles,
      serviceIdentity: () => deps.serviceIdentity(spaceId),
      ...(projectAuthor !== undefined ? { projectIdentity: () => projectAuthor } : {}),
    });
    let auth = null;
    let hostCredentials = true;
    if (input.transport) {
      const actor = requester ?? sessionActor ?? system;
      hostCredentials = actor.ambient;
      const raw = input.transport.remote;
      const remoteUrl = await gitRemoteUrl(input.transport.root, raw) ?? (/^[\w.-]{1,120}$/.test(raw) ? null : raw);
      auth = await deps.accounts.actorTransportAuth({ actor, space: actor.space ?? systemSpace, remoteUrl, projectId: session.projectId });
    }
    return withGitCommitIdentity(identity, () => withGitTransportAuth(auth, fn, { hostCredentials }));
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Shared with the session service (worktree validation), tracks, github, and
  // walkthrough capture — published at load time under the well-known key.
  const git = createGitService();
  host.services.provide(serverServiceKey<GitService>("git"), git);
  // Provider packages (GitHub, GitLab, …) register their account credentials here.
  const credentialRegistry = createSourceControlCredentialRegistry();
  host.services.provide(serverServiceKey<SourceControlCredentialRegistry>(SOURCE_CONTROL_CREDENTIAL_REGISTRY), credentialRegistry);
  const people = host.people;
  const servicePolicy = {
    read: (spaceId: string): PackageServicePolicy => {
      try { return people?.servicePolicy(spaceId, "git") ?? { agentsMayUseService: false }; }
      catch { return { agentsMayUseService: false }; }
    },
    write: (spaceId: string, policy: PackageServicePolicy): void => {
      if (!people) throw Object.assign(new Error("Space account policy is unavailable on this server."), { code: "unavailable" });
      people.setServicePolicy(spaceId, "git", policy);
    },
  };
  const accounts = createSourceControlAccountService({
    registry: credentialRegistry,
    storage: (space) => host.spaceStorage(space),
    ...(people ? { isMember: (userId: string, spaceId: string) => people.isMember(userId, spaceId) } : {}),
    servicePolicy: servicePolicy.read,
  });
  const personProfiles = createPersonGitProfiles(people);
  host.services.provide(serverServiceKey<SourceControlAccountService>(GIT_SOURCE_CONTROL_ACCOUNTS), accounts);
  host.services.provide(
    serverServiceKey<TemporaryWorktreeBranchService>("git.temporary-worktree-branches"),
    createTemporaryWorktreeBranchService({
      git,
      projects: host.projects,
      sessions: host.sessions,
      worktreesChanged: (projectId) => host.broadcast.worktreesChanged?.(projectId),
    }),
  );
  const commitSettings = createCommitSettingsStore((space) => host.spaceStorage(space));
  const profiles = createSourceControlProfilesStore((space) => host.spaceStorage(space));

  const actingGit = createActingGit({
    personContext: (userId, spaceId) => {
      const person = host.personSpaceContext?.(userId, spaceId);
      if (person) return person;
      // Single-person (pre-canonical) installs mint no person contexts:
      // their one person is the system context's.
      const system = host.systemSpaceContext(spaceId);
      return system.userId === userId ? system : null;
    },
    systemContext: (spaceId) => host.systemSpaceContext(spaceId),
    projectSpace: async (projectId) => (await host.projects.get(projectId))?.spaceId,
    profiles: personProfiles,
    serviceIdentity: (spaceId) => {
      try {
        const { state } = profiles.read(host.systemSpaceContext(spaceId));
        return state.profiles.find((row) => row.id === state.globalDefaultProfileId)?.commitAuthor ?? null;
      } catch {
        return null;
      }
    },
    projectIdentity: async (spaceId, projectId) => {
      const project = await host.projects.get(projectId);
      let state: SourceControlProfileState | null = null;
      try { state = profiles.read(host.systemSpaceContext(spaceId)).state; } catch { /* unreadable: checkout config */ }
      return projectCommitIdentity(state, projectId, project?.path ?? null);
    },
    accounts,
  });
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: GIT_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    async onEnable() {
      const commitMessage = createCommitMessageGenerator({
        diff: (root, opts) => git.diff(root, opts),
        runtime: async (root, model) => {
          const project = (await host.projects.list()).find((candidate) => candidate.path === root);
          return host.runtimes.forProject(project?.id ?? "__default__", root, model?.harnessId);
        },
        model: (userId) => host.smallModel(userId),
        inputBudget: (runtime, model, maxOutputTokens) => host.smallModelInputBudget(runtime, model, maxOutputTokens),
        complete: (runtime, options) => host.smallModelComplete(runtime, {
          ...options,
          purpose: "commit-message-generation",
        }),
      });
      const append = (sessionId: string, type: string, data: JsonObject) => host.events.append(
        sessionId,
        type,
        data,
        { ignorable: true, producerPlugin: "git" },
      );
      const isolation = createIsolationService({
        git,
        generateCommitMessage: async (session, root) => {
          const project = await host.projects.get(session.projectId);
          const spaceId = session.spaceId ?? project?.spaceId;
          if (!spaceId) throw new Error("Session Space is unavailable");
          const space = host.systemSpaceContext(spaceId);
          const settings = commitSettings.read(space).settings;
          const binding = await host.resolveSessionRuntime(session.id);
          const model = settings.mode === "custom" ? settings.model
            : settings.mode === "small" ? host.smallModel(space.userId)
            : binding.model ? { ...binding.model, harnessId: binding.rt.harnessId } : undefined;
          const generator = createCommitMessageGenerator({
            diff: (path, opts) => git.diff(path, opts),
            runtime: async (_path, selected) => selected?.harnessId && selected.harnessId !== binding.rt.harnessId
              ? host.runtimes.forProject(session.projectId, binding.cwd, selected.harnessId) : binding.rt,
            inputBudget: (runtime, selected, maxOutputTokens) => host.smallModelInputBudget(runtime, selected, maxOutputTokens),
            complete: (runtime, options) => host.smallModelComplete(runtime, { ...options, cwd: binding.cwd, purpose: "commit-message-generation" }),
          });
          return generator(root, space.userId, model);
        },
        sessions: host.sessions,
        projects: host.projects,
        append,
        readEvents: (sessionId) => host.sessions.events(sessionId),
        latestTurnStop: (sessionId) => latestEventOfType(host.store, sessionId, "turn/stopped"),
        latestEvent: (sessionId, type) => latestEventOfType(host.store, sessionId, type),
        actingGit,
        preserveSessionMedia: (input) => {
          const service = host.services.get(serverServiceKey<{ preserve: PreserveSessionMedia }>("files.session-media"));
          return service?.preserve(input)
            ?? Promise.resolve({ copied: [], skipped: [], missing: [], notIgnored: [] });
        },
        closeWorkspaceProcesses: async (cwd) => {
          const terminals = host.services.get<{ closeByCwd(path: string): Promise<void> }>(
            serverServiceKey("terminal"),
          );
          await terminals?.closeByCwd(cwd);
          // Utility completions (titles, commit messages, recaps) acquire
          // project-scoped runtimes in the session's checkout. Nothing else
          // releases them, so they would outlive the deleted directory.
          await host.runtimes.retireWorkspace?.(cwd).catch((error: unknown) => {
            console.warn(`[polyth] isolation workspace runtime release failed for ${cwd}`, error);
          });
        },
      });
      // One service under the shared key: core consumers read the full
      // lifecycle, Polyth delegation reads the narrow typed contract.
      host.services.provide(SERVER_SESSION_ISOLATION, isolation);
      const handoffRegistry = host.services.get(serverServiceKey<import("@polyth/handoff").ContextSourceRegistry>("handoff.sources"));
      if (handoffRegistry) {
        registerGitHandoffSources({ registry: handoffRegistry, git, projects: host.projects });
      }
      const gitHandler = gitRoutes({
        projects: host.projects,
        sessions: host.sessions,
        git,
        remote: { host: (connectionId) => host.services.require<{ host(id: string): RemoteHost }>(serverServiceKey("ssh")).host(connectionId) },
        commitMessage,
        append,
        worktreesChanged: (projectId) => host.broadcast.worktreesChanged?.(projectId),
        accounts,
        scopedProjects: (space) => host.forSpace(space).projects,
        scopedSessions: (space) => host.forSpace(space).sessions,
        profiles,
        personProfiles,
        servicePolicy,
      });
      const isolationHandler = isolationRoutes({ isolation, scopedSessions: (space) => host.forSpace(space).sessions });
      await isolation.recoverAll();
      routes ??= async (request) => {
        if (request.path === "/api/git/commit-settings" && ["GET", "PUT"].includes(request.method)) {
          if (request.method === "GET") request.json(200, commitSettings.read(request.space));
          else {
            const input = await request.body() as { settings: unknown; expectedRevision: number };
            request.json(200, commitSettings.save(request.space, input.settings, input.expectedRevision));
          }
          return true;
        }
        if (request.path === "/api/git/source-control-profiles" && ["GET", "PUT"].includes(request.method)) {
          if (request.method === "GET") request.json(200, profiles.read(request.space));
          else {
            const input = await request.body() as { state: unknown; expectedRevision: number };
            request.json(200, profiles.save(request.space, input.state, input.expectedRevision));
          }
          return true;
        }
        if (request.path === "/api/git/ssh-keys" && request.method === "GET") { request.json(200, { keys: listSshKeys() }); return true; }
        if (request.path === "/api/git/ssh-keys/test" && request.method === "POST") {
          const input = await request.body() as { path: unknown; host?: unknown };
          request.json(200, await testSshKey(input.path, input.host));
          return true;
        }
        return (await isolationHandler(request)) || (await gitHandler(request));
      };
    },
  };
}
