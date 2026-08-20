// Session control surface (OC polyth-control parity): a small, stable
// HTTP API for listing/creating/forking/aborting sessions. Wraps the existing
// session service — agents or external tools can drive sessions through it
// without touching internal routes.
import type { SessionService } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

const MAX_IMPORT_BATCH = 200;

export function controlRoutes(sessions: SessionService): RouteHandler {
  return async ({ path, method, url, body, json }) => {
    // F14 import half: browse unadopted backend sessions, then adopt selected.
    if (path === "/api/control/backend-sessions" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
      json(200, await sessions.backendSessions!(projectId));
      return true;
    }
    if (path === "/api/control/backend-sessions/import" && method === "POST") {
      const b = await body();
      const projectId = String(b.projectId ?? "");
      if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
      const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
      if (ids.length === 0) throw Object.assign(new Error("ids required"), { code: "invalid-input" });
      if (ids.length > MAX_IMPORT_BATCH) {
        throw Object.assign(new Error(`at most ${MAX_IMPORT_BATCH} sessions per import`), { code: "invalid-input" });
      }
      json(200, await sessions.importBackendSessions!(projectId, ids));
      return true;
    }

    if (!path.startsWith("/api/control/sessions")) return false;

    if (path === "/api/control/sessions" && method === "GET") {
      json(200, await sessions.list(url.searchParams.get("projectId") ?? undefined));
      return true;
    }
    if (path === "/api/control/sessions" && method === "POST") {
      const b = await body();
      if (!b.projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
      const ref = await sessions.create({
        projectId: String(b.projectId),
        ...(b.title ? { title: String(b.title) } : {}),
        ...(b.agent ? { agent: String(b.agent) } : {}),
      });
      json(200, ref);
      return true;
    }

    const m = path.match(/^\/api\/control\/sessions\/([^/]+)\/(fork|abort)$/);
    if (m && method === "POST") {
      const id = m[1]!;
      if (m[2] === "fork") {
        const b = await body();
        json(200, await sessions.fork(id, b.atSeq !== undefined ? Number(b.atSeq) : undefined));
      } else {
        await sessions.abort(id);
        json(200, { ok: true });
      }
      return true;
    }

    // GET by id: lets agents/external tools open a session they know only by
    // id (pairs with the /p/{projectId}/s/{sessionId} URLs in the web app).
    const single = path.match(/^\/api\/control\/sessions\/([^/]+)$/);
    if (single && method === "GET") {
      json(200, await sessions.snapshot(decodeURIComponent(single[1]!)));
      return true;
    }
    return false;
  };
}
