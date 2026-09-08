import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createServerServiceRegistry, bindPackageServices, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";

test("example-feature contributes a namespaced tool without importing a harness", async () => {
  const registry = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  const host = {
    pluginId: "example-feature",
    services: bindPackageServices(services, "example-feature"),
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  await pkg.onEnable?.();
  assert.equal(registry.list()[0]?.descriptor.id, "example-feature.ping");
  assert.equal((await registry.executor("example-feature.ping")!({}, { sessionId: "", projectId: "p", cwd: "/tmp" })).output, "pong");
  await pkg.onDisable?.();
  assert.equal(registry.list().length, 0);
});
