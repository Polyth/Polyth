// NTF-01 notification-centre routes. Thin feature route over the server-owned
// inbox store: list with an `after` cursor, mark-read, read-all, clear. All
// routes sit behind the centralized /api auth gate. Mutation bodies carry
// opaque notification ids ONLY — a caller can never supply a project/session
// scope; the writer takes those from trusted projections at record time.
import type { RouteHandler } from "../http.ts";
import type { NotificationStore } from "../notifications.ts";

const MAX_IDS = 200;
const MAX_ID_CHARS = 128;

const invalid = (field: string, message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input", field });

/** `after` must be a finite, non-negative integer; missing means 0. */
function parseAfter(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw invalid("after", "after must be a non-negative integer timestamp");
  return n;
}

/** Up to 200 non-empty strings of at most 128 chars; [] is a valid no-op. */
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
    if (rc.path === "/api/notifications" && rc.method === "GET") {
      rc.json(200, await notifications.list(parseAfter(rc.url.searchParams.get("after"))));
      return true;
    }
    if (rc.path === "/api/notifications/read" && rc.method === "POST") {
      rc.json(200, await notifications.read(parseIds((await rc.body()).ids)));
      return true;
    }
    if (rc.path === "/api/notifications/read-all" && rc.method === "POST") {
      rc.json(200, await notifications.readAll());
      return true;
    }
    if (rc.path === "/api/notifications/clear" && rc.method === "POST") {
      rc.json(200, await notifications.clear());
      return true;
    }
    return false;
  };
}
