import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "../src/http.ts";
import { BUILTIN_PACKAGES, createPackageRegistry } from "../src/packages.ts";
import { packageRoutes } from "../src/routes/packages.ts";

const temporaryFile = (): string =>
  join(mkdtempSync(join(tmpdir(), "polyth-packages-")), "packages.json");

test("list returns every built-in package with core packages always enabled", () => {
  const file = temporaryFile();
  const registry = createPackageRegistry({ file });
  const packages = registry.list();

  assert.equal(packages.length, BUILTIN_PACKAGES.length);
  assert.deepEqual(packages.map((descriptor) => descriptor.id), BUILTIN_PACKAGES.map((descriptor) => descriptor.id));
  assert.ok(packages.filter((descriptor) => descriptor.core).every((descriptor) => descriptor.enabled));
  assert.equal(registry.get("home-assistant")?.enabled, false);
  assert.equal(registry.get("git")?.enabled, true);
  assert.equal(registry.get("missing"), null);
  assert.equal(registry.isEnabled("missing"), false);

  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
  assert.ok(!("session" in stored), "core package state is not persisted");
  assert.deepEqual(
    Object.keys(stored),
    packages.filter((descriptor) => !descriptor.core).map((descriptor) => descriptor.id),
  );
});

test("setEnabled toggles a non-core package", async () => {
  const registry = createPackageRegistry({ file: temporaryFile() });

  const disabled = await registry.setEnabled("git", false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "disabled");
  assert.equal(registry.get("git")?.enabled, false);
  assert.equal(registry.isEnabled("git"), false);

  const enabled = await registry.setEnabled("git", true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status, "ready");
  assert.equal(registry.isEnabled("git"), true);
});

test("setEnabled rejects core packages", async () => {
  const registry = createPackageRegistry({ file: temporaryFile() });

  await assert.rejects(
    registry.setEnabled("session", false),
    (error: Error & { code?: string }) =>
      error.code === "invalid-input" && /core package/.test(error.message),
  );
  assert.equal(registry.isEnabled("session"), true);
});

test("non-core state persists across registry reopen", async () => {
  const file = temporaryFile();
  const first = createPackageRegistry({ file });
  await first.setEnabled("terminal", false);
  await first.setEnabled("home-assistant", true);

  const reopened = createPackageRegistry({ file });
  assert.equal(reopened.isEnabled("terminal"), false);
  assert.equal(reopened.isEnabled("home-assistant"), true);
  assert.equal(reopened.isEnabled("session"), true);
});

test("package routes list packages and update enablement", async () => {
  const registry = createPackageRegistry({ file: temporaryFile() });
  const route = packageRoutes(registry);

  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://polyth.test${path}`);
    const handled = await route({
      req: {},
      res: {},
      url,
      path: url.pathname,
      method,
      body: async () => body,
      json: (code, value) => {
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest);
    return { handled, status, payload };
  };

  const listed = await call("GET", "/api/packages");
  assert.equal(listed.handled, true);
  assert.equal(listed.status, 200);
  assert.equal((listed.payload as { packages: unknown[] }).packages.length, BUILTIN_PACKAGES.length);

  const updated = await call("PATCH", "/api/packages/preview", { enabled: false });
  assert.equal(updated.handled, true);
  assert.equal(updated.status, 200);
  assert.equal((updated.payload as { enabled: boolean }).enabled, false);
  assert.equal(registry.isEnabled("preview"), false);
});
