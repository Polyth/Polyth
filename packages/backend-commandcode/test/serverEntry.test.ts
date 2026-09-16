import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessRegistry } from "@polyth/contracts";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import {
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import registerCommandCodePackage from "../src/serverEntry.ts";

test("enabled Command Code package registers a harness visible to Harness settings", async () => {
  const registry = createHarnessRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey<HarnessRegistry>("harnesses"), registry);

  const pkg = registerCommandCodePackage({ services } as unknown as ServerPackageHost);
  await pkg.onEnable?.();
  try {
    assert.equal(registry.get("commandcode")?.descriptor.name, "Command Code");
    const roster = await registry.roster({
      spaceId: "space-test",
      projectId: "project-test",
      cwd: process.cwd(),
    });
    assert.equal(roster.some((row) => row.identity.id === "commandcode"), true);
  } finally {
    await pkg.onDisable?.();
  }

  assert.equal(registry.get("commandcode"), undefined);
});
