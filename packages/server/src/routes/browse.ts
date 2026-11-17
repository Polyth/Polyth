// Host directory browsing for the project folder picker. This surface lists
// directories on the host where the server is running. Blocked
// pseudo-filesystems are refused inside @polyth/files.
//
// It is a TRUSTED-DEPLOYMENT affordance: browsing the server's filesystem is
// exactly what a hosted, multi-tenant deployment must not offer, so the
// deployment profile — not a per-request flag — decides whether it exists.
import { allowsHostFilesystemBrowsing } from "@polyth/contracts";
import { browseHost, discoverRepositories, mkdirHost, statHost } from "@polyth/files";
import { AGENT_BETA_READ_ONLY_MESSAGE, agentBetaEnabled } from "@polyth/harness-runtime";
import type { RouteHandler } from "../http.ts";

/** `dataDir` holds everyone's private chats and notes, so the picker reads as if
 *  it weren't there (Spaces §14.5). */
export function browseRoutes(dataDir: string): RouteHandler {
  const sealedRoots = [dataDir];
  return async (rc) => {
    const { path, method } = rc;
    if (path !== "/api/browse" && path !== "/api/browse/mkdir" && path !== "/api/browse/stat") return false;

    if (!allowsHostFilesystemBrowsing(rc.space.deployment)) {
      throw Object.assign(
        new Error("host filesystem browsing is disabled in this deployment"),
        { code: "unsupported" },
      );
    }

    if (path === "/api/browse" && method === "GET") {
      if (rc.url.searchParams.get("repositories") === "true") {
        const selected = rc.url.searchParams.get("path");
        if (!selected) throw Object.assign(new Error("path required"), { code: "invalid-input" });
        await browseHost(selected, { sealedRoots });
        rc.json(200, await discoverRepositories(selected));
        return true;
      }
      rc.json(200, await browseHost(
        rc.url.searchParams.get("path"),
        { hidden: rc.url.searchParams.get("hidden") === "true", sealedRoots },
      ));
      return true;
    }

    // The composer asks whether a path typed or pasted into a message names a
    // file here, so it can show a file instead of command suggestions. Absence
    // is an answer (null), not an error, and so is everything the picker refuses.
    if (path === "/api/browse/stat" && method === "GET") {
      rc.json(200, await statHost(rc.url.searchParams.get("path") ?? "", { sealedRoots }));
      return true;
    }

    if (path === "/api/browse/mkdir" && method === "POST") {
      if (agentBetaEnabled()) {
        rc.json(403, { error: { code: "forbidden", message: AGENT_BETA_READ_ONLY_MESSAGE } });
        return true;
      }
      const b = await rc.body();
      const target = String(b.path ?? "").trim();
      if (!target) throw Object.assign(new Error("path required"), { code: "invalid-input" });
      rc.json(200, await mkdirHost(target, { sealedRoots }));
      return true;
    }

    return false;
  };
}
