// HTTP face of commands + snippets (Settings > Commands/Snippets CRUD).
// The underlying markdown files live in project (.polyth/) or user
// (~/.config/polyth/).
import type { ProjectService } from "@polyth/contracts";
import type { CommandService, WriteScope } from "@polyth/commands";
import type { RouteHandler } from "../http.ts";

export function snippetRoutes(deps: { projects: ProjectService; commands: CommandService }): RouteHandler {
  const rootOf = async (projectId: unknown): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };
  const scopeOf = (v: unknown): WriteScope => (v === "user" ? "user" : "project");

  return async ({ path, method, url, body, json }) => {
    if (path !== "/api/commands" && path !== "/api/snippets") return false;
    if (method === "GET") {
      const root = await rootOf(url.searchParams.get("projectId"));
      const list = await deps.commands.list(root);
      json(200, path === "/api/commands" ? list.commands : list.snippets);
      return true;
    }
    if (method !== "POST" && method !== "DELETE") return false;
    const b = await body();
    const root = await rootOf(b.projectId);
    const scope = scopeOf(b.scope);

    if (path === "/api/commands" && method === "POST") {
      await deps.commands.saveCommand(root, scope, {
        name: String(b.name ?? ""),
        prompt: String(b.prompt ?? ""),
        ...(b.description ? { description: String(b.description) } : {}),
        ...(b.agent ? { agent: String(b.agent) } : {}),
        ...(b.model ? { model: String(b.model) } : {}),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/commands" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeCommand(root, scope, String(b.name ?? "")) });
      return true;
    }
    if (path === "/api/snippets" && method === "POST") {
      await deps.commands.saveSnippet(root, scope, {
        alias: String(b.alias ?? ""),
        text: String(b.text ?? ""),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/snippets" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeSnippet(root, scope, String(b.alias ?? "")) });
      return true;
    }
    return false;
  };
}
