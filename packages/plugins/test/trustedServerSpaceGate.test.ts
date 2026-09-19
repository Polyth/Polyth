import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { RouteHandler, RouteRequest } from "@polyth/contracts";
import { createContext } from "@polyth/kernel";
import {
  bindTrustedServerSpaceGate,
  loadServerEntry,
} from "../src/trustedServerEntry.ts";

const requestFor = (spaceId: string): RouteRequest => ({
  space: { spaceId },
} as unknown as RouteRequest);

test("trusted server routes are denied outside Spaces where the package is enabled", async () => {
  const installDir = mkdtempSync(join(tmpdir(), "polyth-trusted-space-gate-"));
  mkdirSync(join(installDir, ".polyth"), { recursive: true });
  writeFileSync(join(installDir, "polyth-plugin.json"), JSON.stringify({
    id: "sample.trusted",
    name: "Sample trusted",
    version: "1.0.0",
    trust: "privileged",
    contributions: [],
    entries: { server: "./server.mjs" },
  }));
  writeFileSync(join(installDir, "server.mjs"), `
    export default (host) => ({
      manifest: { id: host.pluginId, version: "1.0.0", trust: "privileged" },
      setup(context) {
        const route = host.routes.add(async () => true);
        context.effect(() => route.dispose());
      },
    });
  `);

  const root = createContext("trusted-space-gate-test");
  let route: RouteHandler | null = null;
  const gate = bindTrustedServerSpaceGate((pluginId, spaceId) =>
    pluginId === "sample.trusted" && spaceId === "spc_a");
  const mounted = await loadServerEntry({
    installDir,
    entryPath: "./server.mjs",
    integrity: "test-integrity",
    host: {
      pluginId: "sample.trusted",
      storageDir: join(installDir, ".polyth"),
      root,
      routes: {
        add(handler) {
          route = handler;
          return { dispose: () => { route = null; } };
        },
      },
    },
  });

  const activeRoute = route as unknown as RouteHandler;
  assert.ok(activeRoute);
  assert.equal(await activeRoute(requestFor("spc_a")), true);
  assert.equal(await activeRoute(requestFor("spc_b")), false);

  gate.dispose();
  assert.equal(await activeRoute(requestFor("spc_a")), false, "missing canonical gate fails closed");

  await mounted.dispose();
  await root.dispose();
});
