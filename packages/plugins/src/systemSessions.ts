import type { JsonObject, SessionEvent, SessionService, SpaceContext } from "@polyth/contracts";
import type { AppendEventOptions, ServerPackageHost } from "./serverPackage.ts";

export const RUNTIME_SYSTEM_PRINCIPAL_ID = "system:polyth-runtime";

const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found" });
const requireGlobalBackgroundAuthority = (deployment: ServerPackageHost["deployment"]): void => {
  if (deployment !== "local-trusted") {
    throw Object.assign(
      new Error("shared deployments require an explicit Space context for background session work"),
      { code: "unavailable" },
    );
  }
};

async function systemContextForProject(
  host: Pick<ServerPackageHost, "projects" | "deployment" | "systemSpaceContext">,
  projectId: string,
): Promise<SpaceContext> {
  requireGlobalBackgroundAuthority(host.deployment);
  const project = await host.projects.get(projectId);
  if (!project?.spaceId) throw notFound("project not found");
  const context = host.systemSpaceContext(project.spaceId);
  if (context.spaceId !== project.spaceId
    || context.userId !== RUNTIME_SYSTEM_PRINCIPAL_ID
    || !context.storageDir) {
    throw Object.assign(new Error("canonical system Space context is unavailable"), { code: "unavailable" });
  }
  return context;
}

/** Canonical session service for trusted local background work on one known project. */
export async function systemSessionsForProject(
  host: Pick<ServerPackageHost, "projects" | "deployment" | "forSpace" | "systemSpaceContext">,
  projectId: string,
): Promise<SessionService> {
  const context = await systemContextForProject(host, projectId);
  return host.forSpace(context).sessions;
}

/** Canonical session service for trusted local background work on one durable session. */
export async function systemSessionsForSession(
  host: Pick<ServerPackageHost, "projects" | "deployment" | "forSpace" | "store" | "systemSpaceContext">,
  sessionId: string,
): Promise<SessionService> {
  requireGlobalBackgroundAuthority(host.deployment);
  const projection = await host.store.projection(sessionId);
  if (!projection) throw notFound("session not found");
  return systemSessionsForProject(host, projection.projectId);
}

/** Persist a background-owned event only after canonical session admission. */
export async function systemAppendSessionEvent(
  host: Pick<ServerPackageHost, "projects" | "deployment" | "forSpace" | "store" | "events" | "systemSpaceContext">,
  sessionId: string,
  type: string,
  data: JsonObject,
  opts?: AppendEventOptions,
): Promise<SessionEvent> {
  const sessions = await systemSessionsForSession(host, sessionId);
  const projection = await sessions.snapshot(sessionId);
  if (projection.status === "archived") {
    throw Object.assign(new Error("target session is archived"), { code: "conflict" });
  }
  return host.events.append(sessionId, type, data, opts);
}
