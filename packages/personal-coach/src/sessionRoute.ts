import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { packageWorkspace, type ServerPackageHost } from "@polyth/plugins";
import type { CoachStore } from "./index.ts";
import { buildCoachContext } from "./context.ts";
import type { PersonalCoachService } from "./service.ts";

const sessionTitle = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "Coach · Today";
  if (typeof value !== "string") {
    throw Object.assign(new Error("title must be text"), { code: "invalid-input" });
  }
  const title = value.trim();
  if (!title || title.length > 120) {
    throw Object.assign(new Error("title required (≤120 chars)"), { code: "invalid-input" });
  }
  return title;
};

export interface CoachSessionDeps {
  coach: PersonalCoachService;
  ensureCapabilities(
    space: Pick<SpaceContext, "spaceId">,
    projectId: string,
    store: CoachStore,
  ): void | Promise<void>;
}

/**
 * Materialize an ordinary Polyth session on the package-owned runtime anchor.
 * The internal project id never crosses the package API boundary.
 */
export function personalCoachSessionRoute(
  host: Pick<ServerPackageHost,
    "pluginId" | "projects" | "spaceStorage" | "forSpace" | "events">,
  deps: CoachSessionDeps,
): RouteHandler {
  return async (request) => {
    if (request.path !== "/api/personal-coach/session" || request.method !== "POST") return false;
    const input = await request.body();
    const workspace = await packageWorkspace(host, request.space);
    const store = deps.coach.forSpace(request.space);

    // Register project-scoped capabilities before SessionService materializes a
    // backend runtime so the first turn sees the same tool/instruction set as
    // later turns.
    await deps.ensureCapabilities(request.space, workspace.projectId, store);

    const scoped = host.forSpace(request.space);
    const session = await scoped.sessions.create({
      projectId: workspace.projectId,
      title: sessionTitle(input.title),
    });
    // package/context is intentionally model-visible: deriveMessages drops
    // ignorable events. Proposal/insight timeline markers stay ignorable, this
    // bounded durable-state snapshot must not.
    await host.events.append(session.id, "package/context", {
      packageId: host.pluginId,
      title: "Personal Coach state",
      text: buildCoachContext(store),
    }, { producerPlugin: host.pluginId });
    request.json(200, { sessionId: session.id });
    return true;
  };
}
