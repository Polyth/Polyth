import type { ProjectService, RouteHandler, SessionService } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { FileService } from "./index.ts";

export function workspaceRoutes(deps: {
  projects: ProjectService;
  files: FileService;
  sessions: SessionService;
}): RouteHandler {
  const rootOf = async (
    projectId: string | null,
    sessionId?: string | null,
  ): Promise<string> => {
    if (!projectId) {
      throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    }
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    if (!sessionId) return project.path;
    const session = await deps.sessions.snapshot(sessionId);
    if (session.projectId !== projectId) {
      throw Object.assign(new Error("session does not belong to this project"), {
        code: "invalid-input",
      });
    }
    if (session.worktreeState === "missing") {
      throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
    }
    return session.worktreePath ?? project.path;
  };

  return async ({ path, method, url, body, json, res }) => {
    if (!path.startsWith("/api/files")) return false;
    const query = (key: string) => url.searchParams.get(key);
    const rootOfQuery = () => rootOf(query("projectId"), query("sessionId"));
    const rootOfBody = (input: Record<string, unknown>) =>
      rootOf(
        String(input.projectId ?? ""),
        input.sessionId ? String(input.sessionId) : undefined,
      );
    if (path === "/api/files/stat" && method === "GET") {
      json(200, await deps.files.stat(await rootOfQuery(), query("path") ?? ""));
      return true;
    }
    if (path === "/api/files/raw" && method === "GET") {
      const raw = await deps.files.readRaw(await rootOfQuery(), query("path") ?? "");
      const inline = raw.mime.startsWith("image/")
        || raw.mime === "application/pdf"
        || raw.mime === "text/plain";
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
      json(200, await deps.files.tree(await rootOfQuery(), {
        ...(query("path") ? { path: query("path")! } : {}),
        hidden: query("hidden") === "true",
      }));
      return true;
    }
    if (path === "/api/files/read" && method === "GET") {
      json(200, await deps.files.read(await rootOfQuery(), query("path") ?? ""));
      return true;
    }
    if (path === "/api/files/write" && method === "POST") {
      const input = await body();
      const result = await deps.files.write(
        await rootOfBody(input),
        String(input.path ?? ""),
        String(input.content ?? ""),
        {
          ...(typeof input.baseRevision === "string"
            ? { baseRevision: input.baseRevision }
            : {}),
        },
      );
      json(200, { ok: true, revision: result.revision });
      return true;
    }
    if (path === "/api/files/upload" && method === "POST") {
      const input = await body();
      await deps.files.writeBytes(
        await rootOfBody(input),
        String(input.path ?? ""),
        Buffer.from(String(input.base64 ?? ""), "base64"),
      );
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/mkdir" && method === "POST") {
      const input = await body();
      await deps.files.mkdir(await rootOfBody(input), String(input.path ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/delete" && method === "POST") {
      const input = await body();
      await deps.files.remove(await rootOfBody(input), String(input.path ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/rename" && method === "POST") {
      const input = await body();
      await deps.files.rename(
        await rootOfBody(input),
        String(input.from ?? ""),
        String(input.to ?? ""),
      );
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/search" && method === "GET") {
      json(200, await deps.files.searchScored(
        await rootOfQuery(),
        query("q") ?? "",
        {
          limit: Number(query("limit") ?? 50),
          includeDirs: query("includeDirs") === "true",
        },
      ));
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
      routes ??= workspaceRoutes({
        projects: host.projects,
        sessions: host.sessions,
        files: host.services.require(serverServiceKey<FileService>("files")),
      });
    },
  };
}
