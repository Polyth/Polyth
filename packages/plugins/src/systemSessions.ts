import type { SessionService, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "./serverPackage.ts";

export const RUNTIME_SYSTEM_PRINCIPAL_ID = "system:polyth-runtime";

const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found" });

async function systemContextForProject(
  host: Pick<ServerPackageHost, "projects" | "deployment">,
  projectId: string,
): Promise<SpaceContext> {
  const project = await host.projects.get(projectId);
  if (!project?.spaceId) throw notFound("project not found");
  // This context is never exposed as request identity. It only selects the
  // already-owned project Space for trusted background work. The scoped server
  // facade re-checks canonical project/session resources before every action.
  return {
    spaceId: project.spaceId,
    spaceSlug: project.spaceId,
    userId: RUNTIME_SYSTEM_PRINCIPAL_ID,
    role: "owner",
    deployment: host.deployment,
    storageDir: "",
  };
}

/** Canonical session service for trusted background work on one known project. */
export async function systemSessionsForProject(
  host: Pick<ServerPackageHost, "projects" | "deployment" | "forSpace">,
  projectId: string,
): Promise<SessionService> {
  const context = await systemContextForProject(host, projectId);
  return host.forSpace(context).sessions;
}

/** Canonical session service for trusted background work on one durable session. */
export async function systemSessionsForSession(
  host: Pick<ServerPackageHost, "projects" | "deployment" | "forSpace" | "store">,
  sessionId: string,
): Promise<SessionService> {
  const projection = await host.store.projection(sessionId);
  if (!projection) throw notFound("session not found");
  return systemSessionsForProject(host, projection.projectId);
}
