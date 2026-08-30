// Host directory browsing for the project folder picker. This surface lists
// directories on the host where the server is running. Blocked
// pseudo-filesystems are refused inside @polyth/files.
import { browseHost, mkdirHost } from "@polyth/files";
import type { RouteHandler } from "../http.ts";

export function browseRoutes(): RouteHandler {
  return async (rc) => {
    const { path, method } = rc;
    if (path !== "/api/browse" && path !== "/api/browse/mkdir") return false;

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
