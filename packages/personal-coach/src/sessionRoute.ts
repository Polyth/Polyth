import type { RouteHandler } from "@polyth/contracts";
import { packageWorkspace, type ServerPackageHost } from "@polyth/plugins";

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

/**
 * Materialize an ordinary Polyth session on the package-owned runtime anchor.
 * The internal project id never crosses the package API boundary.
 */
export function personalCoachSessionRoute(
  host: Pick<ServerPackageHost,
    "pluginId" | "projects" | "spaceStorage" | "forSpace" | "events">,
): RouteHandler {
  return async (request) => {
    if (request.path !== "/api/personal-coach/session" || request.method !== "POST") return false;
    const input = await request.body();
    const workspace = await packageWorkspace(host, request.space);
    const scoped = host.forSpace(request.space);
    const session = await scoped.sessions.create({
      projectId: workspace.projectId,
      title: sessionTitle(input.title),
    });
    await host.events.append(session.id, "personal-coach/session-created", {
      packageId: host.pluginId,
    }, { ignorable: true, producerPlugin: host.pluginId });
    request.json(200, { sessionId: session.id });
    return true;
  };
}
