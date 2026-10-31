import test from "node:test";
import assert from "node:assert/strict";
import type { RouteHandler, RouteRequest } from "@polyth/contracts";
import { providerAuthRoutes } from "../../backend-opencode/src/providerAuthRoutes.ts";
import { managedPluginRoutes } from "../../plugins/src/managedPluginRoutes.ts";
import { createOpenCodePendingService } from "../src/opencodePending.ts";
import { opencodePendingRoutes } from "../src/routes/opencodePending.ts";
import { pushRoutes } from "../src/routes/push.ts";
import { notificationRoutes } from "../src/routes/notifications.ts";
import { nativePushRoutes } from "../src/nativePush.ts";
import { gitRoutes } from "../../git/src/serverEntry.ts";

// Removable feature packages own their own half of this contract
// (packages/<id>/test/hostStaticRouteAuth.test.ts); this host test keeps the
// server-owned and framework routes.
const staticRequest = (): RouteRequest => ({
  path: "/",
  method: "GET",
  get space(): never {
    throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
  },
} as unknown as RouteRequest);

test("package API routes decline the public SPA shell before resolving Space", async () => {
  const routes: Array<[string, RouteHandler]> = [
    ["OpenCode pending", opencodePendingRoutes(createOpenCodePendingService({ restart: async () => 0 }))],
    ["provider auth", providerAuthRoutes({} as never)],
    ["managed plugins", managedPluginRoutes({} as never, {} as never)],
    ["push", pushRoutes({} as never)],
    ["native push", nativePushRoutes({} as never)],
    ["notifications", notificationRoutes({} as never)],
    ["git", gitRoutes({ projects: {} as never } as never)],
  ];

  for (const [owner, route] of routes) {
    assert.equal(await route(staticRequest()), false, `${owner} must not claim or authorize the SPA shell`);
  }
});
