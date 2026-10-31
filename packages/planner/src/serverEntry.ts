import { join } from "node:path";
import type { AgentCapabilityContributionRegistry, Disposable, RouteHandler } from "@polyth/contracts";
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
  createPlannerService,
  PLANNER_RUN_STARTED_EVENT,
  plannerExecutionSelection,
  plannerTurnAdmission,
  settlePlannedRun,
  type CatchUpPolicy,
  type PlannerCadence,
  type PlannerExecutionModel,
  type PlannerRunner,
  type PlannerService,
  type PlannerTarget,
  type PlannerTaskInput,
} from "./index.ts";
import { PLANNER_PACKAGE_ID } from "./packageId.ts";
import { createPlannerAgentTool } from "./agentTool.ts";

export { PLANNER_PACKAGE_ID };

const cadenceOf = (raw: unknown): PlannerCadence | undefined => {
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

const targetOf = (raw: unknown): PlannerTarget | undefined => {
  const target = raw as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") return undefined;
  if (target.mode !== "existing-session" && target.mode !== "new-session-per-run" && target.mode !== "dedicated-session") return undefined;
  return {
    mode: target.mode,
    ...(target.sessionId ? { sessionId: String(target.sessionId) } : {}),
    ...(target.worktreePolicy === "fresh-worktree" ? { worktreePolicy: "fresh-worktree" as const } : {}),
  };
};

const modelOf = (raw: unknown): PlannerExecutionModel | undefined => {
  const model = raw as Record<string, unknown> | undefined;
  if (!model || typeof model !== "object") return undefined;
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : "";
  const modelID = typeof model.modelID === "string" ? model.modelID.trim() : "";
  if (!providerID || !modelID) return undefined;
  return {
    providerID,
    modelID,
    ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {}),
    ...(typeof model.harnessId === "string" && model.harnessId ? { harnessId: model.harnessId } : {}),
  };
};

const harnessOf = (raw: unknown): { mode: "auto" } | { mode: "pinned"; harnessId: string } | undefined => {
  const harness = raw as Record<string, unknown> | undefined;
  if (!harness || typeof harness !== "object") return undefined;
  if (harness.mode === "auto") return { mode: "auto" };
  if (harness.mode === "pinned" && typeof harness.harnessId === "string" && harness.harnessId.trim()) {
    return { mode: "pinned", harnessId: harness.harnessId.trim() };
  }
  return undefined;
};

/** Request body → service input. Ownership and Space never come from input. */
export function plannerInputOf(input: Record<string, unknown>): Partial<PlannerTaskInput> {
  const model = input.model === null ? null : modelOf(input.model);
  const harness = input.harness === null ? null : harnessOf(input.harness);
  const cadence = cadenceOf(input.cadence);
  const target = targetOf(input.target);
  return {
    ...(input.projectId !== undefined ? { projectId: String(input.projectId) } : {}),
    ...(input.prompt !== undefined ? { prompt: String(input.prompt) } : {}),
    ...(input.kind === "at" || input.kind === "every" || input.kind === "cron" ? { kind: input.kind } : {}),
    ...(input.at !== undefined ? { at: Number(input.at) } : {}),
    ...(input.everyMinutes !== undefined ? { everyMinutes: Number(input.everyMinutes) } : {}),
    ...(cadence ? { cadence } : {}),
    ...(target ? { target } : {}),
    ...(input.overlapPolicy === "skip" || input.overlapPolicy === "queue" || input.overlapPolicy === "parallel" ? { overlapPolicy: input.overlapPolicy } : {}),
    ...(input.catchUp === "once" || input.catchUp === "skip" ? { catchUp: input.catchUp as CatchUpPolicy } : {}),
    ...(input.sessionId !== undefined && input.sessionId !== "" ? { sessionId: String(input.sessionId) } : {}),
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(harness !== undefined ? { harness } : {}),
  };
}

export function plannerRoutes(deps: {
  planner: PlannerService;
  forSpace: ServerPackageHost["forSpace"];
}): RouteHandler {
  return async (rc) => {
    const { path, method, url, body, json } = rc;
    if (path !== "/api/planner" && !path.startsWith("/api/planner/")) return false;
    const scoped = deps.forSpace(rc.space);
    const project = async (projectId: string) => scoped.projects.get(projectId);
    // A task recorded under another Space is foreign even if a project id
    // happens to resolve here.
    const inSpace = (task: { spaceId?: string }) => !task.spaceId || task.spaceId === rc.space.spaceId;
    const allowedTask = async (id: string) => {
      const task = deps.planner.get(id);
      if (!task || !inSpace(task) || !(await project(task.projectId))) return undefined;
      return task;
    };
    const validateTarget = async (input: Partial<PlannerTaskInput>, fallbackProjectId?: string): Promise<boolean> => {
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

    if (path === "/api/planner" && method === "GET") {
      const requested = url.searchParams.get("projectId") ?? undefined;
      if (requested && !(await project(requested))) {
        json(200, { tasks: [] });
        return true;
      }
      const allowedIds = requested
        ? new Set([requested])
        : new Set((await scoped.projects.list()).map((item) => item.id));
      json(200, {
        tasks: deps.planner.list(requested).filter((task) => allowedIds.has(task.projectId) && inSpace(task)),
      });
      return true;
    }
    if (path === "/api/planner" && method === "POST") {
      const { ownerUserId: _callerOwner, spaceId: _callerSpace, ...input } = plannerInputOf(await body()) as PlannerTaskInput;
      if (!(await validateTarget(input))) {
        json(404, { error: "not-found", message: "project or target session not found" });
        return true;
      }
      // The signed-in person owns the task; its runs act for them.
      const person = rc.space.userId && !rc.space.userId.startsWith("system:")
        && (rc.space as { authority?: { kind?: unknown } }).authority?.kind !== "system";
      json(200, deps.planner.create({
        ...input,
        spaceId: rc.space.spaceId,
        ...(person ? { ownerUserId: rc.space.userId } : {}),
      }));
      return true;
    }
    if (path === "/api/planner/preview" && method === "POST") {
      const input = await body();
      const cadence = cadenceOf(input.cadence);
      if (!cadence) { json(400, { error: "invalid-input", message: "cadence is required" }); return true; }
      json(200, deps.planner.preview(cadence, input.count !== undefined ? Number(input.count) : 5));
      return true;
    }

    const match = path.match(/^\/api\/planner\/([^/]+)(?:\/(pause|resume|run|runs))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    const task = await allowedTask(id);
    if (!task) { json(404, { error: "not-found" }); return true; }
    if (!action && method === "GET") { json(200, task); return true; }
    if (!action && method === "PATCH") {
      const { ownerUserId: _callerOwner, spaceId: _callerSpace, ...input } = plannerInputOf(await body());
      if (!(await validateTarget(input, task.projectId))) { json(404, { error: "not-found" }); return true; }
      json(200, deps.planner.update(id, { ...input, spaceId: rc.space.spaceId }));
      return true;
    }
    if (!action && method === "DELETE") { json(200, { ok: deps.planner.remove(id) }); return true; }
    if (method === "GET" && action === "runs") { json(200, deps.planner.runsOf(id, Number(url.searchParams.get("limit") ?? 50))); return true; }
    if (method === "POST" && (action === "pause" || action === "resume")) { json(200, deps.planner.setEnabled(id, action === "resume")); return true; }
    if (method === "POST" && action === "run") { json(200, await deps.planner.runNow(id)); return true; }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // projectId -> owning Space; refreshed from the canonical project list.
  const projectSpaces = new Map<string, string>();
  const rememberProjects = (projects: Array<{ id: string; spaceId?: string }>): void => {
    for (const project of projects) if (project.spaceId) projectSpaces.set(project.id, project.spaceId);
  };
  const spaceFile = (spaceId: string): string =>
    join(host.spaceStorage(host.systemSpaceContext(spaceId)).packageDir(PLANNER_PACKAGE_ID), "planner.json");

  const runner: PlannerRunner = {
    run: async (task, runId) => {
      const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");
      const execution = plannerExecutionSelection(task);
      let sessionId: string | undefined;
      if (mode === "existing-session") {
        sessionId = task.target?.sessionId ?? task.sessionId;
        if (!sessionId || !(await host.store.projection(sessionId))) throw Object.assign(new Error("target session no longer exists"), { code: "not-found" });
      } else if (mode === "dedicated-session") {
        if (task.lastSessionId && (await host.store.projection(task.lastSessionId))) sessionId = task.lastSessionId;
      }

      let sessions = sessionId ? await systemSessionsForSession(host, sessionId) : await systemSessionsForProject(host, task.projectId);
      if (!sessionId) {
        const ref = await sessions.create({
          projectId: task.projectId,
          title: task.title ?? `Planned: ${task.prompt.slice(0, 48)}`,
          ...execution,
        });
        sessionId = ref.id;
        sessions = await systemSessionsForSession(host, sessionId);
      }
      const marker = await systemAppendSessionEvent(host, sessionId, PLANNER_RUN_STARTED_EVENT, {
        taskId: task.id,
        runId,
        ...(task.title ? { taskTitle: task.title } : {}),
      }, { ignorable: true, producerPlugin: PLANNER_PACKAGE_ID });
      const sent = await sessions.send(sessionId, { text: task.prompt, ...execution }, plannerTurnAdmission(task));
      return {
        sessionId,
        markerSeq: marker.seq,
        ...(sent?.queued && sent.queueId ? { queueId: sent.queueId } : {}),
        ...(sent?.turnId ? { turnId: sent.turnId } : {}),
      };
    },
    settle: (_task, run, signal) => settlePlannedRun(run, {
      signal,
      events: (sessionId, afterSeq) => host.store.events(sessionId, afterSeq),
    }),
  };

  // Built on first enable: Space documents can only be located once the
  // canonical project list (and therefore every owning Space) is readable.
  let planner: PlannerService | null = null;
  const current = (): PlannerService => {
    if (!planner) throw Object.assign(new Error("planner is not enabled"), { code: "unavailable" });
    return planner;
  };
  const facade = new Proxy({} as PlannerService, {
    get(_target, property) {
      // Shutdown stops every package service, enabled or not.
      if (!planner && (property === "stop" || property === "start")) return () => {};
      const service = current();
      const value = Reflect.get(service, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(service) : value;
    },
  });
  host.services.provide(serverServiceKey<PlannerService>(PLANNER_PACKAGE_ID), facade);
  let routes: RouteHandler | null = null;
  const plannerTool = createPlannerAgentTool({
    planner: facade,
    sessionProject: async (spaceId, sessionId) => {
      try {
        return (await host.forSpace(host.systemSpaceContext(spaceId)).sessions.snapshot(sessionId)).projectId;
      } catch {
        return undefined;
      }
    },
  });
  let capabilities: Disposable[] = [];
  let spaceTimer: ReturnType<typeof setInterval> | null = null;
  // Background refresh: a listing failure must degrade this pass, never crash the server.
  const refreshSpaces = async () => {
    rememberProjects(await host.projects.list().catch(() => []));
    planner?.assignSpaces();
  };
  return {
    remoteAccess: localOnlyRemoteAccess([PLANNER_PACKAGE_ID]),
    routes: async (request) => routes ? routes(request) : false,
    async onEnable() {
      if (!planner) {
        rememberProjects(await host.projects.list().catch(() => []));
        planner = createPlannerService({
          spaceFile,
          spaceIds: [...new Set(projectSpaces.values())],
          spaceOf: (projectId) => projectSpaces.get(projectId),
          runner,
        });
      }
      routes ??= plannerRoutes({ planner: facade, forSpace: host.forSpace });
      planner.start();
      const registry = host.services.get(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      if (registry && capabilities.length === 0) capabilities.push(registry.register(PLANNER_PACKAGE_ID, plannerTool));
      if (spaceTimer) clearInterval(spaceTimer);
      spaceTimer = setInterval(() => void refreshSpaces(), 60_000);
      spaceTimer.unref?.();
    },
    async onDisable() {
      for (const capability of capabilities.toReversed()) await capability.dispose();
      capabilities = [];
      planner?.stop();
      if (spaceTimer) clearInterval(spaceTimer);
      spaceTimer = null;
    },
  };
}
