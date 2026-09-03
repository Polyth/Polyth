import type { IncomingMessage, Server } from "node:http";
import { posix, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type {
  JsonObject,
  ProjectService,
  RemoteAccessPolicy,
  RemoteHost,
  RouteHandler,
  SessionEvent,
  SessionService,
} from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createTerminalService, type TerminalService } from "./index.ts";

interface SshTransportService {
  host(connectionId: string): RemoteHost;
}

export function terminalRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  terminals: TerminalService;
  events?: {
    append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent>;
  };
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

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/terminals")) return false;
    const query = (key: string) => url.searchParams.get(key);

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
      let cwd = project.path;
      if (input.sessionId) {
        const session = await deps.sessions.snapshot(String(input.sessionId));
        if (session.projectId !== projectId) {
          throw Object.assign(new Error("session does not belong to this project"), {
            code: "invalid-input",
          });
        }
        if (session.worktreeState === "missing") {
          throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
        }
        cwd = session.worktreePath ?? project.path;
        if (input.cwd && resolveWorkspacePath(String(input.cwd)) !== resolveWorkspacePath(cwd)) {
          throw Object.assign(new Error("terminal cwd does not match the session workspace"), {
            code: "invalid-path",
          });
        }
      } else if (input.cwd && resolveWorkspacePath(String(input.cwd)) !== resolveWorkspacePath(project.path)) {
        throw Object.assign(new Error("terminal cwd requires a matching session"), {
          code: "invalid-path",
        });
      }
      const { id } = await terminals.create({
        projectId,
        cwd,
        ...(input.cmd ? { cmd: String(input.cmd) } : {}),
        ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
        ...(input.cols ? { cols: Number(input.cols) } : {}),
        ...(input.rows ? { rows: Number(input.rows) } : {}),
      });
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

export function attachTerminalWs(server: Server, deps: {
  terminals: TerminalService;
  authorize?: (request: IncomingMessage) => boolean;
}): void {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<WebSocket, string>();
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  wss.on("connection", (socket, request) => {
    const id = (request.url ?? "").split("/").pop() ?? "";
    const info = deps.terminals.get(id);
    if (!info) {
      send(socket, { type: "error", terminalId: id, code: "not-found" });
      socket.close();
      return;
    }
    sockets.set(socket, id);
    send(socket, { type: "attached", terminalId: id });
    const replay = deps.terminals.replay(id);
    if (replay) send(socket, { type: "replay", terminalId: id, data: replay });
    if (!info.running) {
      send(socket, { type: "exit", terminalId: id, exitCode: info.exitCode ?? null });
    }
    socket.on("message", (raw) => {
      let message: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (message.type === "data" && typeof message.data === "string") {
        deps.terminals.write(id, message.data);
      }
      if (message.type === "resize") {
        deps.terminals.resize(id, Number(message.cols ?? 80), Number(message.rows ?? 24));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  const dataSubscription = deps.terminals.onData((id, data) => {
    for (const [socket, terminalId] of sockets) {
      if (terminalId === id) send(socket, { type: "data", terminalId: id, data });
    }
  });
  const exitSubscription = deps.terminals.onExit((id, exitCode) => {
    for (const [socket, terminalId] of sockets) {
      if (terminalId === id) send(socket, { type: "exit", terminalId: id, exitCode });
    }
  });

  const upgrade = (
    request: IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (!url.pathname.match(/^\/ws\/terminal\/([^/]+)$/)) return;
    if (deps.authorize && !deps.authorize(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  };
  server.on("upgrade", upgrade);
  server.on("close", () => {
    server.off("upgrade", upgrade);
    dataSubscription.dispose();
    exitSubscription.dispose();
    wss.close();
  });
}

export const TERMINAL_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["terminal"],
  http: [
    { methods: ["GET"], path: "/api/terminals", capability: REMOTE_CAPABILITY.terminalOpen, mutation: false },
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
  // POLYTH_TERM_REPLAY_BYTES caps per-PTY scrollback replay (default 200 KB).
  // POLYTH_MAX_TERMINALS optionally bounds concurrent terminal processes.
  // Shared with the session service (composer shell) and tracks — published at
  // load time so it exists even while this package's routes are disabled.
  const terminals = createTerminalService({
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
  // Order matters at the gateway: the session gateway aborts /ws upgrades it
  // does not match, so this channel must claim /ws/terminal/:id first — the
  // host runs these callbacks before attaching the core session WS.
  host.onHttpServer(({ server, authorize }) => {
    attachTerminalWs(server, { terminals, authorize });
  });
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: TERMINAL_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= terminalRoutes({
        projects: host.projects,
        sessions: host.sessions,
        terminals,
        events: {
          append: (sessionId, type, data) => host.events.append(
            sessionId,
            type,
            data,
            { ignorable: true, producerPlugin: "terminal" },
          ),
        },
      });
    },
    async onDisable() {
      await terminals.closeAll();
    },
  };
}
