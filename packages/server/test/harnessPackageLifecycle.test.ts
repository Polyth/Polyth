import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRuntime, HarnessContext, HarnessRegistry, ServerPackageHost } from "@polyth/contracts";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import { bindPackageServices, discoverServerPackages, loadServerPackage } from "@polyth/plugins";
import registerOpenCode from "../../backend-opencode/src/serverEntry.ts";

// Every shipped harness backend registers the same lifecycle contract. The
// packages are discovered from their manifests, so removing one simply stops
// the loop from covering it; the host never names a removable package.
const packagesDir = resolve(import.meta.dirname, "../..");
const backendPackages = (await discoverServerPackages(packagesDir))
  .filter((pkg) => pkg.id.startsWith("backend-"));

for (const discovered of backendPackages) {
  const id = discovered.id.replace(/^backend-/, "");
  test(`${id} harness registration is lazy, idempotent, and awaits unregister`, async () => {
    const harnesses = createHarnessRegistry();
    const services = new Map<string, unknown>();
    services.set("polyth.service.harnesses", harnesses);
    services.set("polyth.service.opencode.runtime", async (_context: HarnessContext): Promise<AgentRuntime> => {
      throw new Error("test must not construct an OpenCode runtime");
    });
    let required = 0;
    const host = {
      pluginId: discovered.id,
      storageDir: join(tmpdir(), "polyth-harness-package-lifecycle"),
      services: bindPackageServices({
        get<T>(key: { id: string }): T | undefined { return services.get(key.id) as T | undefined; },
        require<T>(key: { id: string }): T {
          required += 1;
          if (!services.has(key.id)) throw new Error(`missing service ${key.id}`);
          return services.get(key.id) as T;
        },
        provide<T>(key: { id: string }, value: T): void { services.set(key.id, value); },
        ids: () => [...services.keys()].sort(),
      } as never, discovered.id),
    } as unknown as ServerPackageHost;

    // Package discovery/factory construction must not depend on service
    // registration order. Only onEnable may cross that boundary.
    const pkg = await loadServerPackage(discovered, host);
    assert.equal(required, 0);
    assert.equal((harnesses as HarnessRegistry).get(id), undefined);

    await pkg.onEnable?.();
    await pkg.onEnable?.();
    assert.equal((harnesses as HarnessRegistry).get(id)?.descriptor.id, id);
    await pkg.onDisable?.();
    await pkg.onDisable?.();
    assert.equal((harnesses as HarnessRegistry).get(id), undefined);
    await pkg.onEnable?.();
    assert.equal((harnesses as HarnessRegistry).get(id)?.descriptor.id, id);
    await pkg.onDisable?.();
  });
}

for (const discovered of backendPackages) {
  const id = discovered.id.replace(/^backend-/, "");
  test(`${id}: a package disable failure keeps its provider registered`, async () => {
    const harnesses = createHarnessRegistry();
    const blocking = harnesses.onUnregister?.(() => { throw Object.assign(new Error("runtime lease remains"), { code: "conflict" }); });
    const services = new Map<string, unknown>();
    services.set("polyth.service.harnesses", harnesses);
    services.set("polyth.service.opencode.runtime", async (): Promise<AgentRuntime> => {
      throw new Error("test must not construct an OpenCode runtime");
    });
    const host = {
      pluginId: discovered.id,
      storageDir: join(tmpdir(), "polyth-harness-package-lifecycle"),
      services: bindPackageServices({
        get<T>(key: { id: string }): T | undefined { return services.get(key.id) as T | undefined; },
        require<T>(key: { id: string }): T {
          if (!services.has(key.id)) throw new Error(`missing service ${key.id}`);
          return services.get(key.id) as T;
        },
        provide<T>(key: { id: string }, value: T): void { services.set(key.id, value); },
        ids: () => [...services.keys()].sort(),
      } as never, discovered.id),
    } as unknown as ServerPackageHost;
    const pkg = await loadServerPackage(discovered, host);
    await pkg.onEnable?.();
    await assert.rejects(Promise.resolve(pkg.onDisable?.()), { code: "conflict" });
    assert.equal(harnesses.get(id)?.descriptor.id, id);

    // A later lifecycle retry can still succeed after the blocking lease owner
    // releases; the failed attempt did not silently dispose the registration.
    blocking?.dispose();
    await pkg.onDisable?.();
    assert.equal(harnesses.get(id), undefined);
  });
}

test("a failed OpenCode enable publishes no partial registration and can retry cleanly", async () => {
  const harnesses = createHarnessRegistry();
  let failSubscription = true;
  const services = new Map<string, unknown>([
    ["polyth.service.harnesses", harnesses],
    ["polyth.service.opencode.runtime", async (): Promise<AgentRuntime> => {
      throw new Error("test must not construct an OpenCode runtime");
    }],
    ["polyth.service.opencode.runtime.events", {
      onRestart() {
        if (failSubscription) throw new Error("subscription failed");
        return { dispose() {} };
      },
    }],
  ]);
  const host = {
    pluginId: "backend-opencode",
    storageDir: "/tmp/polyth-harness-package-lifecycle",
    services: {
      get: <T>(key: { id: string }) => services.get(key.id) as T | undefined,
      require: <T>(key: { id: string }) => services.get(key.id) as T,
      provide: <T>(key: { id: string }, value: T) => { services.set(key.id, value); },
      ids: () => [...services.keys()],
    },
  } as unknown as ServerPackageHost;
  const pkg = registerOpenCode(host);

  assert.throws(() => pkg.onEnable?.(), /subscription failed/);
  assert.equal(harnesses.get("opencode"), undefined);
  failSubscription = false;
  await pkg.onEnable?.();
  assert.equal(harnesses.get("opencode")?.descriptor.id, "opencode");
  await pkg.onDisable?.();
  assert.equal(harnesses.get("opencode"), undefined);
});

test("a bundled OpenCode registers behind the host's own harnesses in Auto", async () => {
  const harnesses = createHarnessRegistry();
  const services = new Map<string, unknown>([
    ["polyth.service.harnesses", harnesses],
    ["polyth.service.opencode.runtime", async (): Promise<AgentRuntime> => {
      throw new Error("test must not construct an OpenCode runtime");
    }],
    ["polyth.service.opencode.binary-source", "bundled"],
  ]);
  const host = {
    pluginId: "backend-opencode",
    storageDir: "/tmp/polyth-harness-package-lifecycle",
    services: {
      get: <T>(key: { id: string }) => services.get(key.id) as T | undefined,
      require: <T>(key: { id: string }) => services.get(key.id) as T,
      provide: <T>(key: { id: string }, value: T) => { services.set(key.id, value); },
      ids: () => [...services.keys()],
    },
  } as unknown as ServerPackageHost;

  const bundled = registerOpenCode(host);
  await bundled.onEnable?.();
  assert.equal(harnesses.get("opencode")?.descriptor.priority, 1000,
    "the downloaded runtime is an Auto fallback behind an installed, authorized harness");
  await bundled.onDisable?.();

  // Without the bundled source the host owns the executable, so it keeps its
  // ordinary Auto priority (second, after Claude Code) instead of deferring.
  services.delete("polyth.service.opencode.binary-source");
  const installed = registerOpenCode(host);
  await installed.onEnable?.();
  assert.equal(harnesses.get("opencode")?.descriptor.priority, 10,
    "a host-installed OpenCode keeps its ordinary priority");
  await installed.onDisable?.();
});
