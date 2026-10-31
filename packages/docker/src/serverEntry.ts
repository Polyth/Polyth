import type { RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { createProjectToolRunner, resolveProjectToolScope, toolError, type ToolRun } from "@polyth/terminal/project-tools";
import { dockerCommand, dockerSnapshot } from "./service.ts";
import type { DockerAction } from "./types.ts";

export function dockerRoutes(host: ServerPackageHost, run: ToolRun): RouteHandler {
  return async (rc) => {
    if (rc.path === "/api/docker/workspace" && rc.method === "GET") {
      const scope = await resolveProjectToolScope(host, rc.space, {
        projectId: rc.url.searchParams.get("projectId") ?? "",
        sessionId: rc.url.searchParams.get("sessionId"), repositoryId: rc.url.searchParams.get("repositoryId"),
      });
      rc.json(200, await dockerSnapshot(scope, run, rc.url.searchParams.get("file") ?? undefined));
      return true;
    }
    if (rc.path === "/api/docker/command" && rc.method === "POST") {
      const input = await rc.body();
      if (typeof input.projectId !== "string" || typeof input.file !== "string" || typeof input.action !== "string"
        || (input.sessionId != null && typeof input.sessionId !== "string") || (input.repositoryId != null && typeof input.repositoryId !== "string")) throw toolError("invalid-input", "Choose a workspace, configuration and action.");
      const scope = await resolveProjectToolScope(host, rc.space, input as never);
      rc.json(200, await dockerCommand(scope, { action: input.action as DockerAction, file: input.file }));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const runner = createProjectToolRunner();
  return { remoteAccess: localOnlyRemoteAccess(["docker"]), routes: dockerRoutes(host, runner.run), onEnable: runner.enable, onDisable: runner.stop, stopIngress: runner.stop };
}
