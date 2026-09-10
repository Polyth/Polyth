import test from "node:test";
import assert from "node:assert/strict";
import type { RouteHandler, RouteRequest } from "@polyth/contracts";
import { providerAuthRoutes } from "../../backend-opencode/src/providerAuthRoutes.ts";
import { chatWorkspaceRoutes } from "../../chat-workspace/src/serverEntry.ts";
import { handoffRoutes } from "../../handoff/src/serverEntry.ts";
import { marketsRoutes } from "../../markets/src/serverEntry.ts";
import { managedPluginRoutes } from "../../plugins/src/managedPluginRoutes.ts";
import { createOpenCodePendingService } from "../src/opencodePending.ts";
import { opencodePendingRoutes } from "../src/routes/opencodePending.ts";

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
    ["chat workspace", chatWorkspaceRoutes({} as never)],
    ["handoff", handoffRoutes({} as never)],
    ["markets", marketsRoutes({} as never, {} as never)],
    ["managed plugins", managedPluginRoutes({} as never, {} as never)],
  ];

  for (const [owner, route] of routes) {
    assert.equal(await route(staticRequest()), false, `${owner} must not claim or authorize the SPA shell`);
  }
});
