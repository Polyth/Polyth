import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  systemAppendSessionEvent,
  systemSessionsForProject,
  systemSessionsForSession,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  assertLoopExecutionTrusted,
  createScheduleService,
  scanLoopsDir,
  type ScheduleCadence,
  type ScheduleService,
  type ScheduleTarget,
  type ScheduleTaskInput,
} from "./index.ts";

const cadenceOf = (raw: unknown): ScheduleCadence | undefined => {
  const cadence = raw as Record<string, unknown> | undefined;
  if (!cadence || typeof cadence !== "object") return undefined;
  if (cadence.kind === "at") return { kind: "at", at: Number(cadence.at) };
  if (cadence.kind === "every") return { kind: "every", everyMinutes: Number(cadence.everyMinutes) };
  if (cadence.kind === "cron") return {
    kind: "cron",
    expression: String(cadence.expression ?? ""),
    timeZone: String(cadence.timeZone ?? ""),
  };
  return undefined;
};

const targetOf = (raw: unknown): ScheduleTarget | undefined => {
  const target = raw as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") return undefined;
  if (target.mode !== "existing-session" && target.mode !== "new-session-per-run" && target.mode !== "dedicated-session") return undefined;
  return {
    mode: target.mode,
    ...(target.sessionId ? { sessionId: String(target.sessionId) } : {}),
    ...(target.worktreePolicy === "fresh-worktree" ? { worktreePolicy: "fresh-worktree" as const } : {}),
  };
};

export function scheduleRoutes(deps: {
  schedule: ScheduleService;
  forSpace: ServerPackageHost["forSpace"];
}): RouteHandler {
  const inputOf = (input: Record<string, unknown>): Partial<ScheduleTaskInput> => ({
    ...(input.projectId !== undefined ? { projectId: String(input.projectId) } : {}),
    ...(input.prompt !== undefined ? { prompt: String(input.prompt) } : {}),
    ...(input.kind !== undefined ? { kind: input.kind as ScheduleTaskInput["kind"] } : {}),
    ...(input.at !== undefined ? { at: Number(input.at) } : {}),
    ...(input.everyMinutes !== undefined ? { everyMinutes: Number(input.everyMinutes) } : {}),
    ...(cadenceOf(input.cadence) ? { cadence: cadenceOf(input.cadence)! } : {}),
    ...(targetOf(input.target) ? { target: targetOf(input.target)! } : {}),
    ...(input.overlapPolicy === "skip" || input.overlapPolicy === "queue" || input.overlapPolicy === "parallel" ? { overlapPolicy: input.overlapPolicy } : {}),
    ...(input.sessionId !== undefined && input.sessionId !== "" ? { sessionId: String(input.sessionId) } : {}),
    ...(input.title !== undefined && input.title !== "" ? { title: String(input.title) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
  });

  return async (rc) => {
    const { path, method, url, body, json } = rc;
    if (!path.startsWith("/api/schedule")) return false;
    const scoped = deps.forSpace(rc.space);
    const project = async (projectId: string) => scoped.projects.get(projectId);
    const allowedTask = async (id: string) => {
      const task = deps.schedule.get(id);
      if (!task || !(await project(task.projectId))) return undefined;
      return task;
    };
    const validateTarget = async (input: Partial<ScheduleTaskInput>, fallbackProjectId?: string): Promise<boolean> => {
      const projectId = input.projectId ?? fallbackProjectId;
      if (!projectId || !(await project(projectId))) return false;
      const sessionId = input.target?.sessionId ?? input.sessionId;
      if (sessionId) {
        try {
          const session = await scoped.sessions.snapshot(sessionId);
          if (session.projectId !== projectId) return false;
        } catch { return false; }
      }
      return true;
    };

    if (path === "/api/schedule" && method === "GET") {
      const requested = url.searchParams.get("projectId") ?? undefined;
      if (requested && !(await project(requested))) {
        json(200, { tasks: [], loopErrors: [] });
        return true;
      }
      const allowedIds = requested
        ? new Set([requested])
        : new Set((await scoped.projects.list()).map((item) => item.id));
      json(200, {
        tasks: deps.schedule.list(requested).filter((task) => allowedIds.has(task.projectId)),
        loopErrors: requested
          ? deps.schedule.loopErrors(requested)
          : [...allowedIds].flatMap((projectId) => deps.schedule.loopErrors(projectId)),
      });
      return true;
    }
    if (path === "/api/schedule" && method === "POST") {
      const input = inputOf(await body()) as ScheduleTaskInput;
      if (!(await validateTarget(input))) {
        json(404, { error: "not-found", message: "project or target session not found" });
        return true;
      }
      json(200, deps.schedule.create(input));
      return true;
    }
    if (path === "/api/schedule/preview" && method === "POST") {
      const input = await body();
      const cadence = cadenceOf(input.cadence);
      if (!cadence) { json(400, { error: "invalid-input", message: "cadence is required" }); return true; }
      json(200, deps.schedule.preview(cadence, input.count !== undefined ? Number(input.count) : 5));
      return true;
    }
    if (path === "/api/schedule/loops" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      if (!projectId || !(await project(projectId))) { json(200, []); return true; }
      json(200, deps.schedule.list(projectId).filter((task) => task.source === "loop-file"));
      return true;
    }
    if (path === "/api/schedule/loops/rescan" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      const owned = await project(projectId);
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      json(200, deps.schedule.syncLoops(projectId, scanLoopsDir(owned.path), { explicit: true }));
      return true;
    }
    if (path === "/api/schedule/loops/errors/dismiss" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      if (!(await project(projectId))) { json(404, { error: "not-found", message: "project not found" }); return true; }
      json(200, { ok: deps.schedule.dismissLoopError(projectId, String(input.path ?? "")) });
      return true;
    }

    const trustMatch = path.match(/^\/api\/schedule\/([^/]+)\/trust$/);
    if (trustMatch && method === "POST") {
      const id = trustMatch[1]!;
      const task = await allowedTask(id);
      if (!task || task.source !== "loop-file" || !task.sourcePath || !task.loopId) {
        json(404, { error: "not-found", message: "managed loop task not found" });
        return true;
      }
      const owned = await project(task.projectId);
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      const scan = scanLoopsDir(owned.path);
      const current = scan.find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
      if (!current?.loop || current.digest !== task.sourceDigest) {
        deps.schedule.syncLoops(task.projectId, scan, { explicit: true });
        json(409, { error: "content-trust-changed", message: "Loop changed again. Refresh and review the current version." });
        return true;
      }
      const input = await body();
      const action = String(input.action ?? "");
      if (action === "trust-current") { json(200, deps.schedule.trustLoopVersion(id, rc.space.spaceId, current)); return true; }
      if (action === "run-once") { json(200, await deps.schedule.runLoopVersionOnce(id, rc.space.spaceId, current)); return true; }
      if (action === "reject") { json(200, deps.schedule.rejectLoopVersion(id)); return true; }
      json(400, { error: "invalid-input", message: "action must be trust-current, run-once, or reject" });
      return true;
    }

    const match = path.match(/^\/api\/schedule\/([^/]+)(?:\/(pause|resume|run|runs))?$/);
    if (!match) return false;
    const id = match[1]!;
    const action = match[2];
    const task = await allowedTask(id);
    if (!task) { json(404, { error: "not-found" }); return true; }
    if (!action && method === "PATCH") {
      const input = inputOf(await body());
      if (!(await validateTarget(input, task.projectId))) { json(404, { error: "not-found" }); return true; }
      json(200, deps.schedule.update(id, input));
      return true;
    }
    if (!action && method === "DELETE") { json(200, { ok: deps.schedule.remove(id) }); return true; }
    if (method === "GET" && action === "runs") { json(200, deps.schedule.runsOf(id, Number(url.searchParams.get("limit") ?? 50))); return true; }
    if (method === "POST" && (action === "pause" || action === "resume")) { json(200, deps.schedule.setEnabled(id, action === "resume")); return true; }
    if (method === "POST" && action === "run") { json(200, await deps.schedule.runNow(id)); return true; }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const schedule = createScheduleService({
    file: join(host.storageDir, "schedule.json"),
    runner: {
      run: async (task, runId) => {
        if (task.source === "loop-file") {
          const project = await host.projects.get(task.projectId);
          if (!project || !task.sourcePath || !task.loopId) {
            throw Object.assign(new Error("managed loop project/source is unavailable"), { code: "content-trust-changed" });
          }
          const current = scanLoopsDir(project.path).find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
          const owningSpaceId = project.spaceId ?? task.trustReceipt?.spaceId ?? "";
          assertLoopExecutionTrusted(task, current, owningSpaceId);
        }
        const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");
        let sessionId: string | undefined;
        if (mode === "existing-session") {
          sessionId = task.target?.sessionId ?? task.sessionId;
          if (!sessionId || !(await host.store.projection(sessionId))) throw Object.assign(new Error("target session no longer exists"), { code: "not-found" });
        } else if (mode === "dedicated-session") {
          if (task.lastSessionId && (await host.store.projection(task.lastSessionId))) sessionId = task.lastSessionId;
        }

        let sessions = sessionId ? await systemSessionsForSession(host, sessionId) : await systemSessionsForProject(host, task.projectId);
        if (!sessionId) {
          const ref = await sessions.create({ projectId: task.projectId, title: task.title ?? `Scheduled: ${task.prompt.slice(0, 48)}` });
          sessionId = ref.id;
          sessions = await systemSessionsForSession(host, sessionId);
        }
        await systemAppendSessionEvent(host, sessionId, "schedule/run-started", {
          taskId: task.id,
          runId,
          ...(task.title ? { taskTitle: task.title } : {}),
          ...(task.source === "loop-file" ? { source: "loop-file", ...(task.loopId ? { loopId: task.loopId } : {}) } : {}),
        }, { ignorable: true, producerPlugin: "schedule" });
        await sessions.send(sessionId, { text: task.prompt });
        return { sessionId };
      },
    },
  });
  host.services.provide(serverServiceKey<ScheduleService>("schedule"), schedule);
  let routes: RouteHandler | null = null;
  let loopTimer: ReturnType<typeof setInterval> | null = null;
  const loopSync = async () => {
    for (const project of await host.projects.list()) {
      try { schedule.syncLoops(project.id, scanLoopsDir(project.path)); } catch { /* keep scanning other projects */ }
    }
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["schedule"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= scheduleRoutes({ schedule, forSpace: host.forSpace });
      schedule.start();
      void loopSync();
      if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
      loopTimer = setInterval(() => void loopSync(), 60_000);
      loopTimer.unref?.();
    },
    onDisable() {
      schedule.stop();
      if (loopTimer) clearInterval(loopTimer);
      loopTimer = null;
    },
  };
}
