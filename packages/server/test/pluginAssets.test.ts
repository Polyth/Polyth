import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer } from "../src/http.ts";
import { pluginAssetRoutes } from "../../plugins/src/serverEntry.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

test("plugin UI assets are integrity-addressed even when the process flag is disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-plugin-assets-"));
  const pluginsDir = join(root, "plugins");
  const webDist = join(root, "web");
  const contents = "export const modules = {};\n";
  const integrity = createHash("sha256").update(contents).digest("hex");
  const assetDir = join(pluginsDir, "test.ui", ".polyth", "ui");
  mkdirSync(assetDir, { recursive: true });
  mkdirSync(webDist);
  writeFileSync(join(assetDir, `ui-${integrity}.mjs`), contents);

  const plugin = {
    id: "test.ui",
    ui: {
      url: `/api/plugins/test.ui/ui/${integrity}.mjs`,
    },
  };
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    routes: [pluginAssetRoutes({
      plugins: {
        has: (id) => id === plugin.id,
        installDir: () => join(pluginsDir, "test.ui"),
      },
    })],
  });
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const response = await fetch(`${base}${plugin.ui!.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/javascript");
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    assert.match(await response.text(), /export const modules/);

    const mismatch = await fetch(
      `${base}/api/plugins/test.ui/ui/${"b".repeat(64)}.mjs`,
    );
    assert.equal(mismatch.status, 404);
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }
});
