// HTTP + WS face of the terminal plugin (PLAN M3). REST per the fixed
// protocol; /ws/terminal/:id is a second WS channel beside /ws (gap-filled
// session events) — JSON frames {type:"data",data} both ways,
// {type:"resize",cols,rows} client->server.
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import type { ProjectService, SessionEvent, SessionPersistence, JsonObject } from "@polyth/contracts";
import type { SessionService } from "@polyth/contracts";
import type { TerminalService } from "@polyth/terminal";
import type { RouteHandler } from "../http.ts";
import type { Broadcaster } from "../sessions.ts";

export function terminalRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  terminals: TerminalService;
  /** append + broadcast; only used when a terminal is spawned from a session context */
  events?: { append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent> };
}): RouteHandler {
  const { terminals } = deps;
  // terminalId -> sessionId for terminal/closed logging (owned by the route,
  // keeps the service session-agnostic)
  const owner = new Map<string, string>();
  const log = async (terminalId: string, type: "terminal/created" | "terminal/closed", data: JsonObject) => {
    const sessionId = owner.get(terminalId);
    if (!sessionId || !deps.events) return;
    await deps.events.append(sessionId, type, data);
  };

  terminals.onExit((id, exitCode) => {
    const info = terminals.get(id);
    if (!info) return;
    void log(id, "terminal/closed", { terminalId: id, projectId: info.projectId, exitCode }).catch(() => {});
  });

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/terminals")) return false;
    const q = (k: string) => url.searchParams.get(k);

    if (path === "/api/terminals" && method === "GET") {
      json(200, terminals.list(q("projectId") ?? undefined));
      return true;
    }
    if (path === "/api/terminals" && method === "POST") {
      const b = await body();
      const projectId = String(b.projectId ?? "");
      if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
      const project = await deps.projects.get(projectId);
      if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
      let cwd = project.path;
      if (b.sessionId) {
        const session = await deps.sessions.snapshot(String(b.sessionId));
        if (session.projectId !== projectId) {
          throw Object.assign(new Error("session does not belong to this project"), { code: "invalid-input" });
        }
        if (session.worktreeState === "missing") {
          throw Object.assign(new Error("session worktree is missing"), { code: "not-found" });
        }
        cwd = session.worktreePath ?? project.path;
        if (b.cwd && resolve(String(b.cwd)) !== resolve(cwd)) {
          throw Object.assign(new Error("terminal cwd does not match the session workspace"), { code: "invalid-path" });
        }
      } else if (b.cwd && resolve(String(b.cwd)) !== resolve(project.path)) {
        throw Object.assign(new Error("terminal cwd requires a matching session"), { code: "invalid-path" });
      }
      const { id } = await terminals.create({
        projectId,
        cwd,
        ...(b.cmd ? { cmd: String(b.cmd) } : {}),
        ...(b.sessionId ? { sessionId: String(b.sessionId) } : {}),
        ...(b.cols ? { cols: Number(b.cols) } : {}),
        ...(b.rows ? { rows: Number(b.rows) } : {}),
      });
      if (b.sessionId) {
        owner.set(id, String(b.sessionId));
        await log(id, "terminal/created", { terminalId: id, projectId, cwd, ...(b.cmd ? { cmd: String(b.cmd) } : {}) });
      }
      json(200, { terminalId: id });
      return true;
    }
    const m = path.match(/^\/api\/terminals\/([^/]+)$/);
    if (m && method === "POST") { // /input
      const b = await body();
      terminals.write(m[1]!, String(b.data ?? ""));
      json(200, { ok: true });
      return true;
    }
    if (m && method === "DELETE") {
      if (!terminals.get(m[1]!)) throw Object.assign(new Error("unknown terminal"), { code: "not-found" });
      await terminals.close(m[1]!);
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}

/** /ws/terminal/:id — attach a second WebSocketServer alongside /ws (which
 *  only claims its own path; unmatched upgrades fall through to us). */
export function attachTerminalWs(server: Server, deps: {
  terminals: TerminalService;
}): void {
  const wss = new WebSocketServer({ noServer: true });
  // socket -> terminalId it was opened for (each /ws/terminal/:id socket
  // belongs to exactly one terminal)
  const sockets = new Map<WebSocket, string>();

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws, req) => {
    const id = (req.url ?? "").split("/").pop() ?? "";
    sockets.set(ws, id);
    send(ws, { type: "attached", terminalId: id });
    ws.on("message", (raw) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "data" && typeof msg.data === "string") deps.terminals.write(id, msg.data);
      if (msg.type === "resize") deps.terminals.resize(id, Number(msg.cols ?? 80), Number(msg.rows ?? 24));
    });
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => sockets.delete(ws));
  });

  const dataSub = deps.terminals.onData((id, data) => {
    for (const [ws, tid] of sockets) if (tid === id) send(ws, { type: "data", terminalId: id, data });
  });
  const exitSub = deps.terminals.onExit((id, exitCode) => {
    for (const [ws, tid] of sockets) if (tid === id) send(ws, { type: "exit", terminalId: id, exitCode });
  });

  const upgrade = (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
    if (!m) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", upgrade);
  server.on("close", () => {
    server.off("upgrade", upgrade);
    dataSub.dispose();
    exitSub.dispose();
    wss.close();
  });
}
