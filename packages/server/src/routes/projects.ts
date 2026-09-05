import type { ProjectPatch } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";

/** Project metadata stays a contributed route, keeping the HTTP gateway a
 * transport shell while the project feature owns its writes. */
export function projectRoutes(spaces: SpaceServicesFor): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    const match = path.match(/^\/api\/projects\/([^/]+)$/);
    if (!match || method !== "PATCH") return false;
    const { projects } = spaces(rc.space);
    if (!projects.update) throw Object.assign(new Error("project updates are unavailable"), { code: "not-supported" });
    const patch = await body() as ProjectPatch;
    json(200, await projects.update(decodeURIComponent(match[1]!), patch));
    return true;
  };
}
