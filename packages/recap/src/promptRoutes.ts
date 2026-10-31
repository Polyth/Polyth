// Explicit, ephemeral Session Assist requests. Authorization is resolved before model work.
import type { RouteHandler, SessionProjection, SpaceContext } from "@polyth/contracts";

export function promptRoutes(deps: {
  projection(space: SpaceContext, sessionId: string): Promise<SessionProjection | undefined>;
  suggestion?: (
    space: SpaceContext, sessionId: string, draft?: string, options?: { regenerate?: boolean },
  ) => Promise<{ suggestion: string; atSeq: number }>;
  callouts?: (space: SpaceContext, sessionId: string) => Promise<{ callouts: unknown[]; atSeq: number }>;
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
      const proj = await deps.projection(rc.space, sessionId);
      if (!proj) { json(404, { error: "not-found", message: "unknown session" }); return true; }
      if (!deps.suggestion) {
        json(503, { error: "unavailable", message: "no small model configured for next-action suggestion" });
        return true;
      }
      try {
        const body = await rc.body();
        const draft = typeof body.draft === "string" ? body.draft : undefined;
        json(200, await deps.suggestion(rc.space, sessionId, draft, { regenerate: body.regenerate === true }));
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

    m = path.match(/^\/api\/sessions\/([^/]+)\/assist\/callouts$/);
    if (m && method === "POST") {
      const sessionId = decodeURIComponent(m[1]!);
      const proj = await deps.projection(rc.space, sessionId);
      if (!proj) { json(404, { error: "not-found", message: "unknown session" }); return true; }
      if (!deps.callouts) {
        json(503, { error: "unavailable", message: "no small model configured for callouts" });
        return true;
      }
      try {
        json(200, await deps.callouts(rc.space, sessionId));
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code : "upstream";
        if (code === "stale" || code === "no-completed-turn") json(409, { error: code, message: code });
        else json(502, { error: "upstream", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    return false;
  };
}
