// HTTP face of the schedule plugin: /api/schedule CRUD + pause/resume/run,
// plus WP10 cadence preview, run history, and .agents/loops reconciliation.
import type { ProjectService } from "@polyth/contracts";
import { scanLoopsDir } from "@polyth/schedule";
import type { ScheduleCadence, ScheduleService, ScheduleTarget, ScheduleTaskInput } from "@polyth/schedule";
import type { RouteHandler } from "../http.ts";

export interface ScheduleRouteDeps {
  schedule: ScheduleService;
  projects: ProjectService;
}

const cadenceOf = (raw: unknown): ScheduleCadence | undefined => {
  const c = raw as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return undefined;
  if (c.kind === "at") return { kind: "at", at: Number(c.at) };
  if (c.kind === "every") return { kind: "every", everyMinutes: Number(c.everyMinutes) };
  if (c.kind === "cron") return { kind: "cron", expression: String(c.expression ?? ""), timeZone: String(c.timeZone ?? "") };
  return undefined;
};

const targetOf = (raw: unknown): ScheduleTarget | undefined => {
  const t = raw as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return undefined;
  const mode = t.mode;
  if (mode !== "existing-session" && mode !== "new-session-per-run" && mode !== "dedicated-session") return undefined;
  return {
    mode,
    ...(t.sessionId ? { sessionId: String(t.sessionId) } : {}),
    ...(t.worktreePolicy === "fresh-worktree" ? { worktreePolicy: "fresh-worktree" as const } : {}),
  };
};

export function scheduleRoutes(deps: ScheduleRouteDeps): RouteHandler {
  const { schedule, projects } = deps;
  const inputOf = (b: Record<string, unknown>): Partial<ScheduleTaskInput> => ({
    ...(b.projectId !== undefined ? { projectId: String(b.projectId) } : {}),
    ...(b.prompt !== undefined ? { prompt: String(b.prompt) } : {}),
    ...(b.kind !== undefined ? { kind: b.kind as ScheduleTaskInput["kind"] } : {}),
    ...(b.at !== undefined ? { at: Number(b.at) } : {}),
    ...(b.everyMinutes !== undefined ? { everyMinutes: Number(b.everyMinutes) } : {}),
    ...(cadenceOf(b.cadence) ? { cadence: cadenceOf(b.cadence)! } : {}),
    ...(targetOf(b.target) ? { target: targetOf(b.target)! } : {}),
    ...(b.overlapPolicy === "skip" || b.overlapPolicy === "queue" || b.overlapPolicy === "parallel"
      ? { overlapPolicy: b.overlapPolicy } : {}),
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
    if (path === "/api/schedule/preview" && method === "POST") {
      const b = await body();
      const cadence = cadenceOf(b.cadence);
      if (!cadence) {
        json(400, { error: "invalid-input", message: "cadence is required" });
        return true;
      }
      json(200, schedule.preview(cadence, b.count !== undefined ? Number(b.count) : 5));
      return true;
    }
    if (path === "/api/schedule/loops" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      json(200, schedule.list(projectId).filter((t) => t.source === "loop-file"));
      return true;
    }
    if (path === "/api/schedule/loops/rescan" && method === "POST") {
      const b = await body();
      const projectId = String(b.projectId ?? "");
      const project = await projects.get(projectId);
      if (!project) {
        json(404, { error: "not-found", message: "project not found" });
        return true;
      }
      json(200, schedule.syncLoops(projectId, scanLoopsDir(project.path)));
      return true;
    }

    const m = path.match(/^\/api\/schedule\/([^/]+)(?:\/(pause|resume|run|runs))?$/);
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
    if (method === "GET" && action === "runs") {
      json(200, schedule.runsOf(id, Number(url.searchParams.get("limit") ?? 50)));
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
