import type { RouteHandler } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { GoalService } from "./index.ts";

export function goalRoutes(goals: GoalService): RouteHandler {
  return async ({ path, method, body, json }) => {
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
      }));
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
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const goals = host.services.require(serverServiceKey<GoalService>("goals"));
      const goalRoute = goalRoutes(goals);
      routes ??= async (request) => {
        const match = request.path.match(/^\/api\/sessions\/([^/]+)\/goal(?:\/|$)/);
        if (match && !goals.get(match[1]!)) {
          await goals.rehydrate(match[1]!, await host.store.events(match[1]!));
        }
        return goalRoute(request);
      };
    },
  };
}
