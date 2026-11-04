import type { NotificationRecord } from "@polyth/contracts";
import type { RouteHandler, RouteRequest } from "../http.ts";
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

const ACTION_SEGMENTS = new Set(["read", "read-all", "clear"]);

/** Projects the caller can open now. A row whose project is outside this set
 *  (access revoked, project removed or limited away) is not shown or counted;
 *  it stays retained, so regaining access brings it back. */
export type VisibleNotificationProjects = (space: RouteRequest["space"]) => Promise<ReadonlySet<string>>;

export function notificationRoutes(notifications: NotificationStore, visibleProjects?: VisibleNotificationProjects): RouteHandler {
  return async (rc) => {
    if (rc.path !== "/api/notifications" && !rc.path.startsWith("/api/notifications/")) return false;
    const account = accountOf(rc);
    const visible = async (): Promise<((record: NotificationRecord) => boolean) | null> => {
      if (!visibleProjects) return null;
      const projects = await visibleProjects(rc.space);
      return (record) => projects.has(record.projectId);
    };
    // The unread counter covers only rows the caller can see.
    const unreadOf = async (shown: (record: NotificationRecord) => boolean): Promise<number> =>
      (await notifications.list(account)).items.reduce((n, r) => n + (!r.read && shown(r) ? 1 : 0), 0);
    if (rc.path === "/api/notifications" && rc.method === "GET") {
      const after = parseAfter(rc.url.searchParams.get("after"));
      const shown = await visible();
      if (!shown) {
        rc.json(200, await notifications.list(account, after));
        return true;
      }
      const all = (await notifications.list(account)).items.filter(shown);
      rc.json(200, {
        items: all.filter((r) => r.ts > after),
        unread: all.reduce((n, r) => n + (r.read ? 0 : 1), 0),
      });
      return true;
    }
    const byId = rc.path.match(/^\/api\/notifications\/([^/]+)$/);
    // Action segments are not notification ids; their other methods fall through.
    if (byId && rc.method === "GET" && !ACTION_SEGMENTS.has(byId[1]!)) {
      const record = await notifications.get(account, byId[1]!);
      const shown = await visible();
      if (!record || (shown && !shown(record))) rc.json(404, { error: "not-found", message: "notification not found" });
      else rc.json(200, record);
      return true;
    }
    const withVisibleUnread = async <T extends { unread: number }>(result: T): Promise<T> => {
      const shown = await visible();
      return shown ? { ...result, unread: await unreadOf(shown) } : result;
    };
    if (rc.path === "/api/notifications/read" && rc.method === "POST") {
      rc.json(200, await withVisibleUnread(await notifications.read(account, parseIds((await rc.body()).ids))));
      return true;
    }
    if (rc.path === "/api/notifications/read-all" && rc.method === "POST") {
      rc.json(200, await withVisibleUnread(await notifications.readAll(account)));
      return true;
    }
    if (rc.path === "/api/notifications/clear" && rc.method === "POST") {
      rc.json(200, await withVisibleUnread(await notifications.clear(account)));
      return true;
    }
    return false;
  };
}
