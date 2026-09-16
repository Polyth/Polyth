import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserArtifactStore, createBrowserService, createFakeDriver } from "@polyth/browser";
import { createSpaceStorage } from "@polyth/tenancy";
import { browserRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

const HOME = "http://127.0.0.1:5173/";

function makeHarness(storageRoot: string) {
  const storage = createSpaceStorage(storageRoot);
  const browser = createBrowserService({
    driver: createFakeDriver({ pages: { [HOME]: { title: "App", text: "hello" } } }),
    append: async () => ({}) as never,
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const routes = browserRoutes({
    browser,
    storage,
    append: async () => ({}) as never,
    shotsDir: join(storageRoot, "shots"),
    artifacts: createBrowserArtifactStore(join(storageRoot, "artifacts")),
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
      url: new URL(`http://x${path}`),
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    assert.equal(await routes(rc), true);
    return { status, payload };
  };
  return { storage, call };
}

test("browser agent auto-approve routes default to enabled and persist toggles", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-auto-approve-routes-"));
  const { call } = makeHarness(root);
  assert.deepEqual((await call("GET", "/api/browser/agent-auto-approve")).payload, { enabled: true });
  assert.deepEqual((await call("PATCH", "/api/browser/agent-auto-approve", { enabled: false })).payload, { enabled: false });
  assert.deepEqual((await call("GET", "/api/browser/agent-auto-approve")).payload, { enabled: false });
  assert.deepEqual((await call("POST", "/api/browser/agent-auto-approve", { enabled: true })).payload, { enabled: true });
});

test("browser agent auto-approve routes reject invalid payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-auto-approve-invalid-"));
  const { call } = makeHarness(root);
  const result = await call("PATCH", "/api/browser/agent-auto-approve", { enabled: "yes" });
  assert.equal(result.status, 400);
});

test("browser agent auto-approve settings remain isolated across Space storages", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "browser-auto-approve-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "browser-auto-approve-b-"));
  const harnessA = makeHarness(rootA);
  const harnessB = makeHarness(rootB);
  await harnessA.call("PATCH", "/api/browser/agent-auto-approve", { enabled: false });
  await harnessB.call("PATCH", "/api/browser/agent-auto-approve", { enabled: true });
  assert.deepEqual((await harnessA.call("GET", "/api/browser/agent-auto-approve")).payload, { enabled: false });
  assert.deepEqual((await harnessB.call("GET", "/api/browser/agent-auto-approve")).payload, { enabled: true });
});
