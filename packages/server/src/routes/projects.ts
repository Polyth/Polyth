import type { ProjectPatch, ProjectService } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

/** Project metadata stays a contributed route, keeping the HTTP gateway a
 * transport shell while the project feature owns its writes. */
export function projectRoutes(projects: ProjectService): RouteHandler {
  return async ({ path, method, body, json }) => {
    const match = path.match(/^\/api\/projects\/([^/]+)$/);
    if (!match || method !== "PATCH") return false;
    if (!projects.update) throw Object.assign(new Error("project updates are unavailable"), { code: "not-supported" });
    const patch = await body() as ProjectPatch;
    json(200, await projects.update(decodeURIComponent(match[1]!), patch));
    return true;
  };
}
