import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest } from "../src/http.ts";
import { BUILTIN_PACKAGES, createPackageRegistry } from "../src/packages.ts";
import { packageRoutes } from "../src/routes/packages.ts";
import type { PackageDescriptorDto } from "@polyth/contracts";

const temporaryFile = (): string =>
  join(mkdtempSync(join(tmpdir(), "polyth-packages-")), "packages.json");

const FEATURE_PACKAGES: PackageDescriptorDto[] = [
  { id: "git", name: "Git", description: "Git test package.", core: false, enabled: true, hasSettings: true },
  { id: "terminal", name: "Terminal", description: "Terminal test package.", core: false, enabled: true, hasSettings: false },
  { id: "browser", name: "Browser", description: "Browser test package.", core: false, enabled: true, hasSettings: false },
  { id: "home-assistant", name: "Home Assistant", description: "Home Assistant test package.", core: false, enabled: false, hasSettings: true },
];

const registry = (file = temporaryFile()) =>
  createPackageRegistry({ file, descriptors: FEATURE_PACKAGES });

test("list combines shell and manifest packages with core packages always enabled", () => {
  const file = temporaryFile();
  const packageRegistry = registry(file);
  const packages = packageRegistry.list();

  assert.equal(packages.length, BUILTIN_PACKAGES.length + FEATURE_PACKAGES.length);
  assert.deepEqual(
    packages.map((descriptor) => descriptor.id),
    [...BUILTIN_PACKAGES, ...FEATURE_PACKAGES].map((descriptor) => descriptor.id),
  );
  assert.ok(packages.filter((descriptor) => descriptor.core).every((descriptor) => descriptor.enabled));
  assert.equal(packageRegistry.get("agents"), null);
  assert.equal(packageRegistry.get("home-assistant")?.enabled, false);
  assert.equal(packageRegistry.get("git")?.enabled, true);
  assert.equal(packageRegistry.get("missing"), null);
  assert.equal(packageRegistry.isEnabled("missing"), false);

  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
  assert.ok(!("session" in stored), "core package state is not persisted");
  assert.deepEqual(
    Object.keys(stored),
    packages.filter((descriptor) => !descriptor.core).map((descriptor) => descriptor.id),
  );
});

test("setEnabled toggles a non-core package", async () => {
  const packageRegistry = registry();

  const disabled = await packageRegistry.setEnabled("git", false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "disabled");
  assert.equal(packageRegistry.get("git")?.enabled, false);
  assert.equal(packageRegistry.isEnabled("git"), false);

  const enabled = await packageRegistry.setEnabled("git", true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status, "ready");
  assert.equal(packageRegistry.isEnabled("git"), true);
});

test("setEnabled rejects core packages", async () => {
  const packageRegistry = registry();

  await assert.rejects(
    packageRegistry.setEnabled("session", false),
    (error: Error & { code?: string }) =>
      error.code === "invalid-input" && /core package/.test(error.message),
  );
  assert.equal(packageRegistry.isEnabled("session"), true);
});

test("non-core state persists across registry reopen", async () => {
  const file = temporaryFile();
  const first = registry(file);
  await first.setEnabled("terminal", false);
  await first.setEnabled("home-assistant", true);

  const reopened = registry(file);
  assert.equal(reopened.isEnabled("terminal"), false);
  assert.equal(reopened.isEnabled("home-assistant"), true);
  assert.equal(reopened.isEnabled("session"), true);
});

test("package routes list packages and update enablement", async () => {
  const packageRegistry = registry();
  const route = packageRoutes(packageRegistry);

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
      ingress: { kind: "public-http", listenerId: "test", loopback: true, secure: false },
      principal: { kind: "local-user", trustedLoopback: true },
      space: {
        spaceId: "spc_test",
        spaceSlug: "test",
        userId: "usr_test",
        role: "owner",
        deployment: "local-trusted",
        storageDir: temporaryFile(),
      },
      requireCapability() {},
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
  assert.equal(
    (listed.payload as { packages: unknown[] }).packages.length,
    BUILTIN_PACKAGES.length + FEATURE_PACKAGES.length,
  );

  const updated = await call("PATCH", "/api/packages/browser", { enabled: false });
  assert.equal(updated.handled, true);
  assert.equal(updated.status, 200);
  assert.equal((updated.payload as { enabled: boolean }).enabled, false);
  assert.equal(packageRegistry.isEnabled("browser"), false);
});
