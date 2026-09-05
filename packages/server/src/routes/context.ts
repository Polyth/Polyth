import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";

/** Message-pin producer. Persistence and validation stay in SessionService so
 * every caller shares the same append-before-broadcast ordering. */
export function contextRoutes(spaces: SpaceServicesFor): RouteHandler {
  return async ({ path, method, json, space }) => {
    const { sessions } = spaces(space);
    const match = path.match(/^\/api\/sessions\/([^/]+)\/context\/pins\/(\d+)$/);
    if (!match) return false;
    const sessionId = match[1]!;
    const sourceEventSeq = Number(match[2]);
    if (method === "POST") {
      if (!sessions.pinContext) {
        throw Object.assign(new Error("message pinning unavailable"), { code: "unsupported" });
      }
      json(200, await sessions.pinContext(sessionId, sourceEventSeq));
      return true;
    }
    if (method === "DELETE") {
      if (!sessions.unpinContext) {
        throw Object.assign(new Error("message pinning unavailable"), { code: "unsupported" });
      }
      json(200, await sessions.unpinContext(sessionId, sourceEventSeq));
      return true;
    }
    return false;
  };
}
