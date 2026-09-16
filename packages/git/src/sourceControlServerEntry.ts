import {
  REMOTE_CAPABILITY,
  type RemoteAccessPolicy,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { GitService } from "./index.ts";
import registerGitPackage, { assertGitRelativePath, GIT_REMOTE_ACCESS } from "./serverEntry.ts";
import { gitDiffSnapshotDigest, mutateGitHunk, type GitHunkOperation } from "./hunkMutation.ts";
import { inspectGitSourceControlRemotes } from "./sourceControlRemotes.ts";

const HUNK_HTTP: RemoteAccessPolicy["http"] = [
  { methods: ["POST"], path: "/api/git/hunk/stage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
  { methods: ["POST"], path: "/api/git/hunk/unstage", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
  { methods: ["POST"], path: "/api/git/hunk/discard", capability: REMOTE_CAPABILITY.gitWrite, mutation: true },
];

export const GIT_SOURCE_CONTROL_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [...GIT_REMOTE_ACCESS.routeScopes],
  http: [
    ...GIT_REMOTE_ACCESS.http,
    { methods: ["GET"], path: "/api/git/remotes", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
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

  const rootOf = async (projectId: string | null, sessionId?: string | null): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await host.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    if (!sessionId) return project.path;
    const session = await host.sessions.snapshot(sessionId);
    if (session.projectId !== projectId) {
      throw Object.assign(new Error("session does not belong to this project"), { code: "invalid-input" });
    }
    if (session.worktreeState === "missing") {
      throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
    }
    return session.worktreePath ?? project.path;
  };

  return {
    ...base,
    remoteAccess: GIT_SOURCE_CONTROL_REMOTE_ACCESS,
    routes: async (request) => {
      const git = host.services.require<GitService>(serverServiceKey("git"));

      // Enrich the existing diff contract with a SHA-256 identity of the exact
      // displayed snapshot. Old callers ignore the additive field.
      if (request.path === "/api/git/diff" && request.method === "GET") {
        const query = (name: string) => request.url.searchParams.get(name);
        const root = await rootOf(query("projectId"), query("sessionId"));
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
        const path = assertGitRelativePath(String(input.path ?? ""));
        const expectedStaged = input.expectedStaged === true;
        if (expectedStaged !== (operation === "unstage")) {
          throw Object.assign(new Error("the reviewed staged/unstaged state changed; refresh the diff"), { code: "stale-hunk" });
        }
        const root = await rootOf(projectId, sessionId);
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
        if (!(await git.isRepo(project.path))) {
          request.json(200, { remotes: [], rejected: [] });
          return true;
        }
        request.json(200, await inspectGitSourceControlRemotes(project.path));
        return true;
      }
      return baseRoutes ? baseRoutes(request) : false;
    },
  };
}
