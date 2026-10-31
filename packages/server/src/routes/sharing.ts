// Session sharing (Spaces §14.3): who can open one chat, and the current
// Space's sharing policy. `rc.space` is the gateway-validated context; a chat
// outside it, or one the caller cannot open, answers not-found.
import type { SessionSharingUpdate } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { SessionSharingService } from "../sessionSharing.ts";

export function sharingRoutes(sharing: SessionSharingService): RouteHandler {
  return async (rc) => {
    const { path, method, body, json } = rc;
    const session = path.match(/^\/api\/sessions\/([^/]+)\/sharing$/);
    if (session) {
      if (method === "GET") {
        json(200, sharing.state(rc.space, session[1]!));
        return true;
      }
      if (method === "PUT") {
        json(200, await sharing.update(rc.space, session[1]!, await body() as SessionSharingUpdate));
        return true;
      }
      return false;
    }
    if (path === "/api/sharing/policy") {
      if (method === "GET") {
        json(200, sharing.policy(rc.space));
        return true;
      }
      if (method === "PUT") {
        json(200, sharing.setPolicy(rc.space, await body()));
        return true;
      }
    }
    return false;
  };
}
