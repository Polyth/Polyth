import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ServerPackageHost } from "@polyth/plugins";
import { discoverServerPackages } from "@polyth/plugins";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import registerPackage from "../src/serverEntry.ts";

function fixture() {
  const registry = createHarnessRegistry();
  let requests = 0;
  const host = { services: { require: () => { requests++; return registry; } } } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  return { registry, pkg, get requests() { return requests; } };
}

test("package registration is lazy, idempotent and reversible without native CLI startup", async () => {
  const f = fixture();
  assert.equal(f.requests, 0);
  assert.equal(f.registry.get("antigravity"), undefined);
  f.pkg.onEnable(); f.pkg.onEnable();
  assert.equal(f.requests, 1);
  assert.equal(f.registry.get("antigravity")?.descriptor.autoSelect, false);
  await f.pkg.onDisable(); await f.pkg.onDisable();
  assert.equal(f.registry.get("antigravity"), undefined);
});

test("provider rejects remote execution and missing validated Space before accessing credentials", async () => {
  const f = fixture(); f.pkg.onEnable();
  try {
    const provider = f.registry.get("antigravity")!;
    const context = { spaceId: "space-a", projectId: "project-a", cwd: "/project", sessionId: "session-a" };
    assert.equal((await provider.probe({ ...context, remote: true })).installed, false);
    await assert.rejects(provider.createRuntime(context), { code: "unsupported" });
    await assert.rejects(provider.discover!({ ...context, remote: true }), { code: "unsupported" });
  } finally { await f.pkg.onDisable(); }
});

test("autonomous discovery includes the package and workspace lock records its exact dependencies", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const discovered = await discoverServerPackages(root);
  assert.ok(discovered.some((item) => item.packageName === "@polyth/backend-antigravity"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lock.packages["packages/backend-antigravity"].dependencies, manifest.dependencies);
  assert.equal(lock.packages["node_modules/@polyth/backend-antigravity"].resolved, "packages/backend-antigravity");
});
