import type { RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  systemAppendSessionEvent,
  systemSessionsForSession,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { JUDGMENT_SERVICE, type JudgmentService } from "@polyth/judgment/server";
import { createGoalJudgmentAudit, createGoalService, GOAL_AUDIT_USE, type GoalService, type GoalState } from "./index.ts";
import { createGoalContextReader, latestGoalEvent } from "./sessionContext.ts";

export function goalRoutes(goals: GoalService): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    const match = path.match(
      /^\/api\/sessions\/([^/]+)\/goal(?:\/(pause|resume|stop))?$/,
    );
    if (!match) return false;
    const sessionId = match[1]!;
    const action = match[2];
    if (!action && method === "GET") {
      json(200, goals.get(sessionId));
      return true;
    }
    if (!action && method === "POST") {
      const input = await body();
      json(200, await goals.attach(sessionId, {
        objective: String(input.objective ?? ""),
        ...(input.budgetTokens !== undefined
          ? { budgetTokens: Number(input.budgetTokens) }
          : {}),
        ...(input.maxContinuations !== undefined
          ? { maxContinuations: Number(input.maxContinuations) }
          : {}),
      }, rc.space.userId));
      return true;
    }
    if (action && method === "POST") {
      if (action === "stop") {
        await goals.stop(sessionId);
        json(200, { ok: true });
        return true;
      }
      json(200, action === "pause"
        ? await goals.pause(sessionId)
        : await goals.resume(sessionId));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let enabled = false;
  // The typed audit use registers on enable, or lazily on the first audit when
  // Judgment enabled later. Without Judgment the original auditor runs.
  let registered: { service: JudgmentService; off: () => void } | undefined;
  const judgment = (): JudgmentService | undefined => {
    const service = enabled ? host.services.get(JUDGMENT_SERVICE) : undefined;
    if (registered && registered.service !== service) {
      registered.off();
      registered = undefined;
    }
    if (service && !registered) {
      try {
        registered = { service, off: service.registerUse(GOAL_AUDIT_USE) };
      } catch (error) {
        console.warn("[polyth] goals: Judgment use registration failed", error);
      }
    }
    return service;
  };
  const context = createGoalContextReader({
    store: host.store,
    admit: async (sessionId) => (await systemSessionsForSession(host, sessionId)).snapshot(sessionId),
    goal: async (sessionId) => {
      const known = goals.get(sessionId);
      if (known) return known;
      const types = ["goal/attached", "goal/audit", "goal/paused", "goal/resumed", "goal/stopped", "goal/stuck", "goal/completed"];
      const last = await latestGoalEvent(host.store, sessionId, types);
      return !last || last.type === "goal/stopped" ? null : last.data as unknown as Pick<GoalState, "status" | "lastVerdict">;
    },
    queued: async (sessionId) => ((await (await systemSessionsForSession(host, sessionId)).queueList?.(sessionId)) ?? []).length > 0,
  });
  const goals = createGoalService({
    enabled: () => enabled,
    context: context.context,
    related: (sessionId) => host.deployment === "local-trusted" ? context.related(sessionId) : Promise.resolve([]),
    waiting: async () => {
      if (host.deployment !== "local-trusted") return [];
      const entries = [];
      for (const project of await host.projects.list()) {
        if (!project.spaceId) continue;
        for (const row of await host.store.projections(project.id, { spaceId: project.spaceId })) {
          if (row.status === "archived" || !(await host.store.hasEventOfType?.(row.id, "goal/attached"))) continue;
          const events = await host.store.events(row.id);
          const last = events.findLast((event) => event.type.startsWith("goal/") && event.type !== "goal/context-restored" && event.type !== "goal/continuation-admitted");
          if ((Array.isArray(last?.data.waitingFor) && last.data.waitingFor.length > 0) || last?.data.pendingContinuation) entries.push({ sessionId: row.id, events });
        }
      }
      return entries;
    },
    append: (sessionId, type, data) =>
      systemAppendSessionEvent(host, sessionId, type, data, { ignorable: true }),
    send: async (sessionId, text, operationId) =>
      (await systemSessionsForSession(host, sessionId)).send(sessionId, {
        text, ...(operationId ? { clientOperationId: operationId } : {}),
      }),
    judge: createGoalJudgmentAudit({
      judgment,
      context: async (sessionId) => {
        const projection = await host.store.projection(sessionId);
        if (!projection?.spaceId || !projection.projectId) return undefined;
        return { space: host.systemSpaceContext(projection.spaceId), projectId: projection.projectId };
      },
    }),
    complete: async (sessionId, prompt, userId) => {
      const proj = await host.store.projection(sessionId);
      const project = proj ? await host.projects.get(proj.projectId) : null;
      const model = host.smallModel(userId);
      const harnessId = model?.harnessId ?? (model ? undefined : proj?.resolvedHarnessId);
      const rt = await host.runtimes.forProject(proj?.projectId ?? "__default__", project?.path, harnessId);
      return host.oneShot(rt, {
        cwd: project?.path ?? process.cwd(),
        prompt,
        ...(model
          ? { model }
          : proj?.model ? { model: proj.model } : {}),
      });
    },
  });
  host.services.provide(serverServiceKey<GoalService>("goals"), goals);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["goals"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      enabled = true;
      judgment();
      const goalRoute = goalRoutes(goals);
      routes ??= async (request) => {
        const match = request.path.match(/^\/api\/sessions\/([^/]+)\/goal(?:\/|$)/);
        if (match) {
          const sessionId = match[1]!;
          const projection = await host.forSpace(request.space).sessions.snapshot(sessionId);
          if (request.method !== "GET" && projection.status === "archived") {
            throw Object.assign(new Error("archived sessions are read-only"), { code: "conflict" });
          }
          if (!goals.get(sessionId)) {
            await goals.rehydrate(sessionId, await host.store.events(sessionId));
          }
        }
        return goalRoute(request);
      };
      void goals.recoverWaiting().catch((error) => console.error("[polyth] goal dependency enable recovery failed", error));
    },
    onDisable() {
      enabled = false;
      registered?.off();
      registered = undefined;
      goals.invalidateAudits();
      routes = null;
    },
  };
}
