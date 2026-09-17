import type { RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  systemAppendSessionEvent,
  systemSessionsForSession,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createGoalService, type GoalService } from "./index.ts";

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
  const goals = createGoalService({
    append: (sessionId, type, data) =>
      systemAppendSessionEvent(host, sessionId, type, data, { ignorable: true }),
    send: async (sessionId, text) =>
      (await systemSessionsForSession(host, sessionId)).send(sessionId, { text }),
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
    },
  };
}
