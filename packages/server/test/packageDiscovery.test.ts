import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPackageHost } from "@polyth/plugins";
import type { RouteRequest } from "../src/http.ts";
import { createRouteRegistry } from "../src/routeRegistry.ts";
import { createPackageLifecycle } from "../src/packageLifecycle.ts";
import { registerDiscoveredPackages } from "../src/packageDiscovery.ts";
import { BUILTIN_PACKAGES } from "../src/packages.ts";
import { discoverServerPackages } from "@polyth/plugins";

const writePackage = (
  packagesDir: string,
  dirName: string,
  entrySource: string,
): void => {
  const dir = join(packagesDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: `@polyth/${dirName}`,
    polyth: { serverEntry: "./server.mjs" },
  }));
  writeFileSync(join(dir, "server.mjs"), entrySource);
};

const request = (path: string): RouteRequest =>
  ({ path, method: "GET", url: new URL(`http://polyth.test${path}`) }) as unknown as RouteRequest;

test("discovered packages register lifecycle-owned routes; a broken one is isolated", async () => {
  const packagesDir = mkdtempSync(join(tmpdir(), "polyth-discovery-"));
  writePackage(packagesDir, "gadget", `
    let enabled = 0;
    export default (host) => ({
      routes: async (rc) => rc.path === "/api/gadget/" + host.pluginId,
      onEnable() { enabled += 1; },
      onDisable() { if (enabled <= 0) throw new Error("disable before enable"); enabled -= 1; },
    });
  `);
  writePackage(packagesDir, "broken", "export default () => { throw new Error('boom'); };");

  const routes = createRouteRegistry();
  const lifecycle = createPackageLifecycle(routes);
  const failures: string[] = [];
  const registered = await registerDiscoveredPackages({
    packagesDir,
    host: { storageDir: packagesDir } as unknown as Omit<ServerPackageHost, "pluginId">,
    lifecycle,
    routes,
    onError: (id) => failures.push(id),
  });

  assert.deepEqual(registered, ["gadget"]);
  assert.deepEqual(failures, ["broken"]);

  // Routes only answer while the package is enabled.
  assert.equal(await routes.handler(request("/api/gadget/gadget")), false);
  await lifecycle.enable("gadget");
  assert.equal(await routes.handler(request("/api/gadget/gadget")), true);
  await lifecycle.disable("gadget");
  assert.equal(await routes.handler(request("/api/gadget/gadget")), false);

  // Re-enable works (hooks stay registered for the process lifetime).
  await lifecycle.enable("gadget");
  assert.equal(await routes.handler(request("/api/gadget/gadget")), true);
});

test("each package receives its own pluginId on the shared host", async () => {
  const packagesDir = mkdtempSync(join(tmpdir(), "polyth-discovery-ids-"));
  writePackage(packagesDir, "first", `
    export default (host) => ({ routes: async (rc) => rc.path === "/api/id/" + host.pluginId });
  `);
  writePackage(packagesDir, "second", `
    export default (host) => ({ routes: async (rc) => rc.path === "/api/id/" + host.pluginId });
  `);

  const routes = createRouteRegistry();
  const lifecycle = createPackageLifecycle(routes);
  const registered = await registerDiscoveredPackages({
    packagesDir,
    host: { storageDir: packagesDir } as unknown as Omit<ServerPackageHost, "pluginId">,
    lifecycle,
    routes,
  });
  assert.deepEqual(registered, ["first", "second"]);

  await lifecycle.enable("first");
  await lifecycle.enable("second");
  assert.equal(await routes.handler(request("/api/id/first")), true);
  assert.equal(await routes.handler(request("/api/id/second")), true);
});

test("every server feature package is discoverable and has a matching descriptor", async () => {
  const packagesDir = join(import.meta.dirname, "../..");
  const discovered = await discoverServerPackages(packagesDir);
  const expected = [
    "browser",
    "commands",
    "dictation",
    "example-feature",
    "files",
    "fusion",
    "git",
    "github",
    "goals",
    "home-assistant",
    "hotkeys",
    "knowledge",
    "models",
    "multirun",
    "permissions",
    "plugins",
    "schedule",
    "secure-safe",
    "ssh",
    "task-trackers",
    "terminal",
    "usage",
    "walkthrough",
    "workflow",
  ];
  assert.deepEqual(discovered.map((pkg) => pkg.id), expected);
  const descriptorIds = new Set<string>(
    BUILTIN_PACKAGES.map((descriptor) => descriptor.id),
  );
  assert.deepEqual(
    discovered.filter((pkg) => !descriptorIds.has(pkg.id)).map((pkg) => pkg.id),
    [],
  );
});
