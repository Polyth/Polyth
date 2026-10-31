import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessContext, HarnessProvisioner, ServerPackageHost } from "@polyth/contracts";
import { createHarnessRegistry, planHarnessCapabilities } from "@polyth/harness-runtime";
import { bindPackageServices, discoverServerPackages, loadServerPackage } from "@polyth/plugins";
import { secureSafeSkill } from "@polyth/credential-vault";

const context: HarnessContext = {
  spaceId: "spc_a",
  projectId: "project-a",
  cwd: "/tmp/project-a",
  sessionId: "session-a",
  remote: false,
};

// Backends are discovered from their manifests, so removing one stops the
// coverage for it; the host never names a removable package.
const packagesDir = resolve(import.meta.dirname, "../..");
const provisioners = new Map<string, HarnessProvisioner>();
for (const discovered of (await discoverServerPackages(packagesDir)).filter((pkg) => pkg.id.startsWith("backend-"))) {
  const harnesses = createHarnessRegistry();
  const services = new Map<string, unknown>();
  services.set("polyth.service.harnesses", harnesses);
  services.set("polyth.service.opencode.runtime", async (): Promise<never> => {
    throw new Error("test must not construct an OpenCode runtime");
  });
  services.set("polyth.service.plugins.config", { applyBehavior() {}, applyMcp() {}, listPlugins() {}, applyPlugins() {}, removePlugin() {} });
  const host = {
    pluginId: discovered.id,
    storageDir: join(tmpdir(), "polyth-secure-safe-harnesses"),
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
  for (const provider of harnesses.providers()) {
    if (provider.provisioner) provisioners.set(provider.descriptor.id, provider.provisioner);
  }
}

test("Secure Safe's canonical deployment skill has a projection in every shipped harness", async () => {
  const modes: Record<string, string> = {};
  for (const [id, provisioner] of provisioners) {
    const support = await provisioner.support(context);
    const plan = planHarnessCapabilities(
      id,
      [secureSafeSkill.descriptor],
      support,
      context,
    );
    const item = plan.items[0];
    assert.ok(item, `${id} should plan Secure Safe`);
    assert.notEqual(item.mode, "unsupported", `${id} must project Secure Safe`);
    modes[id] = item.mode;
  }

  assert.deepEqual(modes, {
    codex: "native",
    claude: "filesystem",
    opencode: "filesystem",
    commandcode: "native",
    pi: "prompt",
    antigravity: "prompt",
    cursor: "prompt",
    fx: "prompt",
    grok: "prompt",
    deepseek: "prompt",
    omp: "prompt",
  });
});
