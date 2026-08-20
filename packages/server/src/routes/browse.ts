// Host directory browsing for the project folder picker. This surface can
// list any directory the server user can read, so it is localhost-only —
// the same trust boundary as /api/system/info's data-dir label. Blocked
// pseudo-filesystems are refused inside @polyth/files.
import { browseHost, mkdirHost } from "@polyth/files";
import type { RouteHandler } from "../http.ts";

const isLocal = (addr: string | undefined): boolean =>
  !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");

export function browseRoutes(): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;
    if (path !== "/api/browse" && path !== "/api/browse/mkdir") return false;

    if (!isLocal(rc.req.socket.remoteAddress)) {
      rc.json(403, { error: "forbidden", message: "host browsing is available on localhost only" });
      return true;
    }

    if (path === "/api/browse" && method === "GET") {
      rc.json(200, await browseHost(
        rc.url.searchParams.get("path"),
        { hidden: rc.url.searchParams.get("hidden") === "true" },
      ));
      return true;
    }

    if (path === "/api/browse/mkdir" && method === "POST") {
      const b = await rc.body();
      const target = String(b.path ?? "").trim();
      if (!target) throw Object.assign(new Error("path required"), { code: "invalid-input" });
      rc.json(200, await mkdirHost(target));
      return true;
    }

    return false;
  };
}
