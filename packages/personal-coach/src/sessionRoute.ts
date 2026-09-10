import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { packageWorkspace, type ServerPackageHost } from "@polyth/plugins";
import type { CoachStore } from "./index.ts";
import { buildCoachContext } from "./context.ts";
import type { PersonalCoachService } from "./service.ts";
import { createCoachSessionFlow } from "./sessionFlow.ts";

export interface CoachSessionDeps {
  coach: PersonalCoachService;
  ensureCapabilities(
    space: Pick<SpaceContext, "spaceId">,
    projectId: string,
    store: CoachStore,
  ): void | Promise<void>;
}

export function personalCoachSessionRoute(
  host: Pick<ServerPackageHost,
    "pluginId" | "projects" | "spaceStorage" | "forSpace" | "events">,
  deps: CoachSessionDeps,
): RouteHandler {
  const launch = createCoachSessionFlow({
    workspace: (space) => packageWorkspace(host, space),
    store: (space) => deps.coach.forSpace(space),
    sessions: (space) => host.forSpace(space).sessions,
    prepare: deps.ensureCapabilities,
    context: async (sessionId, store) => {
      await host.events.append(sessionId, "package/context", {
        packageId: host.pluginId,
        title: "Personal Coach state",
        text: buildCoachContext(store),
      }, { producerPlugin: host.pluginId });
    },
  });
  return async (request) => {
    if (request.path !== "/api/personal-coach/session" || request.method !== "POST") return false;
    request.json(200, await launch(request.space, await request.body()));
    return true;
  };
}
