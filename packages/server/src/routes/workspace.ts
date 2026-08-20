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

  return async ({ path, method, url, body, json, res }) => {
    if (!path.startsWith("/api/files") && !path.startsWith("/api/commands") && !path.startsWith("/api/snippets")) {
      return false;
    }
    const q = (k: string) => url.searchParams.get(k);

    if (path === "/api/files/stat" && method === "GET") {
      const root = await rootOf(q("projectId"));
      json(200, await deps.files.stat(root, q("path") ?? ""));
      return true;
    }
    if (path === "/api/files/raw" && method === "GET") {
      const root = await rootOf(q("projectId"));
      const raw = await deps.files.readRaw(root, q("path") ?? "");
      // Never let served bytes become an executable document: nosniff + a
      // whitelisted content type (html/svg/js are mapped to octet-stream) and
      // attachment disposition for anything that is not an image or pdf.
      const inline = raw.mime.startsWith("image/") || raw.mime === "application/pdf" || raw.mime === "text/plain";
      res.writeHead(200, {
        "content-type": raw.mime,
        "content-length": String(raw.size),
        "x-content-type-options": "nosniff",
        "content-disposition": inline ? "inline" : "attachment",
        "cache-control": "no-cache",
      });
      res.end(Buffer.from(raw.data));
      return true;
    }
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
      const result = await deps.files.write(root, String(b.path ?? ""), String(b.content ?? ""), {
        ...(typeof b.baseRevision === "string" ? { baseRevision: b.baseRevision } : {}),
      });
      json(200, { ok: true, revision: result.revision });
      return true;
    }
    if (path === "/api/files/upload" && method === "POST") {
      const b = await body();
      const root = await rootOf(String(b.projectId ?? ""));
      await deps.files.writeBytes(root, String(b.path ?? ""), Buffer.from(String(b.base64 ?? ""), "base64"));
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
      // Scored objects (WP13); clients still accepting plain strings read .path.
      json(200, await deps.files.searchScored(root, q("q") ?? "", {
        limit: Number(q("limit") ?? 50),
        includeDirs: q("includeDirs") === "true",
      }));
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
