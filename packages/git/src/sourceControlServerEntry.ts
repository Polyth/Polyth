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
import registerGitPackage, { GIT_REMOTE_ACCESS } from "./serverEntry.ts";
import { inspectGitSourceControlRemotes } from "./sourceControlRemotes.ts";

export const GIT_SOURCE_CONTROL_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [...GIT_REMOTE_ACCESS.routeScopes],
  http: [
    ...GIT_REMOTE_ACCESS.http,
    { methods: ["GET"], path: "/api/git/remotes", capability: REMOTE_CAPABILITY.gitRead, mutation: false },
  ],
};

/**
 * Thin additive entry point around the established Git server package. Keeping
 * the remote endpoint here makes repository hosting identity available to the
 * generic source-control runtime without coupling Git UI to GitHub or GitLab.
 */
export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const base = registerGitPackage(host);
  const baseRoutes = base.routes;

  return {
    ...base,
    remoteAccess: GIT_SOURCE_CONTROL_REMOTE_ACCESS,
    routes: async (request) => {
      if (request.path === "/api/git/remotes" && request.method === "GET") {
        const projectId = request.url.searchParams.get("projectId");
        if (!projectId) {
          throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
        }
        const project = await host.projects.get(projectId);
        if (!project) {
          throw Object.assign(new Error("unknown project"), { code: "not-found" });
        }
        const git = host.services.require<GitService>(serverServiceKey("git"));
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
