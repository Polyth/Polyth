import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createContext } from "@polyth/kernel";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "../src/serverPackage.ts";
import registerPlugins from "../src/serverEntry.ts";
import type { PluginRegistry } from "../src/managedRegistry.ts";
import { testSpaceStorage } from "./helpers.ts";

async function fixture(capabilityId = "home-assistant.agent-read", delegateAs?: string) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-managed-owner-"));
  const source = join(dir, "trusted-plugins", "home-assistant");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "polyth-plugin.json"), JSON.stringify({
    id: "home-assistant", name: "Home Assistant", version: "1.0.0",
    trust: "privileged", entries: { server: "./server.mjs" },
  }));
  writeFileSync(join(source, "server.mjs"), `
    export default (host) => ({
      manifest: { id: host.pluginId, version: "1.0.0", trust: "privileged" },
      setup(ctx) {
        if (host.managedPackageServices) throw new Error("delegation authority leaked to entry");
        const capabilities = host.services.require({ id: "polyth.service.harness.capabilities", version: "1" });
        if (capabilities.list().some(item => item.descriptor.owner !== host.pluginId)) {
          throw new Error("another package's capabilities leaked");
        }
        if (capabilities.executor("plugins.keep") || capabilities.contribution("plugins.keep")) {
          throw new Error("another package's executor leaked");
        }
        const read = capabilities.register("polyth", {
          descriptor: {
            id: ${JSON.stringify(capabilityId)}, owner: "polyth", kind: "tool", scope: "deployment", revision: "1",
            name: "managed_read", description: "Read managed package state",
            inputSchema: { type: "object", properties: {} }, trust: "pure", mutating: false,
          },
          execute: async () => ({ output: "ready" }),
        });
        ctx.effect(() => read.dispose());
        const skill = capabilities.register(host.pluginId, {
          descriptor: {
            id: host.pluginId + ".skill", owner: host.pluginId, kind: "skill", scope: "deployment", revision: "1",
            name: "managed-example", description: "Managed package skill", instructions: "Use managed_read.",
          },
        });
        ctx.effect(() => skill.dispose());
      },
    });
  `);

  const root = createContext("managed-owner-test");
  const raw = createServerServiceRegistry();
  const capabilities = createCapabilityContributionRegistry();
  raw.provide(serverServiceKey("plugins.config"), {});
  raw.provide(serverServiceKey("harness.capabilities"), capabilities);
  const managerRegistration = capabilities.register("plugins", {
    descriptor: {
      id: "plugins.keep", owner: "plugins", kind: "tool", scope: "deployment", revision: "1",
      name: "manager_keep", description: "Manager sentinel", inputSchema: { type: "object", properties: {} },
      trust: "pure", mutating: false,
    },
    execute: async () => ({ output: "manager" }),
  });
  const storage = testSpaceStorage(join(dir, "space"));
  const delegations: string[] = [];
  const host = {
    pluginId: "plugins", storageDir: dir, root,
    // Production host construction binds the manager's services, once.
    services: bindPackageServices(raw, "plugins"),
    managedPackageServices(packageId: string) {
      delegations.push(packageId);
      return bindPackageServices(raw, delegateAs ?? packageId);
    },
    routes: { add: () => ({ dispose() {} }) }, broadcast: {},
    packageSpaces: () => [{ spaceId: "spc_managed", storage }],
  } as unknown as ServerPackageHost;
  const manager = registerPlugins(host);
  await manager.onEnable?.();
  const registry = raw.require(serverServiceKey<PluginRegistry>("plugins.managed"));
  await registry.install("file:home-assistant");
  return {
    registry, capabilities, storage, delegations,
    async dispose() {
      await manager.onDisable?.();
      managerRegistration.dispose();
      await root.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("managed activation owns capabilities by installed id through an owner-bound package manager", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.delegations, [], "service delegation is lazy until native activation");
    for (let cycle = 0; cycle < 2; cycle++) {
      const active = await f.registry.enable("home-assistant", f.storage);
      assert.equal(active.status, "ready");
      assert.deepEqual(f.capabilities.list().map(item => [item.descriptor.id, item.descriptor.owner]), [
        ["home-assistant.agent-read", "home-assistant"],
        ["home-assistant.skill", "home-assistant"],
        ["plugins.keep", "plugins"],
      ]);
      assert.equal((await f.capabilities.executor("home-assistant.agent-read")!({}, {} as never)).output, "ready");
      await f.registry.disable("home-assistant", f.storage);
      assert.deepEqual(f.capabilities.list().map(item => item.descriptor.id), ["plugins.keep"]);
    }
    assert.deepEqual(f.delegations, ["home-assistant", "home-assistant"]);
  } finally { await f.dispose(); }
});

test("managed entries cannot register capabilities under the package manager's namespace", async () => {
  const f = await fixture("plugins.stolen");
  try {
    await assert.rejects(() => f.registry.enable("home-assistant", f.storage), /namespaced by owner home-assistant/);
    assert.equal(f.registry.isEnabled("home-assistant", f.storage), false);
    assert.deepEqual(f.capabilities.list().map(item => item.descriptor.id), ["plugins.keep"]);
    assert.deepEqual(f.delegations, ["home-assistant"]);
  } finally { await f.dispose(); }
});

test("managed activation rejects delegated services bound to another package", async () => {
  const f = await fixture(undefined, "plugins");
  try {
    await assert.rejects(() => f.registry.enable("home-assistant", f.storage), /services for "home-assistant" are bound to "plugins"/);
    assert.equal(f.registry.isEnabled("home-assistant", f.storage), false);
    assert.deepEqual(f.capabilities.list().map(item => item.descriptor.id), ["plugins.keep"]);
  } finally { await f.dispose(); }
});
