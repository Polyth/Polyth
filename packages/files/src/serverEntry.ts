import type { ProjectService, RemoteHost, RouteHandler, SessionService } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createFileService, MAX_RAW_BYTES, type FileService } from "./index.ts";
import { createRemoteFileService } from "./remote.ts";

/** Attachment existence/size verification seam consumed by the session
 *  service (F2). Published so the composition root never imports this package. */
export interface AttachmentStatService {
  stat(root: string, rel: string): Promise<{ kind: "file" | "dir"; size: number }>;
  maxBytes: number;
}

interface SshTransportService {
  host(connectionId: string): RemoteHost;
}

export function workspaceRoutes(deps: {
  projects: ProjectService;
  files: FileService;
  sessions: SessionService;
  ssh?: SshTransportService;
}): RouteHandler {
  /** Remote projects read/write through the SSH transport; everything else
   *  stays on the local filesystem implementation. */
  const filesFor = async (projectId: string | null): Promise<FileService> => {
    if (!deps.ssh || !projectId) return deps.files;
    const project = await deps.projects.get(projectId);
    if (project?.remote?.kind !== "ssh") return deps.files;
    return createRemoteFileService(deps.ssh.host(project.remote.connectionId));
  };

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
      const fs = await filesFor(query("projectId"));
      json(200, await fs.stat(await rootOfQuery(), query("path") ?? ""));
      return true;
    }
    if (path === "/api/files/raw" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      const raw = await fs.readRaw(await rootOfQuery(), query("path") ?? "");
      const inline = raw.mime.startsWith("image/")
        || raw.mime.startsWith("audio/")
        || raw.mime.startsWith("video/")
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
      const fs = await filesFor(query("projectId"));
      json(200, await fs.tree(await rootOfQuery(), {
        ...(query("path") ? { path: query("path")! } : {}),
        hidden: query("hidden") === "true",
      }));
      return true;
    }
    if (path === "/api/files/read" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      json(200, await fs.read(await rootOfQuery(), query("path") ?? ""));
      return true;
    }
    if (path === "/api/files/write" && method === "POST") {
      const input = await body();
      const fs = await filesFor(String(input.projectId ?? ""));
      const result = await fs.write(
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
      const fs = await filesFor(String(input.projectId ?? ""));
      await fs.writeBytes(
        await rootOfBody(input),
        String(input.path ?? ""),
        Buffer.from(String(input.base64 ?? ""), "base64"),
      );
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/mkdir" && method === "POST") {
      const input = await body();
      const fs = await filesFor(String(input.projectId ?? ""));
      await fs.mkdir(await rootOfBody(input), String(input.path ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/delete" && method === "POST") {
      const input = await body();
      const fs = await filesFor(String(input.projectId ?? ""));
      await fs.remove(await rootOfBody(input), String(input.path ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/rename" && method === "POST") {
      const input = await body();
      const fs = await filesFor(String(input.projectId ?? ""));
      await fs.rename(
        await rootOfBody(input),
        String(input.from ?? ""),
        String(input.to ?? ""),
      );
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/files/search" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      json(200, await fs.searchScored(
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
  const files = createFileService();
  host.services.provide(serverServiceKey<FileService>("files"), files);
  host.services.provide(
    serverServiceKey<AttachmentStatService>("files.attachments"),
    {
      stat: async (root, rel) => {
        const st = await files.stat(root, rel);
        return { kind: st.kind, size: st.size };
      },
      maxBytes: MAX_RAW_BYTES,
    },
  );
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= workspaceRoutes({
        projects: host.projects,
        sessions: host.sessions,
        files,
        ...(host.services.get(serverServiceKey<SshTransportService>("ssh"))
          ? { ssh: host.services.get(serverServiceKey<SshTransportService>("ssh"))! }
          : {}),
      });
    },
  };
}