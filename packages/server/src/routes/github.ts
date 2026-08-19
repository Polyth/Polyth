// HTTP face of the GitHub plugin. Read-only over the gh CLI; every response
// carries ok/reason so a missing binary or auth renders as an honest empty
// state instead of a 500.
import type { ProjectService } from "@polyth/contracts";
import type { GithubService } from "@polyth/github";
import type { RouteHandler } from "../http.ts";

export function githubRoutes(deps: { projects: ProjectService; github: GithubService }): RouteHandler {
  const rootOf = async (projectId: string | null): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };

  return async ({ path, method, url, json }) => {
    if (!path.startsWith("/api/github")) return false;
    if (method !== "GET") return false;
    const root = await rootOf(url.searchParams.get("projectId"));
    const limit = Number(url.searchParams.get("limit") ?? 30);

    if (path === "/api/github/status") {
      json(200, await deps.github.status(root));
      return true;
    }
    if (path === "/api/github/repo") {
      json(200, await deps.github.repo(root));
      return true;
    }
    if (path === "/api/github/issues") {
      json(200, await deps.github.issues(root, limit));
      return true;
    }
    if (path === "/api/github/prs") {
      json(200, await deps.github.prs(root, limit));
      return true;
    }
    return false;
  };
}
