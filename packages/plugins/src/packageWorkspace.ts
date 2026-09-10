import { join, resolve } from "node:path";
import type { Project, ProjectService, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "./serverPackage.ts";

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

/**
 * Resolve the calling package's private runtime anchor in the supplied,
 * gateway-validated Space. The package id and path come from the host, never
 * from request/model input, so one package cannot choose another namespace.
 *
 * This deliberately keeps the existing project-shaped runtime/session
 * contracts intact while hiding the anchor from user-facing project lists.
 */
export async function packageWorkspace(
  host: Pick<ServerPackageHost, "pluginId" | "projects" | "spaceStorage">,
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
  return { projectId: project.id, cwd: project.path };
}
