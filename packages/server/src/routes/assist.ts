// F9 routes: idle-assist settings (the hard token-spend switch), the freshness-
// checked assist read, and chat→note distillation. The assist itself lives on
// the projection; this route answers 404 the moment the log outgrows it.
import type { SessionAssist, SessionProjection } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import { isFresh, type AssistSettingsService } from "../assist.ts";

export function assistRoutes(deps: {
  settings: AssistSettingsService;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  latestSeq(sessionId: string): Promise<number>;
  /** Small-model chat→note distillation; absent = honest 503. */
  distill?: (sessionId: string) => Promise<{ title: string; body: string }>;
  /** Small-model summary of the latest user prompt for mobile task chrome. */
  taskBrief?: (sessionId: string) => Promise<string>;
}): RouteHandler {
  return async (rc) => {
    const { path, method, json } = rc;

    if (path === "/api/settings/assist" && method === "GET") {
      json(200, deps.settings.get());
      return true;
    }
    if (path === "/api/settings/assist" && method === "PUT") {
      json(200, deps.settings.put(await rc.body()));
      return true;
    }

    let m = path.match(/^\/api\/sessions\/([^/]+)\/assist$/);
    if (m && method === "GET") {
      const sessionId = decodeURIComponent(m[1]!);
      const proj = await deps.projection(sessionId);
      if (!proj) { json(404, { error: "not-found", message: "unknown session" }); return true; }
      const assist = proj.assist as SessionAssist | undefined;
      if (!assist) { json(404, { error: "not-found", message: "no assist generated yet" }); return true; }
      if (!isFresh(assist, await deps.latestSeq(sessionId))) {
        json(404, { error: "stale", message: "the session moved past this recap" });
        return true;
      }
      json(200, assist);
      return true;
    }

    m = path.match(/^\/api\/sessions\/([^/]+)\/assist\/note$/);
    if (m && method === "POST") {
      const sessionId = decodeURIComponent(m[1]!);
      const proj = await deps.projection(sessionId);
      if (!proj) { json(404, { error: "not-found", message: "unknown session" }); return true; }
      if (!deps.distill) {
        json(503, { error: "unavailable", message: "no small model configured for chat→note" });
        return true;
      }
      try {
        // returns a draft only — saving goes through the normal /api/knowledge flow
        json(200, await deps.distill(sessionId));
      } catch (e) {
        json(502, { error: "upstream", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    m = path.match(/^\/api\/sessions\/([^/]+)\/task-brief$/);
    if (m && method === "POST") {
      const sessionId = decodeURIComponent(m[1]!);
      const proj = await deps.projection(sessionId);
      if (!proj) { json(404, { error: "not-found", message: "unknown session" }); return true; }
      if (!deps.taskBrief) {
        json(503, { error: "unavailable", message: "no small model configured for task brief" });
        return true;
      }
      try {
        json(200, { brief: await deps.taskBrief(sessionId) });
      } catch (e) {
        json(502, { error: "upstream", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    return false;
  };
}
