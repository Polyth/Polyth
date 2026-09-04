import type { ProjectService, RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCommandService, type CommandService, type SkillScope, type WriteScope } from "./index.ts";

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
    if (path !== "/api/commands" && path !== "/api/snippets" && path !== "/api/skills") return false;
    if (method === "GET") {
      const root = await rootOf(url.searchParams.get("projectId"));
      if (path === "/api/skills") {
        json(200, await deps.commands.listSkills(root));
        return true;
      }
      const list = await deps.commands.list(root);
      json(200, path === "/api/commands" ? list.commands : list.snippets);
      return true;
    }
    if (method !== "POST" && method !== "DELETE") return false;
    const input = await body();
    const root = await rootOf(input.projectId);
    const scope = scopeOf(input.scope);
    if (path === "/api/skills" && method === "POST") {
      await deps.commands.saveSkill(root, String(input.scope) as SkillScope, {
        name: String(input.name ?? ""),
        description: String(input.description ?? ""),
        instructions: String(input.instructions ?? ""),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/skills" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeSkill(root, String(input.scope) as SkillScope, String(input.name ?? "")) });
      return true;
    }
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
  // The expansion service is shared with the session service (slash-command
  // rewriting before the model sees the text), so it is published at load time.
  const commands = createCommandService();
  host.services.provide(serverServiceKey<CommandService>("commands"), commands);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["commands"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= snippetRoutes({
        projects: host.projects,
        commands,
      });
    },
  };
}
