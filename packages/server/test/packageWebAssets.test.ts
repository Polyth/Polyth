import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

test("package web assets are isolated, typed, and traversal-safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-web-"));
  const webDist = join(root, "web");
  const packagesDir = join(root, "packages");
  const packageDist = join(packagesDir, "sample", "dist", "web");
  mkdirSync(webDist, { recursive: true });
  mkdirSync(packageDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  writeFileSync(join(packageDist, "entry.js"), "export default true;\n");
  writeFileSync(join(packageDist, "entry.css"), ".sample { display: block; }\n");
  writeFileSync(join(packageDist, "chunk-ABCDEFGH.js"), "export const chunk = true;\n");

  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    packagesDir,
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const entry = await fetch(`${base}/packages/sample/entry.js`);
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await entry.text(), "export default true;\n");

    const style = await fetch(`${base}/packages/sample/entry.css`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get("content-type") ?? "", /text\/css/);

    const chunk = await fetch(`${base}/packages/sample/chunk-ABCDEFGH.js`);
    assert.match(chunk.headers.get("cache-control") ?? "", /immutable/);

    assert.equal((await fetch(`${base}/packages/missing/entry.js`)).status, 404);
    assert.equal(
      (await fetch(`${base}/packages/sample/%2e%2e%2fmissing/entry.js`)).status,
      403,
    );
  } finally {
    await new Promise<void>((done) => (server as Server).close(() => done()));
  }
});

test("the native app's /api/package-assets mirror serves the manifest and the same bundles", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-api-"));
  const webDist = join(root, "web");
  const packagesDir = join(root, "packages");
  const packageDist = join(packagesDir, "sample", "dist", "web");
  mkdirSync(webDist, { recursive: true });
  mkdirSync(join(packageDist, "chunks"), { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");
  writeFileSync(join(webDist, "packages-manifest.json"), '{"packages":[{"id":"sample"}]}');
  writeFileSync(join(packageDist, "entry.js"), "export default true;\n");
  writeFileSync(join(packageDist, "chunks", "dep.js"), "export const dep = 1;\n");

  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    packagesDir,
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    assert.deepEqual(await (await fetch(`${base}/api/package-assets/manifest`)).json(), { packages: [{ id: "sample" }] });
    const entry = await fetch(`${base}/api/package-assets/sample/entry.js`);
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await entry.text(), "export default true;\n");
    assert.equal((await fetch(`${base}/api/package-assets/sample/chunks/dep.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/package-assets/missing/entry.js`)).status, 404);
    assert.equal((await fetch(`${base}/api/package-assets/sample/%2e%2e%2fmissing/entry.js`)).status, 403);
    assert.equal((await fetch(`${base}/api/package-assets/sample/entry.js`, { method: "POST" })).status, 404);
  } finally {
    await new Promise<void>((done) => (server as Server).close(() => done()));
  }
});
