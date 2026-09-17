import { join } from "node:path";
import type { ProjectService, RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
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
  if (cadence.kind === "every") {
    return { kind: "every", everyMinutes: Number(cadence.everyMinutes) };
  }
  if (cadence.kind === "cron") {
    return {
      kind: "cron",
      expression: String(cadence.expression ?? ""),
      timeZone: String(cadence.timeZone ?? ""),
    };
  }
  return undefined;
};

const targetOf = (raw: unknown): ScheduleTarget | undefined => {
  const target = raw as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") return undefined;
  if (
    target.mode !== "existing-session"
    && target.mode !== "new-session-per-run"
    && target.mode !== "dedicated-session"
  ) return undefined;
  return {
    mode: target.mode,
    ...(target.sessionId ? { sessionId: String(target.sessionId) } : {}),
    ...(target.worktreePolicy === "fresh-worktree"
      ? { worktreePolicy: "fresh-worktree" as const }
      : {}),
  };
};

export function scheduleRoutes(deps: {
  schedule: ScheduleService;
  projects: ProjectService;
}): RouteHandler {
  const inputOf = (input: Record<string, unknown>): Partial<ScheduleTaskInput> => ({
    ...(input.projectId !== undefined ? { projectId: String(input.projectId) } : {}),
    ...(input.prompt !== undefined ? { prompt: String(input.prompt) } : {}),
    ...(input.kind !== undefined ? { kind: input.kind as ScheduleTaskInput["kind"] } : {}),
    ...(input.at !== undefined ? { at: Number(input.at) } : {}),
    ...(input.everyMinutes !== undefined
      ? { everyMinutes: Number(input.everyMinutes) }
      : {}),
    ...(cadenceOf(input.cadence) ? { cadence: cadenceOf(input.cadence)! } : {}),
    ...(targetOf(input.target) ? { target: targetOf(input.target)! } : {}),
    ...(input.overlapPolicy === "skip"
      || input.overlapPolicy === "queue"
      || input.overlapPolicy === "parallel"
      ? { overlapPolicy: input.overlapPolicy }
      : {}),
    ...(input.sessionId !== undefined && input.sessionId !== ""
      ? { sessionId: String(input.sessionId) }
      : {}),
    ...(input.title !== undefined && input.title !== ""
      ? { title: String(input.title) }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
  });

  return async (rc) => {
    const { path, method, url, body, json } = rc;
    if (!path.startsWith("/api/schedule")) return false;
    if (path === "/api/schedule" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      json(200, {
        tasks: deps.schedule.list(projectId),
        loopErrors: deps.schedule.loopErrors(projectId),
      });
      return true;
    }
    if (path === "/api/schedule" && method === "POST") {
      json(200, deps.schedule.create(inputOf(await body()) as ScheduleTaskInput));
      return true;
    }
    if (path === "/api/schedule/preview" && method === "POST") {
      const input = await body();
      const cadence = cadenceOf(input.cadence);
      if (!cadence) {
        json(400, { error: "invalid-input", message: "cadence is required" });
        return true;
      }
      json(200, deps.schedule.preview(
        cadence,
        input.count !== undefined ? Number(input.count) : 5,
      ));
      return true;
    }
    if (path === "/api/schedule/loops" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      json(200, deps.schedule.list(projectId).filter((task) => task.source === "loop-file"));
      return true;
    }
    if (path === "/api/schedule/loops/rescan" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      const project = await deps.projects.get(projectId);
      if (!project || (project.spaceId !== undefined && project.spaceId !== rc.space.spaceId)) {
        json(404, { error: "not-found", message: "project not found" });
        return true;
      }
      json(200, deps.schedule.syncLoops(
        projectId,
        scanLoopsDir(project.path),
        { explicit: true },
      ));
      return true;
    }
    if (path === "/api/schedule/loops/errors/dismiss" && method === "POST") {
      const input = await body();
      json(200, {
        ok: deps.schedule.dismissLoopError(
          String(input.projectId ?? ""),
          String(input.path ?? ""),
        ),
      });
      return true;
    }

    const trustMatch = path.match(/^\/api\/schedule\/([^/]+)\/trust$/);
    if (trustMatch && method === "POST") {
      const id = trustMatch[1]!;
      const task = deps.schedule.get(id);
      if (!task || task.source !== "loop-file" || !task.sourcePath || !task.loopId) {
        json(404, { error: "not-found", message: "managed loop task not found" });
        return true;
      }
      const project = await deps.projects.get(task.projectId);
      if (!project || (project.spaceId !== undefined && project.spaceId !== rc.space.spaceId)) {
        json(404, { error: "not-found", message: "project not found" });
        return true;
      }
      // Re-read at the authorization boundary. A stale UI cannot approve bytes
      // it reviewed earlier if the repository changed again in the meantime.
      const scan = scanLoopsDir(project.path);
      const current = scan.find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
      if (!current?.loop || current.digest !== task.sourceDigest) {
        deps.schedule.syncLoops(task.projectId, scan, { explicit: true });
        json(409, {
          error: "content-trust-changed",
          message: "Loop changed again. Refresh and review the current version.",
        });
        return true;
      }
      const input = await body();
      const action = String(input.action ?? "");
      if (action === "trust-current") {
        json(200, deps.schedule.trustLoopVersion(id, rc.space.spaceId, current));
        return true;
      }
      if (action === "run-once") {
        json(200, await deps.schedule.runLoopVersionOnce(id, rc.space.spaceId, current));
        return true;
      }
      if (action === "reject") {
        json(200, deps.schedule.rejectLoopVersion(id));
        return true;
      }
      json(400, {
        error: "invalid-input",
        message: "action must be trust-current, run-once, or reject",
      });
      return true;
    }

    const match = path.match(
      /^\/api\/schedule\/([^/]+)(?:\/(pause|resume|run|runs))?$/,
    );
    if (!match) return false;
    const id = match[1]!;
    const action = match[2];
    if (!action && method === "PATCH") {
      json(200, deps.schedule.update(id, inputOf(await body())));
      return true;
    }
    if (!action && method === "DELETE") {
      json(200, { ok: deps.schedule.remove(id) });
      return true;
    }
    if (method === "GET" && action === "runs") {
      json(200, deps.schedule.runsOf(
        id,
        Number(url.searchParams.get("limit") ?? 50),
      ));
      return true;
    }
    if (method === "POST" && (action === "pause" || action === "resume")) {
      json(200, deps.schedule.setEnabled(id, action === "resume"));
      return true;
    }
    if (method === "POST" && action === "run") {
      json(200, await deps.schedule.runNow(id));
      return true;
    }
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
          const current = scanLoopsDir(project.path)
            .find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
          const owningSpaceId = project.spaceId ?? task.trustReceipt?.spaceId ?? "";
          assertLoopExecutionTrusted(task, current, owningSpaceId);
        }
        const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");
        let sessionId: string | undefined;
        if (mode === "existing-session") {
          sessionId = task.target?.sessionId ?? task.sessionId;
          if (!sessionId || !(await host.store.projection(sessionId))) {
            throw Object.assign(new Error("target session no longer exists"), { code: "not-found" });
          }
        } else if (mode === "dedicated-session") {
          if (task.lastSessionId && (await host.store.projection(task.lastSessionId))) {
            sessionId = task.lastSessionId;
          }
        }

        let sessions = sessionId
          ? await systemSessionsForSession(host, sessionId)
          : await systemSessionsForProject(host, task.projectId);
        if (!sessionId) {
          const ref = await sessions.create({
            projectId: task.projectId,
            title: task.title ?? `Scheduled: ${task.prompt.slice(0, 48)}`,
          });
          sessionId = ref.id;
          // Route subsequent operations from the durable session itself; this
          // catches any project/Space drift before the run writes its marker.
          sessions = await systemSessionsForSession(host, sessionId);
        }
        const projection = await sessions.snapshot(sessionId);
        if (projection.status === "archived") {
          throw Object.assign(new Error("target session is archived"), { code: "conflict" });
        }
        await host.events.append(sessionId, "schedule/run-started", {
          taskId: task.id, runId,
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
      try {
        schedule.syncLoops(project.id, scanLoopsDir(project.path));
      } catch {
        // An unreadable project directory does not stop other loop scans.
      }
    }
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["schedule"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= scheduleRoutes({ schedule, projects: host.projects });
      schedule.start();
      void loopSync();
      if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = null;
      }
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
