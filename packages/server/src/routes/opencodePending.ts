import type {
  OpenCodeApplyRestartResponseDto,
  OpenCodePendingResponseDto,
} from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { OpenCodePendingService } from "../opencodePending.ts";

export function opencodePendingRoutes(pending: OpenCodePendingService): RouteHandler {
  return async (request) => {
    const { path, method, json } = request;
    if (path !== "/api/opencode/pending" && path !== "/api/opencode/apply-restart") return false;
    const { space } = request;
    // Local single-user only. Hosted/server-trusted must not list or apply
    // a deployment-global restart queue that can embed another Space's cwd.
    if (space.deployment !== "local-trusted") {
      throw Object.assign(new Error("not found"), { code: "not-found" });
    }
    if (path === "/api/opencode/pending" && method === "GET") {
      const response: OpenCodePendingResponseDto = pending.list();
      json(200, response);
      return true;
    }
    if (path === "/api/opencode/apply-restart" && method === "POST") {
      const response: OpenCodeApplyRestartResponseDto = await pending.applyAndRestart();
      json(200, response);
      return true;
    }
    return false;
  };
}
