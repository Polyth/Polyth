// HTTP face of the files + commands plugins (PLAN §12). Both services are
// project-root oriented; this adapter resolves projectId -> root and nothing else.
import type { ProjectService } from "@polyth/contracts";
import type { FileService } from "@polyth/files";
import type { CommandService } from "@polyth/commands";
import type { RouteHandler } from "../http.ts";

export function workspaceRoutes(deps: {
  projects: ProjectService;
  files: FileService;
  commands: CommandService;
}): RouteHandler {
  const rootOf = async (projectId: string | null): Promise<string> => {
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
  };

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/files") && !path.startsWith("/api/commands") && !path.startsWith("/api/snippets")) {
      return false;
    }
    const q = (k: string) => url.searchParams.get(k);

    if (path === "/api/files/tree" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await deps.files.tree(root, {
        ...(q("path") ? { path: q("path")! } : {}),
        hidden: q("hidden") === "true",
      }));
      return true;
    }
    if (path === "/api/files/read" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await deps.files.read(root, q("path") ?? ""));
      return true;
    }
    if (path === "/api/files/write" && method === "POST") {
      const b = await body();
      const root = await rootOf(String(b.projectId ?? ""));
      await deps.files.write(root, String(b.path ?? ""), String(b.content ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/mkdir" && method === "POST") {
      const b = await body();
      const root = await rootOf(String(b.projectId ?? ""));
      await deps.files.mkdir(root, String(b.path ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/delete" && method === "POST") {
      const b = await body();
      const root = await rootOf(String(b.projectId ?? ""));
      await deps.files.remove(root, String(b.path ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/rename" && method === "POST") {
      const b = await body();
      const root = await rootOf(String(b.projectId ?? ""));
      await deps.files.rename(root, String(b.from ?? ""), String(b.to ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/search" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await deps.files.search(root, q("q") ?? "", Number(q("limit") ?? 50)));
      return true;
    }
    if ((path === "/api/commands" || path === "/api/snippets") && method === "GET") {
      const root = await rootOf(q("projectId"));
      const list = await deps.commands.list(root);
      json(200, path === "/api/commands" ? list.commands : list.snippets);
      return true;
    }
    return false;
  };
}
