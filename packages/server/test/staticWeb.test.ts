// EXT-SEAMS-V3 regression: refresh replay at the canonical session route.
// The browser refreshes at /p/:projectId/s/:sessionId, receives the SPA shell
// via the fallback, then resolves every asset URL in that shell *against the
// nested route*. This system test replays exactly that sequence with the real
// shipped index.html: each referenced asset must resolve route-independently
// and come back with an executable MIME type — never index.html as a module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

const SHIPPED_WEB = resolve(import.meta.dirname, "../../../apps/web");
const SHIPPED_INDEX = join(SHIPPED_WEB, "src/index.html");

async function startStaticServer(): Promise<{ server: Server; base: string }> {
  const webDist = join(mkdtempSync(join(tmpdir(), "polyth-static-")), "dist");
  mkdirSync(webDist, { recursive: true });
  // The real shell, exactly as build.ts copies it into dist/.
  copyFileSync(SHIPPED_INDEX, join(webDist, "index.html"));
  writeFileSync(join(webDist, "main.js"), "export const boot = true;\n");
  writeFileSync(join(webDist, "main.css"), ":root { --ok: 1; }\n");
  writeFileSync(join(webDist, "sw.js"), "// service worker\n");
  for (const file of ["manifest.json", "icon-192.png", "icon-512.png"]) {
    copyFileSync(join(SHIPPED_WEB, file), join(webDist, file));
  }

  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** Every URL a browser would request while parsing the served shell:
 *  <script src>, <link href> — resolved against the page URL like a browser. */
function assetUrlsOf(html: string, pageUrl: string): URL[] {
  const urls: URL[] = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)) {
    urls.push(new URL(m[1]!, pageUrl));
  }
  return urls;
}

test("refresh at /p/:projectId/s/:sessionId replays: shell + every asset boots", async () => {
  const { server, base } = await startStaticServer();
  try {
    const route = `${base}/p/2f1c9f6e-1111-4a5c-9c3d-aaaaaaaaaaaa/s/9d8e7f6a-2222-4b3c-8d1e-bbbbbbbbbbbb`;

    // 1. The nested navigation gets the SPA shell.
    const page = await fetch(route);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /<div id="root">/);

    // 2. The shell must reference at least the JS module and stylesheet, and
    //    every reference must be route-independent (root-absolute), so it
    //    resolves identically from / and from the nested session route.
    const assets = assetUrlsOf(html, route);
    assert.ok(assets.some((u) => u.pathname.endsWith(".js")), "shell references a JS module");
    assert.ok(assets.some((u) => u.pathname.endsWith(".css")), "shell references a stylesheet");
    assert.ok(assets.some((u) => u.protocol === "data:"), "the favicon is embedded and cannot create a startup 404");
    assert.equal(assets.some((u) => u.pathname === "/favicon.ico"), false);
    for (const asset of assets) {
      assert.ok(
        !asset.pathname.startsWith("/p/"),
        `asset URL ${asset.pathname} resolved under the session route — refresh cannot boot`,
      );
    }

    // 3. Fetch each asset exactly as the refreshed page would; a module script
    //    answered with text/html is Chrome's failure mode from the audit.
    for (const asset of assets) {
      const res = await fetch(asset);
      assert.equal(res.status, 200, `asset ${asset.pathname} must exist`);
      const mime = res.headers.get("content-type") ?? "";
      if (asset.pathname.endsWith(".js")) assert.match(mime, /javascript/, `module ${asset.pathname} got "${mime}"`);
      if (asset.pathname.endsWith(".css")) assert.match(mime, /text\/css/, `stylesheet ${asset.pathname} got "${mime}"`);
      assert.doesNotMatch(mime, /text\/html/, `asset ${asset.pathname} was answered with the HTML shell`);
    }
  } finally {
    server.close();
  }
});

test("a missing asset-like path 404s instead of masquerading as the HTML shell", async () => {
  const { server, base } = await startStaticServer();
  try {
    // The pre-fix failure: a relative asset under a nested route hit the SPA
    // fallback and returned index.html, which Chrome rejects as a module.
    const nestedMiss = await fetch(`${base}/p/some-project/s/main.js`);
    assert.equal(nestedMiss.status, 404);
    assert.doesNotMatch(nestedMiss.headers.get("content-type") ?? "", /text\/html/);

    const rootMiss = await fetch(`${base}/no-such-file.js`);
    assert.equal(rootMiss.status, 404);

    // Extension-less navigations still get the SPA fallback…
    const nav = await fetch(`${base}/p/some-project/s/some-session`);
    assert.equal(nav.status, 200);
    assert.match(nav.headers.get("content-type") ?? "", /text\/html/);

    // …and real assets keep their MIME types.
    const js = await fetch(`${base}/main.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
  } finally {
    server.close();
  }
});
