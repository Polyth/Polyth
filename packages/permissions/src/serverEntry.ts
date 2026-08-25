import type { RouteHandler, SessionService } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";

export function autoAcceptRoutes(sessions: SessionService): RouteHandler {
  return async (request) => {
    const match = request.path.match(
      /^\/api\/sessions\/([^/]+)\/permissions\/auto-accept$/,
    );
    if (!match) return false;
    const sessionId = match[1]!;
    if (request.method === "GET") {
      if (!sessions.autoAcceptGet) {
        throw Object.assign(new Error("auto-accept unavailable"), {
          code: "unsupported",
        });
      }
      request.json(200, await sessions.autoAcceptGet(sessionId));
      return true;
    }
    if (request.method === "PATCH") {
      if (!sessions.autoAcceptSet) {
        throw Object.assign(new Error("auto-accept unavailable"), {
          code: "unsupported",
        });
      }
      const input = await request.body();
      const setting = input.setting;
      if (setting !== "on" && setting !== "off" && setting !== "inherit") {
        throw Object.assign(
          new Error("setting must be on, off, or inherit"),
          { code: "invalid-input" },
        );
      }
      request.json(200, await sessions.autoAcceptSet(sessionId, setting));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return { routes: autoAcceptRoutes(host.sessions) };
}
