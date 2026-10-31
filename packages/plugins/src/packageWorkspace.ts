import { join, resolve } from "node:path";
import type { Project, ProjectService, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "./serverPackage.ts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID } from "./systemSessions.ts";

export interface PackageWorkspace {
  projectId: string;
  cwd: string;
}

interface PackageWorkspaceProjectService extends ProjectService {
  ensurePackageWorkspace(input: {
    spaceId: string;
    packageId: string;
    path: string;
  }): Promise<Project>;
}

type PackageWorkspaceHost = Pick<ServerPackageHost, "pluginId" | "projects" | "spaceStorage">
  & Partial<Pick<ServerPackageHost, "forSpace">>;

/**
 * Resolve the calling package's private runtime anchor in the supplied,
 * gateway-validated Space. The package id and path come from the host, never
 * from request/model input, so one package cannot choose another namespace.
 *
 * Canonical hosts then re-open the anchor through a system-scoped project
 * facade. That materializes/verifies the control-plane resource before any
 * session can use this hidden project as its parent. Lightweight legacy/test
 * hosts without `forSpace` retain the historical registry-only behavior.
 */
export async function packageWorkspace(
  host: PackageWorkspaceHost,
  space: SpaceContext,
): Promise<PackageWorkspace> {
  const projects = host.projects as PackageWorkspaceProjectService;
  if (typeof projects.ensurePackageWorkspace !== "function") {
    throw Object.assign(new Error("package workspaces are unavailable on this host"), {
      code: "unavailable",
    });
  }
  const cwd = resolve(join(host.spaceStorage(space).packageDir(host.pluginId), "workspace"));
  const project = await projects.ensurePackageWorkspace({
    spaceId: space.spaceId,
    packageId: host.pluginId,
    path: cwd,
  });
  if (project.spaceId !== space.spaceId || resolve(project.path) !== cwd) {
    throw Object.assign(new Error("package workspace ownership mismatch"), {
      code: "forbidden",
    });
  }

  if (typeof host.forSpace === "function") {
    const governed = await host.forSpace({
      ...space,
      userId: RUNTIME_SYSTEM_PRINCIPAL_ID,
      role: "owner",
    }).projects.get(project.id);
    if (!governed || governed.id !== project.id || governed.spaceId !== space.spaceId
      || resolve(governed.path) !== cwd) {
      throw Object.assign(new Error("package workspace canonical ownership mismatch"), {
        code: "recovery-required",
      });
    }
    return { projectId: governed.id, cwd: governed.path };
  }

  return { projectId: project.id, cwd: project.path };
}
