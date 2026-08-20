// Session control surface (OC polyth-control parity): a small, stable
// HTTP API for listing/creating/forking/aborting sessions. Wraps the existing
// session service — agents or external tools can drive sessions through it
// without touching internal routes.
import type { SessionService } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export function controlRoutes(sessions: SessionService): RouteHandler {
  return async ({ path, method, url, body, json }) => {
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
