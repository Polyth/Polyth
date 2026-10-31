import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { posix, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type {
  JsonObject,
  ProjectService,
  RemoteAccessPolicy,
  RemoteHost,
  RouteHandler,
  SessionEvent,
  SessionProjection,
  SessionService,
  SpaceStorage,
  TerminalWorkspace,
} from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { resolveWorkspaceContext, workspaceRepository, workspaceExecutionPath } from "@polyth/contracts/workspace";
import {
  allowWsCapability,
  claimWsUpgrade,
  closeWs,
  defaultWsIdentity,
  denyUpgrade,
  liveWsPrincipal,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
  type WsAttachAuth,
} from "@polyth/plugins";
import { createTerminalService, type TerminalService } from "./index.ts";
import { materializeCompositeWorkspace } from "./compositeWorkspace.ts";
import { createTerminalContainmentLedger } from "./containmentLedger.ts";
import {
  AUTO_SHELL,
  effectiveShellOverride,
  listAvailableShells,
  readTerminalShellSetting,
  terminalShellSnapshot,
  writeTerminalShellSetting,
  type ShellDiscoveryDeps,
} from "./shellSettings.ts";

interface SshTransportService {
  host(connectionId: string): RemoteHost;
}

export function terminalRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  terminals: TerminalService;
  spaceStorage?: (space: import("@polyth/contracts").SpaceContext) => SpaceStorage;
  events?: {
    append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent>;
  };
  /** Host shell discovery seam for tests; defaults to the real host. */
  shellDiscovery?: ShellDiscoveryDeps;
}): RouteHandler {
  const { terminals } = deps;
  const owners = new Map<string, string>();
  const log = async (
    terminalId: string,
    type: "terminal/created" | "terminal/closed",
    data: JsonObject,
  ) => {
    const sessionId = owners.get(terminalId);
    if (!sessionId || !deps.events) return;
    await deps.events.append(sessionId, type, data);
  };

  terminals.onExit((id, exitCode) => {
    const info = terminals.get(id);
    if (!info) return;
    void log(id, "terminal/closed", {
      terminalId: id,
      projectId: info.projectId,
      exitCode,
    }).catch(() => {});
  });

  return async ({ path, method, url, body, json, space }) => {
    if (!path.startsWith("/api/terminals")) return false;
    const query = (key: string) => url.searchParams.get(key);

    if (path === "/api/terminals/shell" && (method === "GET" || method === "PUT")) {
      if (!deps.spaceStorage) throw Object.assign(new Error("Space-private terminal storage is unavailable"), { code: "unavailable" });
      const storage = deps.spaceStorage(space);
      if (method === "PUT") {
        const input = await body();
        const shell = typeof input.shell === "string" ? input.shell.trim() : "";
        if (!shell) throw Object.assign(new Error("shell required"), { code: "invalid-input" });
        if (shell !== AUTO_SHELL) {
          const available = await listAvailableShells(deps.shellDiscovery);
          if (!effectiveShellOverride(shell, available)) {
            throw Object.assign(new Error("shell is not available on this host"), { code: "invalid-input" });
          }
        }
        await writeTerminalShellSetting(storage, shell);
      }
      json(200, await terminalShellSnapshot(storage, deps.shellDiscovery));
      return true;
    }
    if (path === "/api/terminals" && method === "GET") {
      json(200, terminals.list(query("projectId") ?? undefined));
      return true;
    }
    if (path === "/api/terminals" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      if (!projectId) {
        throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
      }
      const project = await deps.projects.get(projectId);
      if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
      const resolveWorkspacePath = project.remote ? posix.resolve : resolve;
      const repositoryId = input.repositoryId === undefined || input.repositoryId === null
        ? undefined
        : String(input.repositoryId).trim();
      if (input.repositoryId !== undefined && !repositoryId) {
        throw Object.assign(new Error("repositoryId required"), { code: "invalid-input" });
      }
      let cwd = project.path;
      let session: SessionProjection | undefined;
      let workspaceMetadata: TerminalWorkspace | undefined;
      if (input.sessionId) {
        session = await deps.sessions.snapshot(String(input.sessionId));
        if (session.projectId !== projectId) {
          throw Object.assign(new Error("session does not belong to this project"), {
            code: "not-found",
          });
        }
      }
      const context = resolveWorkspaceContext(project, session);
      const workspaceInput = input.workspace as { kind?: unknown; revision?: unknown } | string | boolean | undefined;
      const wantsComposite = workspaceInput === "composite" || workspaceInput === true
        || (typeof workspaceInput === "object" && workspaceInput?.kind === "composite")
        || (repositoryId === undefined && context.repositories.length > 1);
      if (wantsComposite && repositoryId !== undefined) {
        throw Object.assign(new Error("choose Workspace or one repository, not both"), { code: "invalid-input" });
      }
      let workspaceRoots: readonly string[] | undefined;
      let compositeCleanup: (() => Promise<void>) | undefined;
      if (wantsComposite) {
        if (project.remote) throw Object.assign(new Error("composite terminal workspaces are unavailable for remote projects"), { code: "unsupported" });
        if (!deps.spaceStorage) throw Object.assign(new Error("Space-private terminal storage is unavailable"), { code: "unavailable" });
        const composite = await materializeCompositeWorkspace({
          storage: deps.spaceStorage(space),
          workspace: context,
          projectId,
          ownerId: randomUUID(),
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(session?.workspace?.revision !== undefined ? { revision: session.workspace.revision } : {}),
        });
        cwd = composite.root;
        workspaceRoots = composite.roots;
        workspaceMetadata = { kind: "composite", revision: composite.revision, repositoryIds: composite.repositoryIds };
        compositeCleanup = composite.cleanup;
      }
      if (repositoryId !== undefined) {
        const repository = workspaceRepository(context, repositoryId);
        if (repository.state === "missing") {
          throw Object.assign(new Error("repository checkout is missing"), { code: "not-found" });
        }
        cwd = repository.path;
      } else if (!wantsComposite) {
        if (session?.worktreeState === "missing") throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
        cwd = session ? workspaceExecutionPath(project, session) : project.path;
      }
      if (input.cwd && resolveWorkspacePath(String(input.cwd)) !== resolveWorkspacePath(cwd)) {
        throw Object.assign(new Error(input.sessionId
          ? "terminal cwd does not match the session workspace"
          : repositoryId ? "terminal cwd does not match the selected repository" : "terminal cwd requires a matching session"), {
          code: "invalid-path",
        });
      }
      // The Space's terminal shell choice applies to local terminals only; a
      // stale or unknown stored path falls back to the login shell (auto).
      let shell: string | undefined;
      if (!project.remote && deps.spaceStorage) {
        const setting = await readTerminalShellSetting(deps.spaceStorage(space));
        if (setting !== AUTO_SHELL) shell = effectiveShellOverride(setting, await listAvailableShells(deps.shellDiscovery));
      }
      let id: string;
      try {
        ({ id } = await terminals.create({
          ...(shell ? { shell } : {}),
          projectId,
          cwd,
          ...(input.cmd ? { cmd: String(input.cmd) } : {}),
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(repositoryId ? { repositoryId } : {}),
          ...(workspaceRoots ? { workspaceRoots } : {}),
          ...(compositeCleanup ? { workspaceCleanup: compositeCleanup } : {}),
          ...(workspaceMetadata ? { workspace: workspaceMetadata } : {}),
          ...(input.cols ? { cols: Number(input.cols) } : {}),
          ...(input.rows ? { rows: Number(input.rows) } : {}),
        }));
      } catch (error) {
        if (compositeCleanup && (error as { code?: string }).code !== "outcome-unknown") await compositeCleanup().catch(() => undefined);
        throw error;
      }
      if (input.sessionId) {
        owners.set(id, String(input.sessionId));
        await log(id, "terminal/created", {
          terminalId: id,
          projectId,
          cwd,
          ...(input.cmd ? { cmd: String(input.cmd) } : {}),
        });
      }
      json(200, { terminalId: id });
      return true;
    }
    const match = path.match(/^\/api\/terminals\/([^/]+)$/);
    if (match && method === "POST") {
      if (!terminals.get(match[1]!)) {
        throw Object.assign(new Error("unknown terminal"), { code: "not-found" });
      }
      const input = await body();
      terminals.write(match[1]!, String(input.data ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (match && method === "PATCH") {
      const input = await body();
      const title = String(input.title ?? "").trim();
      if (!title) throw Object.assign(new Error("title required"), { code: "invalid-input" });
      const info = terminals.rename(match[1]!, title);
      if (!info) throw Object.assign(new Error("unknown terminal"), { code: "not-found" });
      json(200, info);
      return true;
    }
    if (match && method === "DELETE") {
      if (!terminals.get(match[1]!)) {
        throw Object.assign(new Error("unknown terminal"), { code: "not-found" });
      }
      await terminals.close(match[1]!);
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}

export function attachTerminalWs(server: Server, deps: WsAttachAuth & {
  terminals: TerminalService;
}): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<WebSocket, { id: string; principal: import("@polyth/contracts").AuthPrincipal }>();
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  wss.on("connection", (socket, request: IncomingMessage) => {
    const id = (request.url ?? "").split("/").pop()?.split("?")[0] ?? "";
    const resolution = defaultWsIdentity(deps, request);
    const info = deps.terminals.get(id);
    if (!info) {
      send(socket, { type: "error", terminalId: id, code: "not-found" });
      socket.close();
      return;
    }
    sockets.set(socket, { id, principal: resolution.principal });
    deps.pairedSockets?.bind(socket, resolution.principal, () => closeWs(socket));
    send(socket, { type: "attached", terminalId: id });
    const replay = deps.terminals.replay(id);
    const frames = deps.terminals.replayFrames?.(id);
    if (replay !== undefined && (replay || frames?.length)) {
      send(socket, { type: "replay", terminalId: id, data: replay, ...(frames ? { frames } : {}) });
    }
    if (!info.running) {
      send(socket, { type: "exit", terminalId: id, exitCode: info.exitCode ?? null });
    }
    socket.on("message", (raw) => {
      const bound = sockets.get(socket);
      if (!bound) return;
      const live = liveWsPrincipal(bound.principal, deps.refreshPrincipal);
      if (!live) {
        closeWs(socket);
        return;
      }
      bound.principal = live;
      let message: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (message.type === "data" && typeof message.data === "string") {
        if (!allowWsCapability(live, REMOTE_CAPABILITY.terminalInput)) {
          send(socket, { type: "error", terminalId: id, code: "forbidden", message: "missing terminal.input" });
          return;
        }
        deps.terminals.write(id, message.data);
      }
      if (message.type === "resize") {
        if (!allowWsCapability(live, REMOTE_CAPABILITY.terminalResize)) {
          send(socket, { type: "error", terminalId: id, code: "forbidden", message: "missing terminal.resize" });
          return;
        }
        deps.terminals.resize(id, Number(message.cols ?? 80), Number(message.rows ?? 24));
      }
    });
    socket.on("close", () => {
      deps.pairedSockets?.unbind(socket);
      sockets.delete(socket);
    });
    socket.on("error", () => {
      deps.pairedSockets?.unbind(socket);
      sockets.delete(socket);
    });
  });

  const dataSubscription = deps.terminals.onData((id, data) => {
    for (const [socket, bound] of sockets) {
      if (bound.id !== id) continue;
      const live = liveWsPrincipal(bound.principal, deps.refreshPrincipal);
      if (!live) {
        closeWs(socket);
        continue;
      }
      if (!allowWsCapability(live, REMOTE_CAPABILITY.terminalOpen)) continue;
      send(socket, { type: "data", terminalId: id, data });
    }
  });
  const exitSubscription = deps.terminals.onExit((id, exitCode) => {
    for (const [socket, bound] of sockets) {
      if (bound.id !== id) continue;
      const live = liveWsPrincipal(bound.principal, deps.refreshPrincipal);
      if (!live) {
        closeWs(socket);
        continue;
      }
      bound.principal = live;
      if (allowWsCapability(live, REMOTE_CAPABILITY.terminalOpen)) {
        send(socket, { type: "exit", terminalId: id, exitCode });
      }
    }
  });

  const stopClaim = claimWsUpgrade(server, (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (!url.pathname.match(/^\/ws\/terminal\/([^/]+)$/)) return false;
    const resolution = defaultWsIdentity(deps, request);
    if (deps.authorize ? !deps.authorize(request) : !resolution.authenticated) {
      denyUpgrade(socket, 401);
      return true;
    }
    if (!allowWsCapability(resolution.principal, REMOTE_CAPABILITY.terminalOpen)) {
      denyUpgrade(socket, 403);
      return true;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
    return true;
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.off("close", stop);
    stopClaim();
    dataSubscription.dispose();
    exitSubscription.dispose();
    for (const [socket] of sockets) closeWs(socket);
    sockets.clear();
    wss.close();
  };
  server.on("close", stop);
  return stop;
}

export const TERMINAL_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["terminals", "terminal"],
  http: [
    { methods: ["GET"], path: "/api/terminals", capability: REMOTE_CAPABILITY.terminalOpen, mutation: false },
    { methods: ["GET"], path: "/api/terminals/shell", capability: REMOTE_CAPABILITY.terminalOpen, mutation: false },
    { methods: ["PUT"], path: "/api/terminals/shell", capability: REMOTE_CAPABILITY.terminalOpen, mutation: true },
    { methods: ["POST"], path: "/api/terminals", capability: REMOTE_CAPABILITY.terminalOpen, mutation: true },
    { methods: ["POST"], path: "/api/terminals/:id", capability: REMOTE_CAPABILITY.terminalInput, mutation: true },
    { methods: ["PATCH"], path: "/api/terminals/:id", capability: REMOTE_CAPABILITY.terminalOpen, mutation: true },
    { methods: ["DELETE"], path: "/api/terminals/:id", capability: REMOTE_CAPABILITY.terminalOpen, mutation: true },
  ],
  websocket: [
    { path: "/ws/terminal/:id", capability: REMOTE_CAPABILITY.terminalOpen },
  ],
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const storageForProject = async (projectId: string): Promise<SpaceStorage> => {
    const project = await host.projects.get(projectId);
    if (!project?.spaceId) throw Object.assign(new Error("Terminal Space ownership is unavailable"), { code: "forbidden" });
    return host.spaceStorage(host.systemSpaceContext(project.spaceId));
  };
  const ledger = createTerminalContainmentLedger({
    storageForProject,
    storages: async () => {
      const spaces = new Set((await host.projects.list()).flatMap((project) => project.spaceId ? [project.spaceId] : []));
      return [...spaces].map((spaceId) => host.spaceStorage(host.systemSpaceContext(spaceId)));
    },
  });
  // POLYTH_TERM_REPLAY_BYTES caps per-PTY scrollback replay (default 200 KB).
  // POLYTH_MAX_TERMINALS optionally bounds concurrent terminal processes.
  // Shared with the session service (composer shell) and tracks — published at
  // load time so it exists even while this package's routes are disabled.
  const terminals = createTerminalService({
    processBoundary: (input) => ledger.create(input),
    recoverProcesses: { byCwd: (cwd) => ledger.releaseByCwd(cwd), all: () => ledger.releaseAll() },
    ...(Number(process.env.POLYTH_TERM_REPLAY_BYTES) > 0
      ? { replayBytes: Number(process.env.POLYTH_TERM_REPLAY_BYTES) }
      : {}),
    ...(Number(process.env.POLYTH_MAX_TERMINALS) > 0
      ? { maxSessions: Number(process.env.POLYTH_MAX_TERMINALS) }
      : {}),
    remoteHostForProject: async (projectId) => {
      const project = await host.projects.get(projectId);
      if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
      if (project.remote?.kind !== "ssh") return undefined;
      const ssh = host.services.get(serverServiceKey<SshTransportService>("ssh"));
      if (!ssh) {
        throw Object.assign(
          new Error("SSH support unavailable: the ssh package did not load"),
          { code: "unavailable" },
        );
      }
      return ssh.host(project.remote.connectionId);
    },
  });
  host.services.provide(serverServiceKey<TerminalService>("terminal"), terminals);
  const httpContexts = new Set<import("@polyth/plugins").HttpServerContext>();
  const detachers = new Map<Server, () => void>();
  let wsEnabled = false;
  const attachTo = (ctx: import("@polyth/plugins").HttpServerContext) => {
    detachers.get(ctx.server)?.();
    detachers.set(ctx.server, attachTerminalWs(ctx.server, {
      terminals,
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    }));
  };
  host.onHttpServer((ctx) => {
    httpContexts.add(ctx);
    ctx.server.on("close", () => {
      httpContexts.delete(ctx);
      detachers.get(ctx.server)?.();
      detachers.delete(ctx.server);
    });
    if (wsEnabled) attachTo(ctx);
  });
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: TERMINAL_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      wsEnabled = true;
      routes ??= terminalRoutes({
        projects: host.projects,
        sessions: host.sessions,
        terminals,
        spaceStorage: host.spaceStorage,
        events: {
          append: (sessionId, type, data) => host.events.append(
            sessionId,
            type,
            data,
            { ignorable: true, producerPlugin: "terminal" },
          ),
        },
      });
      for (const ctx of httpContexts) attachTo(ctx);
    },
    async onDisable() {
      wsEnabled = false;
      for (const stop of detachers.values()) stop();
      detachers.clear();
      await terminals.closeAll();
    },
    stopIngress() {
      wsEnabled = false;
      for (const stop of detachers.values()) stop();
      detachers.clear();
    },
  };
}
