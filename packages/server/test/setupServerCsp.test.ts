import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { CanonicalSecurity } from "../src/canonicalSecurity.ts";
import { createSetupServer } from "../src/setupServer.ts";

const importMap = '\n{"imports":{"react":"/shared/react.js","react-dom/client":"/shared/react-dom-client.js"}}\n';
const appearance = 'document.documentElement.dataset.theme = "dark";';
const diagnostics = 'window.__errs = [];';
const unauthorized = 'window.untrustedScriptExecuted = true;';
const scriptHash = (body: string): string => `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
const shell = (map = importMap): string => `<!doctype html><html><head><script>${appearance}</script></head><body><div id="root"></div><script>${diagnostics}</script><script type="importmap">${map}</script><script type="module" src="/main.js"></script></body></html>`;

async function fixture(t: TestContext, index: string | null = shell()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "polyth-setup-csp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (index !== null) await writeFile(join(root, "index.html"), index);
  await writeFile(join(root, "other.html"), `<script>${unauthorized}</script>`);
  await writeFile(join(root, "main.js"), 'import React from "react";');
  const security = {
    control: { installation: () => ({ state: "setup" }) },
    http: { handle: async () => false },
  } as unknown as CanonicalSecurity;
  const handle = createSetupServer({ security, webDist: root, version: "test" });
  t.after(() => handle.shutdown());
  await new Promise<void>((resolve, reject) => {
    handle.server.once("error", reject);
    handle.server.listen(0, "127.0.0.1", () => {
      handle.server.off("error", reject);
      resolve();
    });
  });
  const address = handle.server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function scriptSources(response: Response): string[] {
  const policy = response.headers.get("content-security-policy");
  assert.ok(policy);
  const directive = policy.split(";").map((value) => value.trim()).find((value) => value.startsWith("script-src "));
  assert.ok(directive);
  return directive.split(/\s+/).slice(1);
}

test("setup CSP permits the bundled import map and bootstrap scripts without opening inline execution", async (t) => {
  const base = await fixture(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const sources = scriptSources(response);
  assert.deepEqual(new Set(sources), new Set(["'self'", scriptHash(appearance), scriptHash(diagnostics), scriptHash(importMap)]));
  assert.ok(!sources.includes("'unsafe-inline'"));
  assert.ok(!sources.includes("'unsafe-eval'"));
  assert.ok(!sources.includes(scriptHash(unauthorized)));
  assert.equal(await response.text(), shell());
  assert.match(response.headers.get("content-security-policy") ?? "", /object-src 'none'; base-uri 'none'; frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("nested shell routes and HEAD use the same import-map allowance", async (t) => {
  const base = await fixture(t);
  const response = await fetch(`${base}/p/example/s/example`);
  assert.ok(scriptSources(response).includes(scriptHash(importMap)));
  assert.equal(await response.text(), shell());
  const head = await fetch(`${base}/index.html`, { method: "HEAD" });
  assert.deepEqual(scriptSources(head), scriptSources(response));
  assert.equal(await head.text(), "");
});

test("script hashes follow HTML newline normalization without rewriting the shell", async (t) => {
  const map = importMap.replace(/\n/g, "\r\n");
  const html = shell(map);
  const base = await fixture(t, html);
  const response = await fetch(base);
  assert.ok(scriptSources(response).includes(scriptHash(importMap)));
  assert.ok(!scriptSources(response).includes(scriptHash(map)));
  assert.equal(await response.text(), html);
});

test("other HTML cannot add its own inline scripts to the shell allowlist", async (t) => {
  const base = await fixture(t);
  const response = await fetch(`${base}/other.html`);
  assert.ok(scriptSources(response).includes(scriptHash(importMap)));
  assert.ok(!scriptSources(response).includes(scriptHash(unauthorized)));
  assert.equal(await response.text(), `<script>${unauthorized}</script>`);
});

test("duplicate inline scripts produce one hash and external scripts need no empty-body hash", async (t) => {
  const base = await fixture(t, shell() + `<script>${diagnostics}</script>`);
  const response = await fetch(base);
  const sources = scriptSources(response);
  assert.equal(sources.filter((value) => value === scriptHash(diagnostics)).length, 1);
  assert.ok(!sources.includes(scriptHash("")));
});

test("setup API authority and static module serving are unchanged", async (t) => {
  const base = await fixture(t);
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { ok: true, version: "test", setup: true, state: "setup", capabilities: [] });
  const projects = await fetch(`${base}/api/projects`);
  assert.equal(projects.status, 503);
  assert.deepEqual(await projects.json(), { error: "setup-required" });
  const auth = await fetch(`${base}/api/auth/missing`);
  assert.equal(auth.status, 404);
  assert.equal(auth.headers.get("x-polyth-bootstrap"), "setup");
  const module = await fetch(`${base}/main.js`);
  assert.equal(module.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await module.text(), 'import React from "react";');
});

test("an absent shell retains the existing 404 behavior", async (t) => {
  const base = await fixture(t, null);
  const response = await fetch(base);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not-found" });
});
