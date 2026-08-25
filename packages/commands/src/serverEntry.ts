import type { ProjectService, RouteHandler } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { CommandService, WriteScope } from "./index.ts";

export function snippetRoutes(deps: {
  projects: ProjectService;
  commands: CommandService;
}): RouteHandler {
  const rootOf = async (projectId: unknown): Promise<string> => {
    if (!projectId) {
      throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    }
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };
  const scopeOf = (value: unknown): WriteScope =>
    value === "user" ? "user" : "project";

  return async ({ path, method, url, body, json }) => {
    if (path !== "/api/commands" && path !== "/api/snippets") return false;
    if (method === "GET") {
      const root = await rootOf(url.searchParams.get("projectId"));
      const list = await deps.commands.list(root);
      json(200, path === "/api/commands" ? list.commands : list.snippets);
      return true;
    }
    if (method !== "POST" && method !== "DELETE") return false;
    const input = await body();
    const root = await rootOf(input.projectId);
    const scope = scopeOf(input.scope);
    if (path === "/api/commands" && method === "POST") {
      await deps.commands.saveCommand(root, scope, {
        name: String(input.name ?? ""),
        prompt: String(input.prompt ?? ""),
        ...(input.description ? { description: String(input.description) } : {}),
        ...(input.agent ? { agent: String(input.agent) } : {}),
        ...(input.model ? { model: String(input.model) } : {}),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/commands" && method === "DELETE") {
      json(200, {
        ok: await deps.commands.removeCommand(root, scope, String(input.name ?? "")),
      });
      return true;
    }
    if (path === "/api/snippets" && method === "POST") {
      await deps.commands.saveSnippet(root, scope, {
        alias: String(input.alias ?? ""),
        text: String(input.text ?? ""),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/snippets" && method === "DELETE") {
      json(200, {
        ok: await deps.commands.removeSnippet(root, scope, String(input.alias ?? "")),
      });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= snippetRoutes({
        projects: host.projects,
        commands: host.services.require(
          serverServiceKey<CommandService>("commands"),
        ),
      });
    },
  };
}
