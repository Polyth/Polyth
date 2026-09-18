// Explicit utility-model routes: prompt improvement, next-action suggestion,
// chat→note distillation, and compact task briefing. Passive idle recap routes
// belong to the optional recap package.
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export function assistRoutes(deps: {
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  /** Small-model chat→note distillation; absent = honest 503. */
  distill?: (space: SpaceContext, sessionId: string) => Promise<{ title: string; body: string }>;
  /** Small-model summary of the latest user prompt for mobile task chrome. */
  taskBrief?: (space: SpaceContext, sessionId: string) => Promise<string>;
  /** Explicit, ephemeral next-action suggestion for the composer. */
  suggestion?: (space: SpaceContext, sessionId: string, draft?: string) => Promise<{ suggestion: string; atSeq: number }>;
  /** Prompt-only rewrite for a composer that has not created a session yet. */
  improve?: (space: SpaceContext, projectId: string, draft: string) => Promise<string>;
}): RouteHandler {
  return async (rc) => {
    const { path, method, json } = rc;

    let m = path.match(/^\/api\/projects\/([^/]+)\/assist\/prompt$/);
    if (m && method === "POST") {
      const projectId = decodeURIComponent(m[1]!);
      const body = await rc.body();
      const draft = typeof body.draft === "string" ? body.draft.trim() : "";
      if (!draft) { json(400, { error: "invalid-input", message: "draft is required" }); return true; }
      if (!deps.improve) { json(503, { error: "unavailable", message: "no small model configured for prompt improvement" }); return true; }
      try {
        json(200, { suggestion: await deps.improve(rc.space, projectId, draft), atSeq: 0 });
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "upstream";
        json(code === "not-found" ? 404 : code === "unavailable" ? 503 : code === "invalid-model" ? 422 : 502, {
          error: code,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    m = path.match(/^\/api\/sessions\/([^/]+)\/assist\/suggestion$/);
    if (m && method === "POST") {
      const sessionId = decodeURIComponent(m[1]!);
      const proj = await deps.projection(sessionId);
      if (!proj) { json(404, { error: "not-found", message: "unknown session" }); return true; }
      if (!deps.suggestion) {
        json(503, { error: "unavailable", message: "no small model configured for next-action suggestion" });
        return true;
      }
      try {
        const body = await rc.body();
        const draft = typeof body.draft === "string" ? body.draft : undefined;
        json(200, await deps.suggestion(rc.space, sessionId, draft));
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code : "upstream";
        if (code === "stale" || code === "in-flight" || code === "no-completed-exchange") {
          json(409, { error: code, message: code === "stale" ? "the session changed during suggestion generation" : code });
        } else {
          json(502, { error: "upstream", message: error instanceof Error ? error.message : String(error) });
        }
      }
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
