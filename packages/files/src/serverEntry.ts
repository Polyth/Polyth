import path from "node:path";
import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  ProjectService,
  RemoteAccessPolicy,
  RemoteHost,
  RouteHandler,
  SessionEvent,
  SessionService,
} from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { hasInstanceOwnerAuthority, requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type { SessionOutputCache } from "@polyth/session/output-cache";
import { resolveWorkspaceContext, workspaceExecutionPath, workspaceRepository } from "@polyth/contracts/workspace";
import {
  packageDataDir,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createFileService, MAX_RAW_BYTES, type FileService } from "./index.ts";
import { planArchive, writeArchive } from "./archive.ts";
import {
  createExternalReadStore,
  DEFAULT_EXTERNAL_READ_POLICY,
  type ExternalReadPolicy,
  type ExternalReadStore,
} from "./externalReads.ts";
import { createReadFileAgentTool, FILES_PACKAGE_ID } from "./readFileTool.ts";
import { createRemoteFileService } from "./remote.ts";
import { registerFilesHandoffSources } from "./handoffSources.ts";
import { inlineAiRoutes } from "./inlineAiRoutes.ts";
import { SESSION_EDITS_PATH, sessionEditsRoute } from "./sessionEdits.ts";
import {
  createWorkspaceInstructionSource,
  type WorkspaceInstructionSourceService,
} from "./workspaceInstructions.ts";
import {
  dataFileFormat,
  mediaPathsInDataFile,
  MAX_SESSION_DATA_FILE_BYTES,
  preserveSessionMedia,
  referencedSessionMediaPaths,
  type PreserveSessionMediaResult,
} from "./sessionMedia.ts";

/** `_inbox/` is an explicit project-root staging area for freshly attached
 *  files: uploads land here before any session/worktree owns the message. */
export const INBOX_PREFIX = "_inbox/";

/** Attachment preparation seam consumed by the session service.
 *  Published so the composition root never imports this package. */
export interface AttachmentSourceService {
  maxBytes: number;
  /** Stat a project file (ordinary attachment) against an execution root. */
  stat(root: string, rel: string, projectId?: string): Promise<{ kind: "file" | "dir"; size: number }>;
  /** Ensure a staged `_inbox/*` file exists at execRoot. Copies from
   *  projectRoot when execRoot differs (linked worktree, remote host).
   *  Returns the final stat. */
  materialize(input: {
    projectId: string;
    projectRoot: string;
    execRoot: string;
    rel: string;
  }): Promise<{ kind: "file"; size: number }>;
  /** Read an already-prepared attachment through the same guarded store, for
   *  harnesses whose file delivery is emulated as prompt text. */
  read(root: string, rel: string, projectId?: string): Promise<Uint8Array>;
}

/** Session-lifetime chat media seam consumed by the isolation lifecycle. A
 *  chat image is a project-relative path resolved against the session's
 *  *current* execution root; when an isolated session is merged/discarded its
 *  worktree is deleted, so a referenced file that only lived there must be
 *  carried into the destination checkout or the image 404s. Published so the
 *  composition root never imports this package. */
export interface SessionMediaService {
  /** Copy the media paths the canonical history of `sessionIds` references
   *  from `sourceRoot` into `destinationRoot`, without overwriting existing
   *  files. A `from=` data file is read from `sourceRoot` so the images it
   *  renders are preserved too. `ignored` restricts the copy to Git-ignored
   *  paths in the destination. Best effort: a missing or oversized file is
   *  reported, never thrown. */
  preserve(input: {
    sessionIds: readonly string[];
    projectId: string;
    sourceRoot: string;
    destinationRoot: string;
    ignored?(paths: readonly string[]): Promise<readonly string[]>;
  }): Promise<PreserveSessionMediaResult>;
}

interface SshTransportService {
  host(connectionId: string): RemoteHost;
}

/** Remote projects read/write through the SSH transport; everything else
 *  stays on the local filesystem implementation. Shared by the route handler
 *  and the published attachment seam so both pick the same backing store. */
/** One `Range: bytes=…` request against a body of `size` bytes: a closed
 *  span, "unsatisfiable" (416), or null to serve the whole body (no header,
 *  another unit, or several ranges, which a 200 answers correctly). */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function makeFilesFor(deps: {
  projects: ProjectService;
  files: FileService;
  ssh?: SshTransportService;
  externalReads?: () => ExternalReadPolicy;
}): (projectId: string | null) => Promise<FileService> {
  return async (projectId) => {
    if (!deps.ssh || !projectId) return deps.files;
    const project = await deps.projects.get(projectId);
    if (project?.remote?.kind !== "ssh") return deps.files;
    return createRemoteFileService(deps.ssh.host(project.remote.connectionId), deps.externalReads);
  };
}

export const EXTERNAL_READS_PATH = "/api/files/external-reads";

/** GET: the policy, its defaults and whether the caller may change it.
 *  PUT: the instance owner replaces it (Space owners and admins may not:
 *  the folders are on the server's disk, shared by every Space). */
export function externalReadsRoute(store: ExternalReadStore): RouteHandler {
  return async (request) => {
    if (request.path !== EXTERNAL_READS_PATH) return false;
    if (request.method === "GET") {
      request.json(200, { ...store.get(), defaults: DEFAULT_EXTERNAL_READ_POLICY, editable: hasInstanceOwnerAuthority(request) });
      return true;
    }
    if (request.method === "PUT") {
      requireInstanceOwnerAuthority(request, "only the server owner can change which outside files are readable");
      const next = store.set(await request.body());
      request.json(200, { ...next, defaults: DEFAULT_EXTERNAL_READ_POLICY, editable: true });
      return true;
    }
    return false;
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
    stat: async (root, rel, projectId) => {
      const fs = await filesFor(projectId ?? null);
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
    read: async (root, rel, projectId) => {
      const fs = await filesFor(projectId ?? null);
      // `readRaw` applies the same root confinement and MAX_RAW_BYTES cap as
      // every other attachment read.
      return (await fs.readRaw(root, rel)).data;
    },
  };
}

/** Build the session-media preservation seam. Reads one session's canonical
 *  events to learn which media it references, then copies the missing ones
 *  between two checkouts through the same local/remote FileService the routes
 *  use. The released worktree is always local (managed Git checkouts are not
 *  remote), but routing through `filesFor` keeps a remote project coherent. */
export function createSessionMediaService(
  filesFor: (projectId: string | null) => Promise<FileService>,
  readEvents: (sessionId: string) => Promise<SessionEvent[]>,
): SessionMediaService {
  return {
    preserve: async ({ sessionIds, projectId, sourceRoot, destinationRoot, ignored }) => {
      const empty: PreserveSessionMediaResult = { copied: [], skipped: [], missing: [], notIgnored: [] };
      if (path.resolve(sourceRoot) === path.resolve(destinationRoot)) return empty;
      const fs = await filesFor(projectId);
      const events: SessionEvent[] = [];
      for (const sessionId of sessionIds) events.push(...await readEvents(sessionId));
      const paths = referencedSessionMediaPaths(events);
      if (paths.length === 0) return empty;
      // A `from=` data file is rendered as rows, so the images it names live
      // in the chat too. Read it from the released checkout (the only place an
      // ignored data file exists) and add the bounded top-level image fields.
      const seen = new Set(paths);
      for (const rel of [...paths]) {
        const format = dataFileFormat(rel);
        if (!format) continue;
        try {
          const raw = await fs.readRaw(sourceRoot, rel);
          if (raw.data.byteLength > MAX_SESSION_DATA_FILE_BYTES) continue;
          for (const inner of mediaPathsInDataFile(new TextDecoder().decode(raw.data), format)) {
            if (seen.has(inner)) continue;
            seen.add(inner);
            paths.push(inner);
          }
        } catch { /* absent data file: nothing to enumerate */ }
      }
      const exists = async (root: string, rel: string): Promise<boolean> => {
        try {
          return (await fs.stat(root, rel)).kind === "file";
        } catch {
          return false;
        }
      };
      return preserveSessionMedia({
        paths,
        sourceRoot,
        destinationRoot,
        exists,
        read: async (root, rel) => {
          try {
            return (await fs.readRaw(root, rel)).data;
          } catch {
            return null;
          }
        },
        write: async (root, rel, data) => {
          const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
          if (dir) await fs.mkdir(root, dir).catch(() => undefined);
          await fs.writeBytes(root, rel, data);
        },
        ...(ignored ? { ignored } : {}),
      });
    },
  };
}

export function workspaceRoutes(deps: {
  projects: ProjectService;
  files: FileService;
  sessions: SessionService;
  ssh?: SshTransportService;
  externalReads?: () => ExternalReadPolicy;
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
    repositoryId?: string | null,
  ): Promise<string> => {
    if (!projectId) {
      throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    }
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    if (!sessionId && !repositoryId) return project.path;
    const session = sessionId ? await deps.sessions.snapshot(sessionId) : null;
    if (session && session.projectId !== projectId) {
      throw Object.assign(new Error("session does not belong to this project"), {
        code: "invalid-input",
      });
    }
    if (!repositoryId) {
      return session ? workspaceExecutionPath(project, session) : project.path;
    }
    const context = resolveWorkspaceContext(project, session);
    const repository = workspaceRepository(context, repositoryId);
    if (repository.state === "missing") {
      throw Object.assign(new Error("repository checkout is missing"), { code: "not-found" });
    }
    return repository.path;
  };

  /** Legacy `_inbox/*` staging is project-root-scoped: omitted and canonical
   *  primary selectors share one stable home; secondary repositories use their
   *  validated checkout. Path-jail checks are unchanged (FileService
   *  enforces). */
  const rootFor = async (
    projectId: string | null,
    sessionId: string | null | undefined,
    relPath: string,
    repositoryId?: string | null,
  ): Promise<string> => {
    if (!relPath.startsWith(INBOX_PREFIX)) return rootOf(projectId, sessionId, repositoryId);
    // `_inbox/*` has one resource identity (`repositoryId ?? "primary"`) in
    // the editor/pane stores. Keep an explicit canonical primary selection on
    // the same project-root staging area as the omitted selector; otherwise a
    // session worktree would make the same attachment locator resolve to two
    // different files. Secondary repositories retain their own roots.
    const selectedRoot = await rootOf(projectId, sessionId, repositoryId);
    if (!repositoryId) return projectRootOf(projectId);
    const project = await deps.projects.get(projectId ?? "");
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    const projectContext = resolveWorkspaceContext(project, null);
    const primaryId = project.primaryRepositoryId
      ?? projectContext.repositories.find((repository) => repository.path === project.path)?.repositoryId
      ?? (projectContext.repositories.length === 1 ? projectContext.repositories[0]!.repositoryId : undefined);
    return repositoryId === primaryId ? project.path : selectedRoot;
  };

  return async ({ path, method, url, body, json, req, res }) => {
    if (!path.startsWith("/api/files")) return false;
    const query = (key: string) => url.searchParams.get(key);
    const rootOfQuery = () => rootOf(query("projectId"), query("sessionId"), query("repositoryId"));
    const rootOfBody = (input: Record<string, unknown>) =>
      rootOf(
        String(input.projectId ?? ""),
        input.sessionId ? String(input.sessionId) : undefined,
        input.repositoryId ? String(input.repositoryId) : undefined,
      );
    const rootForQuery = () =>
      rootFor(query("projectId"), query("sessionId"), query("path") ?? "", query("repositoryId"));
    const rootForBody = (input: Record<string, unknown>) =>
      rootFor(
        String(input.projectId ?? ""),
        input.sessionId ? String(input.sessionId) : undefined,
        String(input.path ?? ""),
        input.repositoryId ? String(input.repositoryId) : undefined,
      );
    if (path === "/api/files/stat" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      const root = await rootForQuery();
      try {
        json(200, await fs.stat(root, query("path") ?? ""));
      } catch (cause) {
        // Polling clients can ask for absence as data instead of producing an
        // expected 404 in the browser console. Keep the default stat contract
        // unchanged for every other caller.
        if (
          query("optional") === "true"
          && cause !== null
          && typeof cause === "object"
          && "code" in cause
          && cause.code === "not-found"
        ) {
          json(200, null);
          return true;
        }
        throw cause;
      }
      return true;
    }
    if (path === "/api/files/raw" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      const raw = await fs.readRaw(await rootForQuery(), query("path") ?? "");
      // `download=1` is an explicit save request (Files' Download action):
      // the browser must not render the bytes in place, whatever the type.
      const inline = query("download") !== "1" && (raw.mime.startsWith("image/")
        || raw.mime.startsWith("audio/")
        || raw.mime.startsWith("video/")
        || raw.mime === "application/pdf"
        || raw.mime.startsWith("text/")
        || raw.mime === "application/json"
        || raw.mime === "application/javascript"
        || raw.mime === "application/xml"
        || raw.mime === "application/octet-stream");
      const data = Buffer.from(raw.data);
      const headers = {
        "content-type": raw.mime,
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(query("path")?.split(/[\\/]/).pop() ?? "file")}`,
        "cache-control": "no-cache",
      };
      // Media players (Safari always) fetch byte ranges to seek and refuse a
      // video served without them. The file is already in memory (bounded by
      // MAX_RAW_BYTES), so a single range is a slice of it.
      const range = byteRange(req.headers.range, data.length);
      if (range === "unsatisfiable") {
        res.writeHead(416, { ...headers, "content-range": `bytes */${data.length}` });
        res.end();
        return true;
      }
      if (range) {
        res.writeHead(206, {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${data.length}`,
        });
        res.end(data.subarray(range.start, range.end + 1));
        return true;
      }
      res.writeHead(200, { ...headers, "content-length": String(data.length) });
      res.end(data);
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
    if (path === "/api/files/list" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      json(200, await fs.list(await rootOfQuery(), {
        ...(query("path") ? { path: query("path")! } : {}),
        hidden: query("hidden") === "true",
        ...(query("limit") ? { limit: Number(query("limit")) } : {}),
      }));
      return true;
    }
    if (path === "/api/files/archive" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      const root = await rootOfQuery();
      const plan = await planArchive(fs, root, query("path") ?? "", {
        hidden: query("hidden") === "true",
        skipIgnored: query("ignored") === "skip",
      });
      // `check=1` is the preflight: the browser learns size and refusals as
      // data before it navigates to a download it cannot show errors for.
      if (query("check") === "1") {
        json(200, { name: plan.name, files: plan.files.length, bytes: plan.bytes, refusal: plan.refusal });
        return true;
      }
      if (plan.refusal) {
        json(plan.refusal.reason === "empty" ? 404 : 413, { error: `archive refused: ${plan.refusal.reason}`, refusal: plan.refusal });
        return true;
      }
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${plan.name}.zip`)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      try {
        await writeArchive(fs, root, plan, (chunk) => new Promise<void>((resolve, reject) => {
          if (res.destroyed) { reject(new Error("download aborted")); return; }
          if (res.write(chunk)) resolve();
          else res.once("drain", resolve);
        }));
        res.end();
      } catch {
        // Headers are gone: a cut connection is the only honest signal left,
        // so the browser reports a failed download instead of a corrupt zip.
        res.destroy();
      }
      return true;
    }
    if (path === "/api/files/read" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      json(200, await fs.read(await rootOfQuery(), query("path") ?? "", {
        editable: query("editable") === "true",
      }));
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
    if (path === "/api/files/search-content" && method === "GET") {
      const fs = await filesFor(query("projectId"));
      const parseGlobs = (key: string): string[] | undefined => {
        const raw = query(key);
        if (!raw) return undefined;
        return raw.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 16);
      };
      json(200, await fs.searchContent(
        await rootOfQuery(),
        query("q") ?? "",
        {
          limit: Number(query("limit") ?? 50),
          include: parseGlobs("include"),
          exclude: parseGlobs("exclude"),
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
    { methods: ["GET"], path: "/api/files/list", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/archive", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/read", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/search", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    { methods: ["GET"], path: "/api/files/search-content", capability: REMOTE_CAPABILITY.filesRead, mutation: false },
    // Edit-tool calls are session history, so reading them needs session read.
    { methods: ["GET"], path: SESSION_EDITS_PATH, capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["POST"], path: "/api/files/write", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/upload", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/mkdir", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/delete", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
    { methods: ["POST"], path: "/api/files/rename", capability: REMOTE_CAPABILITY.filesWrite, mutation: true },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const externalReads = createExternalReadStore(packageDataDir(host));
  const files = createFileService({ externalReads: externalReads.get });
  host.services.provide(serverServiceKey<FileService>("files"), files);
  /** SSH transport binds late; resolve it per call so `materialize` reads and
   *  writes a remote project through the same remote FileService the routes use. */
  const attachmentFilesFor = (projectId: string | null): Promise<FileService> => {
    const ssh = host.services.get(serverServiceKey<SshTransportService>("ssh")) ?? undefined;
    return makeFilesFor({ projects: host.projects, files, externalReads: externalReads.get, ...(ssh ? { ssh } : {}) })(projectId);
  };
  host.services.provide(
    serverServiceKey<AttachmentSourceService>("files.attachments"),
    createAttachmentSourceService(attachmentFilesFor),
  );
  host.services.provide(
    serverServiceKey<SessionMediaService>("files.session-media"),
    createSessionMediaService(attachmentFilesFor, (sessionId) => host.sessions.events(sessionId)),
  );
  host.services.provide(
    serverServiceKey<WorkspaceInstructionSourceService>("files.workspace-instructions"),
    createWorkspaceInstructionSource({
      projects: host.projects,
      localFiles: files,
      remoteHost: (connectionId) =>
        host.services.get(serverServiceKey<SshTransportService>("ssh"))?.host(connectionId),
    }),
  );
  let routes: RouteHandler | null = null;
  let registrations: Disposable[] | undefined;
  return {
    remoteAccess: FILES_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      if (registrations) return;
      const handoffRegistry = host.services.get(serverServiceKey<import("@polyth/handoff").ContextSourceRegistry>("handoff.sources"));
      if (handoffRegistry) {
        registerFilesHandoffSources({ registry: handoffRegistry, files, projects: host.projects });
      }
      const fileRoutes = workspaceRoutes({
        projects: host.projects,
        sessions: host.sessions,
        files,
        externalReads: externalReads.get,
        ...(host.services.get(serverServiceKey<SshTransportService>("ssh"))
          ? { ssh: host.services.get(serverServiceKey<SshTransportService>("ssh"))! }
          : {}),
      });
      const aiRoutes = inlineAiRoutes(host, {
        projects: host.projects,
        sessions: host.sessions,
      });
      const editRoutes = sessionEditsRoute({ forSpace: (space) => host.forSpace(space), store: host.store });
      const policyRoutes = externalReadsRoute(externalReads);
      routes ??= async (request) => {
        if (await policyRoutes(request)) return true;
        if (await aiRoutes(request)) return true;
        if (await editRoutes(request)) return true;
        return fileRoutes(request);
      };
      // `read_file` is how the model pages through an oversized tool result.
      // The capability registry is resolved here, in the enable hook, never at
      // registration time; the output cache behind it is read per call.
      const capabilities = host.services.get(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      if (!capabilities) return;
      registrations = [capabilities.register(FILES_PACKAGE_ID, createReadFileAgentTool({
        outputCache: () => host.services.get(serverServiceKey<SessionOutputCache>("session.output-cache")),
      }))];
    },
    async onDisable() {
      for (const registration of registrations?.toReversed() ?? []) await registration.dispose();
      registrations = undefined;
    },
  };
}
