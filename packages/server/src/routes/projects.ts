import type { ProjectComposition, ProjectPatch } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

/** Project-owned creation/composition mutation surface.
 *
 * Legacy `/api/projects` creation stays backward-compatible in the gateway.
 * New composition-aware onboarding uses `/api/projects/setup` so creation and
 * the durable composition commit are one server operation rather than a
 * client-side create-then-PATCH sequence.
 */
export function projectRoutes(spaces: SpaceServicesFor): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    const { projects } = spaces(rc.space);

    if (path === "/api/projects/setup" && method === "POST") {
      const input = await body();
      const mode = input.mode;
      if (mode !== "add" && mode !== "create") throw invalid("mode must be add or create");
      if (typeof input.path !== "string" || !input.path.trim()) throw invalid("path is required");
      if (input.name !== undefined && typeof input.name !== "string") throw invalid("name must be text");
      const composition = input.composition as ProjectComposition | undefined;
      const project = mode === "create"
        ? await projects.create(input.path, input.name as string | undefined, composition)
        : await projects.add(input.path, input.name as string | undefined, composition);
      json(200, project);
      return true;
    }

    const match = path.match(/^\/api\/projects\/([^/]+)$/);
    if (!match || method !== "PATCH") return false;
    if (!projects.update) throw Object.assign(new Error("project updates are unavailable"), { code: "not-supported" });
    const patch = await body() as ProjectPatch;
    json(200, await projects.update(decodeURIComponent(match[1]!), patch));
    return true;
  };
}
