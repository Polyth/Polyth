// F18 web push routes. All behind the auth gate like the rest of /api: only
// an authorized page can register its own browser subscription. The public
// VAPID key is not a secret, but there is no reason to hand it out unauthed.
import type { RouteHandler } from "../http.ts";
import type { PushService } from "../push.ts";
import { buildPushPayload } from "../push.ts";

export function pushRoutes(push: PushService): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;
    if (!path.startsWith("/api/push/")) return false;

    if (path === "/api/push/key" && method === "GET") {
      rc.json(200, { publicKey: push.publicKey(), subscriptions: push.count() });
      return true;
    }
    if (path === "/api/push/subscribe" && method === "POST") {
      const b = await rc.body();
      push.subscribe(b);
      rc.json(200, { ok: true, subscriptions: push.count() });
      return true;
    }
    if (path === "/api/push/subscribe" && method === "DELETE") {
      const b = await rc.body();
      const removed = push.unsubscribe(String(b.endpoint ?? ""));
      rc.json(200, { ok: removed, subscriptions: push.count() });
      return true;
    }
    if (path === "/api/push/test" && method === "POST") {
      const r = await push.send(buildPushPayload("completed", {
        sessionId: "",
        sessionTitle: "Test notification",
        statusText: "push is working",
      }));
      rc.json(200, r);
      return true;
    }
    return false;
  };
}
