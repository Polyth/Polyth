// HTTP face of the goals plugin (PLAN §12). The plugin itself knows nothing
// about HTTP; this adapter is dropped into the boot profile's route list.
import type { GoalService } from "@polyth/goals";
import type { RouteHandler } from "../http.ts";

export function goalRoutes(goals: GoalService): RouteHandler {
  return async ({ path, method, body, json }) => {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/goal(?:\/(pause|resume|stop))?$/);
    if (!m) return false;
    const sessionId = m[1]!;
    const action = m[2];

    if (!action && method === "GET") {
      json(200, goals.get(sessionId));
      return true;
    }
    if (!action && method === "POST") {
      const b = await body();
      const state = await goals.attach(sessionId, {
        objective: String(b.objective ?? ""),
        ...(b.budgetTokens ? { budgetTokens: Number(b.budgetTokens) } : {}),
        ...(b.maxContinuations ? { maxContinuations: Number(b.maxContinuations) } : {}),
      });
      json(200, state);
      return true;
    }
    if (action && method === "POST") {
      if (action === "stop") {
        await goals.stop(sessionId);
        json(200, { ok: true });
        return true;
      }
      json(200, action === "pause" ? await goals.pause(sessionId) : await goals.resume(sessionId));
      return true;
    }
    return false;
  };
}
