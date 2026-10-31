import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "@polyth/contracts";
import registerBrowserPackage from "../src/serverEntry.ts";

const staticRequest = (): RouteRequest => ({
  path: "/",
  method: "GET",
  get space(): never {
    throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
  },
} as unknown as RouteRequest);

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
    assert.ok(pkg.routes, "browser package registers routes");
    assert.equal(await pkg.routes(staticRequest()), false);
    await pkg.onDisable?.();
  } finally {
    if (previousFakeBrowser === undefined) delete process.env.POLYTH_FAKE_BROWSER;
    else process.env.POLYTH_FAKE_BROWSER = previousFakeBrowser;
  }
});
