import type { SessionService } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

/** Keeps a queue item from dispatching while its text is open in the composer. */
export function queueRoutes(sessions: SessionService): RouteHandler {
  return async ({ path, method, body, json }) => {
    const sendNow = path.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)\/edit\/send-now$/);
    if (sendNow && method === "POST") {
      if (!sessions.queueSendNow) throw Object.assign(new Error("queue editing unavailable"), { code: "unsupported" });
      const input = await body();
      if (typeof input.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "invalid-input" });
      json(200, await sessions.queueSendNow(sendNow[1]!, sendNow[2]!, input.text));
      return true;
    }
    const match = path.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)\/edit$/);
    if (!match) return false;
    const sessionId = match[1]!;
    const queueId = match[2]!;
    if (method === "POST") {
      if (!sessions.queueEditStart) throw Object.assign(new Error("queue editing unavailable"), { code: "unsupported" });
      json(200, await sessions.queueEditStart(sessionId, queueId));
      return true;
    }
    if (method === "DELETE") {
      if (!sessions.queueEditCancel) throw Object.assign(new Error("queue editing unavailable"), { code: "unsupported" });
      await sessions.queueEditCancel(sessionId, queueId);
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}
