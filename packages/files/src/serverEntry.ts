import path from "node:path";
import type { ProjectService, RemoteAccessPolicy, RemoteHost, RouteHandler, SessionService } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createFileService, MAX_RAW_BYTES, type FileService } from "./index.ts";
import { createRemoteFileService } from "./remote.ts";

/** `_inbox/` is an explicit project-root staging area for freshly attached
 *  files: uploads land here before any session/worktree owns the message. */
export const INBOX_PREFIX = "_inbox/";

/** Attachment preparation seam consumed by the session service (F2).
 *  Published so the composition root never imports this package. */
export interface AttachmentSourceService {
  maxBytes: number;
  /** Stat a project file (ordinary attachment) against an execution root. */
  stat(root: string, rel: string): Promise<{ kind: "file" | "dir"; size: number }>;
  /** Ensure a staged `_inbox/*` file exists at execRoot. Copies from
   *  projectRoot when execRoot differs (linked worktree, remote host).
   *  Returns the final stat. */
  materialize(input: {
    projectId: string;
    projectRoot: string;
    execRoot: string;
    rel: string;
  }): Promise<{ kind: "file"; size: number }>;
}

interface SshTransportService {
  host(connectionId: string): RemoteHost;
}

/** Remote projects read/write through the SSH transport; everything else
 *  stays on the local filesystem implementation. Shared by the route handler
 *  and the published attachment seam so both pick the same backing store. */
function makeFilesFor(deps: {
  projects: ProjectService;
  files: FileService;
  ssh?: SshTransportService;
}): (projectId: string | null) => Promise<FileService> {
  return async (projectId) => {
    if (!deps.ssh || !projectId) return deps.files;
    const project = await deps.projects.get(projectId);
    if (project?.remote?.kind !== "ssh") return deps.files;
    return createRemoteFileService(deps.ssh.host(project.remote.connectionId));
  };
}

/** Build the published attachment preparation seam. `filesFor` selects the
 *  local or remote FileService per project so `_inbox/*` materialization
 *  reads and writes through the same store the routes use. */
export function createAttachmentSourceService(
  filesFor: (projectId: string | null) => Promise<FileService>,
): AttachmentSourceService {
  return {
    maxBytes: MAX_RAW_BYTES,
    stat: async (root, rel) => {
      const fs = await filesFor(null);
      const st = await fs.stat(root, rel);
      return { kind: st.kind, size: st.size };
    },
    materialize: async ({ projectId, projectRoot, execRoot, rel }) => {
      const fs = await filesFor(projectId);
      if (path.resolve(execRoot) === path.resolve(projectRoot)) {
        // Main workspace: the staged file already sits at the execution root.
        const st = await fs.stat(projectRoot, rel);
        if (st.kind !== "file") {
          throw Object.assign(new Error("staged attachment is not a file"), {
            code: "invalid-input",
          });
        }
        return { kind: "file", size: st.size };
      }
      // Linked worktree or remote host: copy the staged bytes into the
      // execution root so downstream worktree-relative resolution just works.
      // `readRaw` enforces MAX_RAW_BYTES.
      const raw = await fs.readRaw(projectRoot, rel);
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (dir) await fs.mkdir(execRoot, dir);
      await fs.writeBytes(execRoot, rel, raw.data);
      const st = await fs.stat(execRoot, rel);
      return { kind: "file", size: st.size };
    },
  };
}

export function workspaceRoutes(deps: {
  projects: ProjectService;
  files: FileService;
  sessions: SessionService;
  ssh?: SshTransportService;
}): RouteHandler {
  const filesFor = makeFilesFor(deps);

  const projectRootOf = async (projectId: string | null): Promise<string> => {
    if (!projectId) {
      throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    }
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    return project.path;
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

  /** `_inbox/*` staging is project-root-scoped: it must have one stable home
   *  regardless of which session/worktree ends up owning the message, so the
   *  pill's later stat + raw URL keep resolving. Every other path stays
   *  worktree-aware. Path-jail checks are unchanged (FileService enforces). */
  const rootFor = (
    projectId: string | null,
    sessionId: string | null | undefined,
    relPath: string,
  ): Promise<string> =>
    relPath.startsWith(INBOX_PREFIX)
      ? projectRootOf(projectId)
      : rootOf(projectId, sessionId);

  return async ({ path, method, url, body, json, res }) => {
    if (!path.startsWith("/api/files")) return false;
    const query = (key: string) => url.searchParams.get(key);
    const rootOfQuery = () => rootOf(query("projectId"), query("sessionId"));
    const rootOfBody = (input: Record<string, unknown>) =>
      rootOf(
        String(input.projectId ?? ""),
        input.sessionId ? String(input.sessionId) : undefined,
      );
    const rootForQuery = () =>
      rootFor(query("projectId"), query("sessionId"), query("path") ?? "");
    const rootForBody = (input: Record<string, unknown>) =>
      rootFor(
        String(input.projectId ?? ""),
        input.sessionId ? String(input.sessionId) : undefined,
        String(input.path ?? ""),
      );
    if (path === "/api/files/stat" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      json(200, await fs.stat(await rootForQuery(), query("path") ?? ""));
      return true;
    }
    if (path === "/api/files/raw" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      const raw = await fs.readRaw(await rootForQuery(), query("path") ?? "");
      const inline = raw.mime.startsWith("image/")
        || raw.mime.startsWith("audio/")
        || raw.mime.startsWith("video/")
        || raw.mime === "application/pdf"
        || raw.mime.startsWith("text/")
        || raw.mime === "application/json"
        || raw.mime === "application/javascript"
        || raw.mime === "application/xml"
        || raw.mime === "application/octet-stream";
      res.writeHead(200, {
        "content-type": raw.mime,
        "content-length": String(raw.size),
        "x-content-type-options": "nosniff",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(query("path")?.split(/[\\/]/).pop() ?? "file")}`,
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
        await rootForBody(input),
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
      // `_inbox/*` cleanup must target the same project-root home the upload used.
      await fs.remove(await rootForBody(input), String(input.path ?? ""));
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

export const FILES_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["files"],
  http: [
    { methods: ["GET"], path: "/api/files/stat", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/raw", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/tree", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/read", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/search", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["POST"], path: "/api/files/write", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/upload", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/mkdir", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/delete", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/rename", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const files = createFileService();
  host.services.provide(serverServiceKey<FileService>("files"), files);
  /** SSH transport binds late; resolve it per call so `materialize` reads and
   *  writes a remote project through the same remote FileService the routes use. */
  const attachmentFilesFor = (projectId: string | null): Promise<FileService> => {
    const ssh = host.services.get(serverServiceKey<SshTransportService>("ssh")) ?? undefined;
    return makeFilesFor({ projects: host.projects, files, ...(ssh ? { ssh } : {}) })(projectId);
  };
  host.services.provide(
    serverServiceKey<AttachmentSourceService>("files.attachments"),
    createAttachmentSourceService(attachmentFilesFor),
  );
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: FILES_REMOTE_ACCESS,
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
