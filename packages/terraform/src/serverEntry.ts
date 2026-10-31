import type { RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { createProjectToolRunner, resolveProjectToolScope, toolError, type ToolRun } from "@polyth/terminal/project-tools";
import { terraformCommand, terraformPlan, terraformSnapshot } from "./service.ts";
import type { TerraformAction } from "./types.ts";

export function terraformRoutes(host: ServerPackageHost, run: ToolRun): RouteHandler {
  return async (rc) => {
    if ((rc.path === "/api/terraform/workspace" || rc.path === "/api/terraform/plan") && rc.method === "GET") {
      const scope = await resolveProjectToolScope(host, rc.space, { projectId: rc.url.searchParams.get("projectId") ?? "", sessionId: rc.url.searchParams.get("sessionId"), repositoryId: rc.url.searchParams.get("repositoryId") });
      rc.json(200, rc.path === "/api/terraform/plan" ? await terraformPlan(scope, rc.url.searchParams.get("file") ?? "", run) : await terraformSnapshot(scope, run));
      return true;
    }
    if (rc.path === "/api/terraform/command" && rc.method === "POST") {
      const input = await rc.body();
      if (typeof input.projectId !== "string" || typeof input.directory !== "string" || typeof input.action !== "string"
        || (input.sessionId != null && typeof input.sessionId !== "string") || (input.repositoryId != null && typeof input.repositoryId !== "string")) throw toolError("invalid-input", "Choose a workspace, configuration and action.");
      const scope = await resolveProjectToolScope(host, rc.space, input as never);
      rc.json(200, await terraformCommand(scope, { directory: input.directory, action: input.action as TerraformAction }));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const runner = createProjectToolRunner();
  return { remoteAccess: localOnlyRemoteAccess(["terraform"]), routes: terraformRoutes(host, runner.run), onEnable: runner.enable, onDisable: runner.stop, stopIngress: runner.stop };
}
