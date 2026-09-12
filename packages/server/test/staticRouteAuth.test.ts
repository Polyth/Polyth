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
import { pushRoutes } from "../src/routes/push.ts";
import { notificationRoutes } from "../src/routes/notifications.ts";
import { nativePushRoutes } from "../src/nativePush.ts";
import registerBrowserPackage from "../../browser/src/serverEntry.ts";
import { fusionRoutes } from "../../fusion/src/serverEntry.ts";
import { goalRoutes } from "../../goals/src/serverEntry.ts";
import { walkthroughRoutes } from "../../walkthrough/src/serverEntry.ts";
import { gitRoutes } from "../../git/src/serverEntry.ts";

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
    ["push", pushRoutes({} as never)],
    ["native push", nativePushRoutes({} as never)],
    ["notifications", notificationRoutes({} as never)],
    ["fusion", fusionRoutes({} as never)],
    ["goals", goalRoutes({} as never)],
    ["walkthrough", walkthroughRoutes({ store: {} as never, broadcast: {} as never })],
    ["git", gitRoutes({ projects: {} as never } as never)],
  ];

  for (const [owner, route] of routes) {
    assert.equal(await route(staticRequest()), false, `${owner} must not claim or authorize the SPA shell`);
  }
});

test("browser package route declines the public SPA shell before resolving Space", async () => {
  const previousFakeBrowser = process.env.POLYTH_FAKE_BROWSER;
  process.env.POLYTH_FAKE_BROWSER = "1";
  try {
    const packageHost = {
      events: { append: async () => ({}) },
      services: {
        provide() {},
        require: () => ({ register: () => ({ dispose() {} }) }),
      },
      forSpace() { throw new Error("Space must not resolve for the SPA shell"); },
      spaceStorage() { throw new Error("Space storage must not resolve for the SPA shell"); },
    } as never;
    const pkg = await registerBrowserPackage(packageHost);
    await pkg.onEnable?.();
    assert.equal(await pkg.routes(staticRequest()), false);
    await pkg.onDisable?.();
  } finally {
    if (previousFakeBrowser === undefined) delete process.env.POLYTH_FAKE_BROWSER;
    else process.env.POLYTH_FAKE_BROWSER = previousFakeBrowser;
  }
});
