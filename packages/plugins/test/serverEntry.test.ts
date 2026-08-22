import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import { createContext } from "@polyth/kernel";
import { loadServerEntry } from "../src/serverEntry.ts";

const fixture = (): { rootDir: string; installDir: string } => {
  const rootDir = mkdtempSync(join(tmpdir(), "polyth-server-entry-"));
  const installDir = join(rootDir, "installed");
  mkdirSync(installDir);
  return { rootDir, installDir };
};

test("server entry rejects a path that escapes the install directory", async () => {
  const { rootDir, installDir } = fixture();
  const outside = join(rootDir, "outside.mjs");
  writeFileSync(outside, "export default () => ({})");
  symlinkSync(outside, join(installDir, "server.mjs"));
  const root = createContext("test-root");

  await assert.rejects(
    () => loadServerEntry({
      installDir,
      entryPath: "./server.mjs",
      integrity: "test",
      host: {
        pluginId: "test.plugin",
        storageDir: join(installDir, ".polyth"),
        routes: { add: () => ({ dispose() {} }) },
        root,
      },
    }),
    /escapes the plugin install directory/,
  );
  await root.dispose();
});

test("server entry loads its default plugin factory and returns scoped disposal", async () => {
  const { installDir } = fixture();
  writeFileSync(join(installDir, "server.mjs"), `
    export default (host) => ({
      manifest: { id: host.pluginId, version: "1.0.0", trust: "workspace" },
      setup(context) {
        const route = host.routes.add(async () => true);
        context.effect(() => route.dispose());
      },
    });
  `);
  const root = createContext("test-root");
  const active = new Set<RouteHandler>();
  const disposable = await loadServerEntry({
    installDir,
    entryPath: "./server.mjs",
    integrity: "abc123",
    host: {
      pluginId: "test.plugin",
      storageDir: join(installDir, ".polyth"),
      routes: {
        add(handler) {
          active.add(handler);
          return { dispose: () => { active.delete(handler); } };
        },
      },
      root,
    },
  });

  assert.equal(active.size, 1);
  await disposable.dispose();
  assert.equal(active.size, 0);
  await root.dispose();
});
