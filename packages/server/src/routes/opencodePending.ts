import type {
  OpenCodeApplyRestartResponseDto,
  OpenCodePendingResponseDto,
} from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { OpenCodePendingService } from "../opencodePending.ts";

export function opencodePendingRoutes(pending: OpenCodePendingService): RouteHandler {
  return async ({ path, method, json }) => {
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
