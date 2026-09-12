import type { RouteHandler } from "../http.ts";
import type { NotificationStore } from "../notifications.ts";

const MAX_IDS = 200;
const MAX_ID_CHARS = 128;
const invalid = (field: string, message: string): Error => Object.assign(new Error(message), { code: "invalid-input", field });
const accountOf = (rc: Parameters<RouteHandler>[0]) => ({ userId: rc.space.userId, spaceId: rc.space.spaceId });

function parseAfter(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw invalid("after", "after must be a non-negative integer timestamp");
  return n;
}

function parseIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw invalid("ids", "ids must be an array of notification ids");
  if (raw.length > MAX_IDS) throw invalid("ids", `ids accepts at most ${MAX_IDS} entries`);
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
      throw invalid("ids", `ids must be non-empty strings of at most ${MAX_ID_CHARS} characters`);
    }
  }
  return raw as string[];
}

export function notificationRoutes(notifications: NotificationStore): RouteHandler {
  return async (rc) => {
    if (rc.path !== "/api/notifications" && !rc.path.startsWith("/api/notifications/")) return false;
    const account = accountOf(rc);
    if (rc.path === "/api/notifications" && rc.method === "GET") {
      rc.json(200, await notifications.list(account, parseAfter(rc.url.searchParams.get("after"))));
      return true;
    }
    const byId = rc.path.match(/^\/api\/notifications\/([^/]+)$/);
    if (byId && rc.method === "GET") {
      const record = await notifications.get(account, byId[1]!);
      if (!record) rc.json(404, { error: "not-found", message: "notification not found" });
      else rc.json(200, record);
      return true;
    }
    if (rc.path === "/api/notifications/read" && rc.method === "POST") {
      rc.json(200, await notifications.read(account, parseIds((await rc.body()).ids)));
      return true;
    }
    if (rc.path === "/api/notifications/read-all" && rc.method === "POST") {
      rc.json(200, await notifications.readAll(account));
      return true;
    }
    if (rc.path === "/api/notifications/clear" && rc.method === "POST") {
      rc.json(200, await notifications.clear(account));
      return true;
    }
    return false;
  };
}
