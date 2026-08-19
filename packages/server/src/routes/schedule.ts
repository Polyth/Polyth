// HTTP face of the schedule plugin: /api/schedule CRUD + pause/resume/run.
import type { ScheduleService, ScheduleTaskInput } from "@polyth/schedule";
import type { RouteHandler } from "../http.ts";

export function scheduleRoutes(schedule: ScheduleService): RouteHandler {
  const inputOf = (b: Record<string, unknown>): Partial<ScheduleTaskInput> => ({
    ...(b.projectId !== undefined ? { projectId: String(b.projectId) } : {}),
    ...(b.prompt !== undefined ? { prompt: String(b.prompt) } : {}),
    ...(b.kind !== undefined ? { kind: b.kind as ScheduleTaskInput["kind"] } : {}),
    ...(b.at !== undefined ? { at: Number(b.at) } : {}),
    ...(b.everyMinutes !== undefined ? { everyMinutes: Number(b.everyMinutes) } : {}),
    ...(b.sessionId !== undefined && b.sessionId !== "" ? { sessionId: String(b.sessionId) } : {}),
    ...(b.title !== undefined && b.title !== "" ? { title: String(b.title) } : {}),
    ...(b.enabled !== undefined ? { enabled: b.enabled === true } : {}),
  });

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/schedule")) return false;

    if (path === "/api/schedule" && method === "GET") {
      json(200, schedule.list(url.searchParams.get("projectId") ?? undefined));
      return true;
    }
    if (path === "/api/schedule" && method === "POST") {
      json(200, schedule.create(inputOf(await body()) as ScheduleTaskInput));
      return true;
    }

    const m = path.match(/^\/api\/schedule\/([^/]+)(?:\/(pause|resume|run))?$/);
    if (!m) return false;
    const id = m[1]!;
    const action = m[2];

    if (!action && method === "PATCH") {
      json(200, schedule.update(id, inputOf(await body())));
      return true;
    }
    if (!action && method === "DELETE") {
      json(200, { ok: schedule.remove(id) });
      return true;
    }
    if (method === "POST" && (action === "pause" || action === "resume")) {
      json(200, schedule.setEnabled(id, action === "resume"));
      return true;
    }
    if (method === "POST" && action === "run") {
      json(200, await schedule.runNow(id));
      return true;
    }
    return false;
  };
}
