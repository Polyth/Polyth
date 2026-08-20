// F18: per-session auto-accept policy. The server owns the record — the UI
// only reads {setting, effective} and PATCHes an explicit choice. Enabling
// reconciles requests that are already pending (handled by the service).
import type { SessionService } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export function autoAcceptRoutes(sessions: SessionService): RouteHandler {
  return async (rc) => {
    const m = rc.path.match(/^\/api\/sessions\/([^/]+)\/permissions\/auto-accept$/);
    if (!m) return false;
    const sessionId = m[1]!;

    if (rc.method === "GET") {
      if (!sessions.autoAcceptGet) throw Object.assign(new Error("auto-accept unavailable"), { code: "unsupported" });
      rc.json(200, await sessions.autoAcceptGet(sessionId));
      return true;
    }
    if (rc.method === "PATCH") {
      if (!sessions.autoAcceptSet) throw Object.assign(new Error("auto-accept unavailable"), { code: "unsupported" });
      const b = await rc.body();
      const setting = b.setting;
      if (setting !== "on" && setting !== "off" && setting !== "inherit") {
        throw Object.assign(new Error("setting must be on, off, or inherit"), { code: "invalid-input" });
      }
      rc.json(200, await sessions.autoAcceptSet(sessionId, setting));
      return true;
    }
    return false;
  };
}
