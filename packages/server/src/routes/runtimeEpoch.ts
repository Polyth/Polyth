import type { SessionService } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

const CONFLICT_CODES = new Set([
  "conflict",
  "confirmation-required",
  "epoch-proof-required",
]);

export function runtimeEpochRoutes(sessions: SessionService): RouteHandler {
  return async ({ path, method, body, json }) => {
    const match = path.match(/^\/api\/sessions\/([^/]+)\/runtime-epoch$/);
    if (!match || method !== "POST") return false;
    const sessionId = decodeURIComponent(match[1]!);
    if (!sessions.confirmBorrowedRuntimeEpoch) {
      throw Object.assign(new Error("runtime epoch confirmation is unavailable"), {
        code: "unsupported",
      });
    }
    const payload = await body();
    if (payload.confirm !== true) {
      throw Object.assign(new Error("confirm must be true"), { code: "invalid-input" });
    }
    try {
      json(200, await sessions.confirmBorrowedRuntimeEpoch(sessionId));
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "not-found") {
        json(404, { error: code, message });
        return true;
      }
      if (code && CONFLICT_CODES.has(code)) {
        json(409, { error: code, message });
        return true;
      }
      throw error;
    }
    return true;
  };
}
