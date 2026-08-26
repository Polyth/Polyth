import { join } from "node:path";
import type { RouteHandler, SessionService } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createAutoAcceptStore,
  createPermissionService,
  type AutoAcceptStore,
  type PermissionService,
} from "./index.ts";

export function autoAcceptRoutes(sessions: SessionService): RouteHandler {
  return async (request) => {
    const match = request.path.match(
      /^\/api\/sessions\/([^/]+)\/permissions\/auto-accept$/,
    );
    if (!match) return false;
    const sessionId = match[1]!;
    if (request.method === "GET") {
      if (!sessions.autoAcceptGet) {
        throw Object.assign(new Error("auto-accept unavailable"), {
          code: "unsupported",
        });
      }
      request.json(200, await sessions.autoAcceptGet(sessionId));
      return true;
    }
    if (request.method === "PATCH") {
      if (!sessions.autoAcceptSet) {
        throw Object.assign(new Error("auto-accept unavailable"), {
          code: "unsupported",
        });
      }
      const input = await request.body();
      const setting = input.setting;
      if (setting !== "on" && setting !== "off" && setting !== "inherit") {
        throw Object.assign(
          new Error("setting must be on, off, or inherit"),
          { code: "invalid-input" },
        );
      }
      request.json(200, await sessions.autoAcceptSet(sessionId, setting));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Shared instances the session service depends on are created here (not in
  // the composition root) and published at load time, so they exist even
  // while this package's routes are disabled.
  host.services.provide(
    serverServiceKey<PermissionService>("permissions"),
    createPermissionService(host.storageDir),
  );
  host.services.provide(
    serverServiceKey<AutoAcceptStore>("permissions.auto-accept"),
    createAutoAcceptStore(join(host.storageDir, "auto-accept.json")),
  );
  return { routes: autoAcceptRoutes(host.sessions) };
}
