import type { Project, SessionProjection } from "@polyth/contracts";

export function projectResourceReceipt(project: Pick<Project, "id" | "spaceId" | "path" | "remote">): string {
  return JSON.stringify({
    id: project.id,
    spaceId: project.spaceId ?? null,
    path: project.path,
    remote: project.remote
      ? { kind: project.remote.kind, connectionId: project.remote.connectionId }
      : null,
  });
}

export function sessionResourceReceipt(
  projection: Pick<SessionProjection, "id" | "projectId" | "spaceId" | "parentId">,
): string {
  return JSON.stringify({
    id: projection.id,
    projectId: projection.projectId,
    spaceId: projection.spaceId ?? null,
    parentId: projection.parentId ?? null,
  });
}
