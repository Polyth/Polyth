import {
  REMOTE_CAPABILITY,
  type RemoteAccessPolicy,
} from "@polyth/contracts";
import { resolveWorkspaceContext, workspaceExecutionPath, workspaceRepository } from "@polyth/contracts/workspace";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { GitService } from "./index.ts";
import type { RepoStackInput } from "./stackTypes.ts";
import registerGitPackage, { assertGitRelativePath, GIT_REMOTE_ACCESS, GIT_SOURCE_CONTROL_ACCOUNTS, projectCommitIdentity } from "./serverEntry.ts";
import { createSourceControlProfilesStore } from "./sourceControlProfilesStore.ts";
import { createPersonGitProfiles, requestGitActor, resolveGitCommitIdentity } from "./actingPerson.ts";
import { gitRemoteUrl, withGitCommitIdentity, withGitTransportAuth, type SourceControlAccountService } from "./sourceControlAccounts.ts";
import { gitDiffSnapshotDigest, mutateGitHunk, type GitHunkOperation } from "./hunkMutation.ts";
import { inspectGitSourceControlRemotes } from "./sourceControlRemotes.ts";
import { applyRepoStack, loadRepoStacks, previewRepoStack, pushRepoStackBranch, saveRepoStacks, validateRepoStack, resolveRepoStackInput, withRepoStackStorageLock, type RepoStack } from "./stack.ts";

const HUNK_HTTP: RemoteAccessPolicy["http"] = [
  { methods: ["POST"], path: "/api/git/hunk/stage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
  { methods: ["POST"], path: "/api/git/hunk/unstage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
  { methods: ["POST"], path: "/api/git/hunk/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
];

export const GIT_SOURCE_CONTROL_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [...GIT_REMOTE_ACCESS.routeScopes],
  http: [
    ...GIT_REMOTE_ACCESS.http,
    { methods: ["GET"], path: "/api/git/branch-diff", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/remotes", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/stacks", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/stacks/:id", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["GET"], path: "/api/git/stacks/:id/preview", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
    { methods: ["POST"], path: "/api/git/stacks", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST", "PATCH", "DELETE"], path: "/api/git/stacks/:id", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stacks/:id/restack", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    { methods: ["POST"], path: "/api/git/stacks/:id/push", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
    ...HUNK_HTTP,
  ],
};

/**
 * Thin additive entry point around the established Git server package. Keeping
 * provider identity and hunk review mutations here avoids rewriting GitService:
 * canonical Git diff/status remain the source of truth and hunk mutation adds
 * only an exact-snapshot validation/application boundary.
 */
export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const base = registerGitPackage(host);
  const baseRoutes = base.routes;
  const personProfiles = createPersonGitProfiles(host.people);
  const sourceControlProfiles = createSourceControlProfilesStore((space) => host.spaceStorage(space));

  const rootOf = async (projectId: string | null, sessionId?: string | null, repositoryId?: string | null): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await host.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    const session = sessionId ? await host.sessions.snapshot(sessionId) : null;
    if (session && session.projectId !== projectId) {
      throw Object.assign(new Error("session does not belong to this project"), { code: "not-found" });
    }
    if (session?.worktreeState === "missing" && (repositoryId === undefined || repositoryId === null)) {
      throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
    }
    const context = resolveWorkspaceContext(project, session);
    if (repositoryId !== undefined && repositoryId !== null) {
      const repository = workspaceRepository(context, repositoryId);
      if (repository.state === "missing") throw Object.assign(new Error("repository checkout is missing"), { code: "not-found" });
      return repository.path;
    }
    return session ? workspaceExecutionPath(project, session) : project.path;
  };

  return {
    ...base,
    remoteAccess: GIT_SOURCE_CONTROL_REMOTE_ACCESS,
    routes: async (request) => {
      const git = host.services.require<GitService>(serverServiceKey("git"));
      const mutateStacks = <T,>(storage: import("@polyth/contracts").SpaceStorage, fn: (stacks: RepoStack[]) => Promise<{ stacks: RepoStack[]; result: T }>): Promise<T> =>
        withRepoStackStorageLock(storage, async () => { const current = await loadRepoStacks(storage); const next = await fn(current); await saveRepoStacks(storage, next.stacks); return next.result; });

      if (request.path === "/api/git/branch-diff" && request.method === "GET") {
        const query = (name: string) => request.url.searchParams.get(name);
        const projectId = query("projectId");
        if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-input", status: 400 });
        const unavailable = () => Object.assign(new Error("workspace not found"), { code: "not-found", status: 404 });
        const scoped = host.forSpace(request.space);
        let project;
        let session;
        try {
          project = await scoped.projects.get(projectId);
          session = query("sessionId") !== null ? await scoped.sessions.snapshot(query("sessionId")!) : null;
        } catch { throw unavailable(); }
        if (!project || (query("sessionId") !== null && (!session || session.projectId !== projectId))) throw unavailable();
        if (project.remote) throw Object.assign(new Error("branch review requires a local repository"), { code: "unsupported" });
        let root: string;
        let isolation = session?.isolation;
        try {
          const context = resolveWorkspaceContext(project, session);
          const repositoryId = query("repositoryId");
          if (repositoryId !== null) {
            const repository = workspaceRepository(context, repositoryId);
            if (repository.state === "missing") throw unavailable();
            root = repository.path;
            isolation = session?.workspace?.repositories.find((row) => row.repositoryId === repositoryId)?.isolation
              ?? (root === session?.worktreePath ? session?.isolation : undefined);
          } else {
            if (session?.worktreeState === "missing") throw unavailable();
            root = session ? workspaceExecutionPath(project, session) : project.path;
          }
        } catch { throw unavailable(); }
        let path: string | undefined;
        if (query("path") !== null) {
          try { path = assertGitRelativePath(query("path")!); }
          catch { throw Object.assign(new Error("invalid path"), { code: "invalid-input", status: 400 }); }
        }
        const result = await git.branchDiff(root, {
          ...(isolation ? { isolation: { targetBranch: isolation.targetBranch, baseCommit: isolation.baseCommit } } : {}),
          ...(query("base") !== null ? { base: query("base")! } : {}),
          ...(path !== undefined ? { path } : {}),
          ignoreWhitespace: query("ignoreWhitespace") === "true",
        });
        request.json(200, "diff" in result ? { ...result, snapshotDigest: gitDiffSnapshotDigest(result.diff) } : result);
        return true;
      }

      if (request.path === "/api/git/stacks" && (request.method === "GET" || request.method === "POST")) {
        const input = request.method === "POST" ? await request.body() as Partial<RepoStackInput> : undefined;
        const projectId = request.url.searchParams.get("projectId") ?? (input ? String(input.projectId ?? "") : "");
        if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-input" });
        const project = await host.projects.get(projectId);
        if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
        const storage = host.spaceStorage(request.space);
        if (request.method === "GET") {
          request.json(200, { stacks: (await loadRepoStacks(storage)).filter((stack) => stack.projectId === projectId).map((stack) => validateRepoStack(project, stack)) });
          return true;
        }
        const repositoryId = String(input?.repositoryId ?? "");
        const root = await rootOf(projectId, null, repositoryId);
        const stack = await resolveRepoStackInput(git, root, project, { ...input, projectId, id: String(input?.id ?? ""), repositoryId, baseBranch: String(input?.baseBranch ?? ""), entries: Array.isArray(input?.entries) ? input.entries : [] });
        const created = await mutateStacks(storage, async (stacks) => {
          if (stacks.some((item) => item.id === stack.id && item.projectId === projectId)) throw Object.assign(new Error("repository stack already exists"), { code: "conflict" });
          return { stacks: [...stacks, stack], result: stack };
        });
        request.json(201, created);
        return true;
      }

      const stackItem = /^\/api\/git\/stacks\/([^/]+)$/.exec(request.path);
      if (stackItem) stackItem[1] = decodeURIComponent(stackItem[1]!);
      if (stackItem && (request.method === "GET" || request.method === "DELETE" || request.method === "PATCH")) {
        const projectId = request.url.searchParams.get("projectId");
        if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-input" });
        const storage = host.spaceStorage(request.space);
        const stacks = await loadRepoStacks(storage);
        const index = stacks.findIndex((item) => item.projectId === projectId && item.id === stackItem[1]);
        if (index < 0) throw Object.assign(new Error("unknown repository stack"), { code: "not-found" });
        const project = await host.projects.get(projectId);
        if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
        if (request.method === "GET") {
          request.json(200, validateRepoStack(project, stacks[index]!));
        } else if (request.method === "PATCH") {
          const patch = await request.body() as Partial<RepoStackInput>;
          const updated = await mutateStacks(storage, async (current) => {
            const existing = current.find((item) => item.id === stackItem[1] && item.projectId === projectId);
            if (!existing) throw Object.assign(new Error("unknown repository stack"), { code: "not-found" });
            const root = await rootOf(projectId, null, existing.repositoryId);
            const next = await resolveRepoStackInput(git, root, project, {
              ...existing, ...patch, id: existing.id, projectId, repositoryId: existing.repositoryId,
              entries: Array.isArray(patch.entries) ? patch.entries : existing.entries,
            }, existing);
            return { stacks: current.map((item) => item === existing ? next : item), result: next };
          });
          request.json(200, updated);
        } else {
          await mutateStacks(storage, async (current) => ({ stacks: current.filter((item) => !(item.id === stackItem[1] && item.projectId === projectId)), result: true }));
          request.json(200, { ok: true });
        }
        return true;
      }

      const stackPreview = /^\/api\/git\/stacks\/([^/]+)\/preview$/.exec(request.path);
      if (stackPreview) stackPreview[1] = decodeURIComponent(stackPreview[1]!);
      if (stackPreview && request.method === "GET") {
        const projectId = request.url.searchParams.get("projectId");
        if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-input" });
        const project = await host.projects.get(projectId);
        if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
        const stacks = await loadRepoStacks(host.spaceStorage(request.space));
        const stack = stacks.find((item) => item.projectId === projectId && item.id === stackPreview[1]);
        if (!stack) throw Object.assign(new Error("unknown repository stack"), { code: "not-found" });
        const root = await rootOf(projectId, null, stack.repositoryId);
        request.json(200, await previewRepoStack(git, root, validateRepoStack(project, stack)));
        return true;
      }

      const restack = /^\/api\/git\/stacks\/([^/]+)\/restack$/.exec(request.path);
      if (restack) restack[1] = decodeURIComponent(restack[1]!);
      if (restack && request.method === "POST") {
        const input = await request.body() as { projectId?: unknown; preview?: unknown };
        const projectId = String(input.projectId ?? "");
        const project = await host.projects.get(projectId);
        if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
        const storage = host.spaceStorage(request.space);
        // Rebased commits are committed by the signed-in person (the instance
        // owner as the project's own identity when one applies).
        const actor = requestGitActor(request);
        let projectAuthor: Awaited<ReturnType<typeof projectCommitIdentity>> = null;
        if (actor.ambient) {
          try { projectAuthor = await projectCommitIdentity(sourceControlProfiles.read(request.space).state, projectId, project.path); } catch { /* the person's identity */ }
        }
        const identity = resolveGitCommitIdentity({ actor, profiles: personProfiles, projectIdentity: () => projectAuthor });
        const result = await withGitCommitIdentity(identity, () => withRepoStackStorageLock(storage, async () => {
          const stacks = await loadRepoStacks(storage);
          const index = stacks.findIndex((item) => item.projectId === projectId && item.id === restack[1]);
          if (index < 0) throw Object.assign(new Error("unknown repository stack"), { code: "not-found" });
          const stack = validateRepoStack(project, stacks[index]!);
          const root = await rootOf(projectId, null, stack.repositoryId);
          const result = await applyRepoStack(git, root, stack, input.preview as never);
          for (const outcome of result.outcomes) {
            if (!outcome.ok || !outcome.newSha) continue;
            const entry = stack.entries.find((item) => item.branch === outcome.branch);
            if (entry) { entry.headSha = outcome.newSha; entry.baseSha = outcome.ontoSha!; }
          }
          await saveRepoStacks(storage, stacks);
          return result;
        }));
        request.json(200, result);
        return true;
      }

      const push = /^\/api\/git\/stacks\/([^/]+)\/push$/.exec(request.path);
      if (push) push[1] = decodeURIComponent(push[1]!);
      if (push && request.method === "POST") {
        const input = await request.body() as { projectId?: unknown; branch?: unknown; remote?: unknown; expectedRemoteSha?: unknown; expectedLocalSha?: unknown };
        const projectId = String(input.projectId ?? "");
        const project = await host.projects.get(projectId);
        if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
        const result = await withRepoStackStorageLock(host.spaceStorage(request.space), async () => {
          const stacks = await loadRepoStacks(host.spaceStorage(request.space));
          const saved = stacks.find((item) => item.projectId === projectId && item.id === push[1]);
          if (!saved) throw Object.assign(new Error("unknown repository stack"), { code: "not-found" });
          const stack = validateRepoStack(project, saved);
          const entry = stack.entries.find((entry) => entry.branch === input.branch);
          if (!entry) throw Object.assign(new Error("branch is not part of this stack"), { code: "invalid-input" });
          const root = await rootOf(projectId, null, stack.repositoryId);
          const preview = await previewRepoStack(git, root, stack);
          const branch = preview.entries.find((row) => row.branch === entry.branch)!;
          if (preview.warnings.length || input.expectedLocalSha !== branch.expectedHeadSha
            || input.expectedRemoteSha !== branch.expectedRemoteSha || input.remote !== branch.remote) {
            throw Object.assign(new Error("push preview is stale; refresh before updating remote branches"), { code: "conflict" });
          }
          // The signed-in person's account pushes (see actorTransportAuth).
          const accounts = host.services.get<SourceControlAccountService>(serverServiceKey(GIT_SOURCE_CONTROL_ACCOUNTS));
          const actor = requestGitActor(request);
          const auth = accounts
            ? await accounts.actorTransportAuth({ actor, space: request.space, remoteUrl: await gitRemoteUrl(root, String(input.remote)), projectId })
            : null;
          return withGitTransportAuth(auth, () => pushRepoStackBranch(git, root, { branch: entry.branch, remote: String(input.remote), expectedRemoteSha: String(input.expectedRemoteSha), expectedLocalSha: String(input.expectedLocalSha) }), { hostCredentials: actor.ambient });
        });
        request.json(200, result);
        return true;
      }

      // Enrich the existing diff contract with a SHA-256 identity of the exact
      // displayed snapshot. Old callers ignore the additive field.
      if (request.path === "/api/git/diff" && request.method === "GET") {
        const query = (name: string) => request.url.searchParams.get(name);
        const root = await rootOf(query("projectId"), query("sessionId"), query("repositoryId"));
        const result = await git.diff(root, {
          ...(query("path") ? { path: assertGitRelativePath(query("path")!) } : {}),
          staged: query("staged") === "true",
          ignoreWhitespace: query("ignoreWhitespace") === "true",
        });
        request.json(200, { ...result, snapshotDigest: gitDiffSnapshotDigest(result.diff) });
        return true;
      }

      const hunkMatch = /^\/api\/git\/hunk\/(stage|unstage|discard)$/.exec(request.path);
      if (hunkMatch && request.method === "POST") {
        const operation = hunkMatch[1] as GitHunkOperation;
        const input = await request.body();
        const projectId = String(input.projectId ?? "").trim();
        const sessionId = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : undefined;
        const repositoryId = typeof input.repositoryId === "string" && input.repositoryId ? input.repositoryId : undefined;
        const path = assertGitRelativePath(String(input.path ?? ""));
        const expectedStaged = input.expectedStaged === true;
        if (expectedStaged !== (operation === "unstage")) {
          throw Object.assign(new Error("the reviewed staged/unstaged state changed; refresh the diff"), { code: "stale-hunk" });
        }
        const root = await rootOf(projectId, sessionId, repositoryId);
        await mutateGitHunk(git, root, operation, {
          path,
          hunkIndex: Number(input.hunkIndex),
          hunkDigest: String(input.hunkDigest ?? ""),
          expectedSnapshotDigest: String(input.expectedSnapshotDigest ?? ""),
          ...(input.ignoreWhitespace === true ? { ignoreWhitespace: true } : {}),
        });
        request.json(200, { ok: true });
        return true;
      }

      if (request.path === "/api/git/remotes" && request.method === "GET") {
        const projectId = request.url.searchParams.get("projectId");
        if (!projectId) {
          throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
        }
        const project = await host.projects.get(projectId);
        if (!project) {
          throw Object.assign(new Error("unknown project"), { code: "not-found" });
        }
        const root = await rootOf(
          projectId,
          request.url.searchParams.get("sessionId"),
          request.url.searchParams.get("repositoryId"),
        );
        if (!(await git.isRepo(root))) {
          request.json(200, { remotes: [], rejected: [] });
          return true;
        }
        request.json(200, await inspectGitSourceControlRemotes(root));
        return true;
      }
      return baseRoutes ? baseRoutes(request) : false;
    },
  };
}
