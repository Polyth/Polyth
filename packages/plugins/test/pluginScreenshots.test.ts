import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "@polyth/contracts";
import { createPluginRegistry } from "../src/managedRegistry.ts";
import { pluginAssetRoutes } from "../src/pluginAssetRoutes.ts";

/** 1×1 PNG; the asset route serves bytes, so a real file keeps the fixture
 *  honest without shipping binary test data. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function writePackage(dir: string, over: { version?: string; screenshots?: unknown[] } = {}): void {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "shot.png"), PNG);
  writeFileSync(join(dir, "ui.ts"), [
    'import { connectPolyth } from "@polyth/package-sdk";',
    "await connectPolyth();",
  ].join("\n"));
  writeFileSync(join(dir, "polyth-package.json"), JSON.stringify({
    manifestVersion: 2,
    id: "com-example-gallery",
    version: over.version ?? "1.0.0",
    display: {
      name: "Gallery demo",
      description: "Shows a package gallery.",
      summary: "A longer description used by the detail view.",
      tags: ["charts", "reports"],
      icon: "chart",
      screenshots: over.screenshots ?? [
        { src: "docs/shot.png", caption: "Dashboard", alt: "A dashboard view" },
        { src: "docs/missing.png", caption: "Not shipped" },
      ],
    },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    contributes: { widgets: [{ id: "demo", title: "Demo", description: "Demo widget" }] },
    capabilities: ["ui.render"],
  }));
}

async function assetRequest(
  route: Awaited<ReturnType<typeof pluginAssetRoutes>>,
  path: string,
): Promise<{ status: number; headers: Record<string, string | number>; body: Buffer | undefined }> {
  let status = 0;
  let headers: Record<string, string | number> = {};
  let body: Buffer | undefined;
  const handled = await route({
    req: {},
    res: {
      writeHead: (code: number, next: Record<string, string | number>) => { status = code; headers = next; },
      end: (payload: Buffer) => { body = payload; },
    },
    url: new URL(`http://x${path}`),
    path,
    method: "GET",
    body: async () => ({}),
    json: () => {},
  } as unknown as RouteRequest);
  assert.equal(handled, true);
  return { status, headers, body };
}

test("a package gallery exposes only frames the published version really ships", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-shots-"));
  try {
    const trusted = join(root, "trusted");
    writePackage(join(trusted, "demo"));
    const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
    const installed = await registry.install("file:demo");

    assert.deepEqual(installed.tags, ["charts", "reports"]);
    assert.equal(installed.summary, "A longer description used by the detail view.");
    assert.deepEqual(installed.classifiers, ["widget", "sandboxed"]);
    // The declared-but-missing frame is dropped instead of becoming a broken
    // image, and the shipped one is host-served at an immutable URL.
    assert.equal(installed.screenshots?.length, 1);
    assert.equal(installed.screenshots?.[0]?.caption, "Dashboard");
    assert.equal(installed.screenshots?.[0]?.alt, "A dashboard view");
    assert.equal(
      installed.screenshots?.[0]?.url,
      "/api/plugins/com-example-gallery/screenshots/1.0.0/0/shot.png",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("screenshot assets resolve only declared frames of an installed version", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-shots-serve-"));
  try {
    const trusted = join(root, "trusted");
    writePackage(join(trusted, "demo"));
    const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
    await registry.install("file:demo");
    const routes = pluginAssetRoutes({
      plugins: registry,
      screenshot: (id, version, index) => registry.screenshotFrame(id, version, index),
    });

    const served = await assetRequest(routes, "/api/plugins/com-example-gallery/screenshots/1.0.0/0/shot.png");
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "image/png");
    assert.equal(served.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(served.headers["x-content-type-options"], "nosniff");
    assert.equal(served.body?.length, PNG.length);
    assert.ok(served.body?.equals(PNG));

    // Anything not declared by the active manifest is a miss: a missing frame,
    // an out-of-range index, a renamed file, an unpublished version.
    for (const path of [
      "/api/plugins/com-example-gallery/screenshots/1.0.0/1/missing.png",
      "/api/plugins/com-example-gallery/screenshots/1.0.0/9/shot.png",
      "/api/plugins/com-example-gallery/screenshots/1.0.0/0/other.png",
      "/api/plugins/com-example-gallery/screenshots/9.9.9/0/shot.png",
      "/api/plugins/com-example-gallery/screenshots/1.0.0/0/polyth-package.json",
    ]) {
      await assert.rejects(() => assetRequest(routes, path), /not found/i, path);
    }

    // A package that is not installed at all must not leak another package's
    // frame through a guessed id.
    await assert.rejects(
      () => assetRequest(routes, "/api/plugins/other-package/screenshots/1.0.0/0/shot.png"),
      /not found/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an update republishes the gallery under the new version", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-shots-update-"));
  try {
    const trusted = join(root, "trusted");
    writePackage(join(trusted, "demo"));
    const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
    await registry.install("file:demo");
    writePackage(join(trusted, "demo"), { version: "1.1.0" });
    const updated = await registry.update("com-example-gallery");
    assert.equal(updated.version, "1.1.0");
    assert.equal(
      updated.screenshots?.[0]?.url,
      "/api/plugins/com-example-gallery/screenshots/1.1.0/0/shot.png",
    );
    const routes = pluginAssetRoutes({
      plugins: registry,
      screenshot: (id, version, index) => registry.screenshotFrame(id, version, index),
    });
    const fresh = await assetRequest(routes, "/api/plugins/com-example-gallery/screenshots/1.1.0/0/shot.png");
    assert.equal(fresh.status, 200);
    await assert.rejects(
      () => assetRequest(routes, "/api/plugins/com-example-gallery/screenshots/1.2.0/0/shot.png"),
      /not found/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a screenshot frame cannot escape the install directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-shots-escape-"));
  try {
    const trusted = join(root, "trusted");
    writePackage(join(trusted, "demo"));
    writeFileSync(join(trusted, "secret.png"), PNG);
    const registry = createPluginRegistry({ dir: join(root, "installed"), trustedDir: trusted });
    await registry.install("file:demo");
    // The manifest parser already rejects an escaping src; simulate a tampered
    // published record and confirm the route still refuses to leave the tree.
    const routes = pluginAssetRoutes({
      plugins: registry,
      screenshot: () => ({ src: "../secret.png" }),
    });
    await assert.rejects(
      () => assetRequest(routes, "/api/plugins/com-example-gallery/screenshots/1.0.0/0/secret.png"),
      /not found/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
