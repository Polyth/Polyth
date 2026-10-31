// Core utility-model routes for chat→note distillation and task briefing.
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export function assistRoutes(deps: {
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  /** Small-model chat→note distillation; absent = honest 503. */
  distill?: (space: SpaceContext, sessionId: string) => Promise<{ title: string; body: string }>;
  /** Small-model summary of the latest user prompt for mobile task chrome. */
  taskBrief?: (space: SpaceContext, sessionId: string) => Promise<string>;
}): RouteHandler {
  return async (rc) => {
    const { path, method, json } = rc;

    let m = path.match(/^\/api\/sessions\/([^/]+)\/assist\/note$/);
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
        json(200, await deps.distill(rc.space, sessionId));
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
        json(200, { brief: await deps.taskBrief(rc.space, sessionId) });
      } catch (e) {
        json(502, { error: "upstream", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    return false;
  };
}
