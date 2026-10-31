import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, HarnessContext, HarnessProvider, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry, createHarnessRegistry } from "@polyth/harness-runtime";
import { createOpenCodeHarness, createOpenCodeProvisioner } from "@polyth/backend-opencode";
import { createKeyedRuntimeOwner } from "../src/runtimeOccupancy.ts";
import { createCapabilityProvisioningController, reconcilePinnedHarness } from "../src/capabilityProvisioning.ts";
import { createBehaviorService } from "../src/behavior.ts";
import { createMcpConfigService } from "../src/mcp.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-deadlock-"));

const spaceOf = (dir: string): SpaceContext => ({
  spaceId: "spc_test",
  spaceSlug: "test",
  userId: "usr_test",
  role: "owner",
  deployment: "local-trusted",
  storageDir: dir,
});

const raceDeadlock = <T,>(work: Promise<T>, ms = 2500): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("physical creation deadlocked")), ms);
    }),
  ]);

test("OpenCode physical creation via reconcilePinnedHarness does not probe-resolve through the same acquire key", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "project");
  mkdirSync(cwd, { recursive: true });
  const context: HarnessContext = { spaceId: space.spaceId, projectId: "p1", cwd, space };
  const registry = createHarnessRegistry();
  let probeEnteredDuringCreate = 0;
  let creating = false;
  const owner = createKeyedRuntimeOwner<AgentRuntime>();
  const key = JSON.stringify(["p1", cwd]);
  let controller: ReturnType<typeof createCapabilityProvisioningController>;

  const fakeRuntime = {
    dispose: async () => {},
    models: async () => [],
    sessions: async () => [],
    history: async () => [],
  } as AgentRuntime;

  const runtime = async (ctx: HarnessContext): Promise<AgentRuntime> => {
    const record = await owner.acquire(key, async () => {
      creating = true;
      try {
        // This is the exact production seam: `packages/server/src/index.ts`'s
        // physical acquire factory calls this same helper. If it is ever
        // changed to call `harnesses.resolve({ mode: "pinned", ... })`
        // instead, this test's second case (resolve() deadlocks) shows why
        // that would hang: resolve() probes, and probe() calls runtime(),
        // which acquire()s this SAME key while the create is still pending.
        await reconcilePinnedHarness(controller, registry, "opencode", ctx);
        return { value: fakeRuntime, dispose: async () => {} };
      } finally {
        creating = false;
      }
    });
    return record.value;
  };

  const harness = createOpenCodeHarness(runtime);
  const originalProbe = harness.probe.bind(harness);
  harness.probe = async (ctx) => {
    if (creating) probeEnteredDuringCreate += 1;
    return originalProbe(ctx);
  };
  harness.provisioner = createOpenCodeProvisioner({
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as never);
  registry.register(harness);

  controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: registry,
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
  });

  const completed = await raceDeadlock(harness.createRuntime(context).then(() => "ok" as const));
  assert.equal(completed, "ok");
  assert.equal(probeEnteredDuringCreate, 0);
});

test("using registry.resolve() inside physical create deadlocks (regression proof for the fix above)", async () => {
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const cwd = join(dataDir, "project");
  mkdirSync(cwd, { recursive: true });
  const context: HarnessContext = { spaceId: space.spaceId, projectId: "p1", cwd, space };
  const registry = createHarnessRegistry();
  const owner = createKeyedRuntimeOwner<AgentRuntime>();
  const key = JSON.stringify(["p1", cwd]);
  let controller: ReturnType<typeof createCapabilityProvisioningController>;

  const fakeRuntime = {
    dispose: async () => {},
    models: async () => [],
    sessions: async () => [],
    history: async () => [],
  } as AgentRuntime;

  const runtime = async (ctx: HarnessContext): Promise<AgentRuntime> => {
    const record = await owner.acquire(key, async () => {
      // The regressed path: resolve() probes every candidate, and probe()
      // calls back into `runtime()`, which tries to `acquire()` the SAME
      // key this factory is already creating under — the owner has no
      // reentrant path for that, so this never returns.
      const provider = await registry.resolve(ctx, { mode: "pinned", harnessId: "opencode" });
      await controller.reconcile(provider, ctx);
      return { value: fakeRuntime, dispose: async () => {} };
    });
    return record.value;
  };

  const harness = createOpenCodeHarness(runtime);
  harness.provisioner = createOpenCodeProvisioner({
    applyBehavior: async () => 0,
    applyMcp: async () => {},
  } as never);
  registry.register(harness);

  controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: registry,
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
  });

  await assert.rejects(
    () => raceDeadlock(harness.createRuntime(context).then(() => "ok" as const), 500),
    /physical creation deadlocked/,
  );
});

test("registry.get is an exact lookup without probe", async () => {
  const registry = createHarnessRegistry();
  let probed = false;
  const provider: HarnessProvider = {
    descriptor: { id: "opencode", name: "OpenCode", priority: 0, integration: "test" },
    probe: async () => {
      probed = true;
      return { harnessId: "opencode", installed: true, authenticated: true, healthy: true };
    },
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
  };
  registry.register(provider);
  assert.equal(registry.get("opencode"), provider);
  assert.equal(registry.get("missing"), undefined);
  assert.equal(probed, false);
});

test("reconcilePinnedHarness uses an exact lookup, never resolve()", async () => {
  const registry = createHarnessRegistry();
  let resolved = false;
  const originalResolve = registry.resolve.bind(registry);
  registry.resolve = async (...args) => {
    resolved = true;
    return originalResolve(...args);
  };
  const dataDir = tmp();
  const space = spaceOf(dataDir);
  const provider: HarnessProvider = {
    descriptor: { id: "opencode", name: "OpenCode", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "opencode", installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
    provisioner: createOpenCodeProvisioner({ applyBehavior: async () => 0, applyMcp: async () => {} } as never),
  };
  registry.register(provider);
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: registry,
    behavior: createBehaviorService({ file: join(dataDir, "behavior.md") }),
    mcp: createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId }),
    file: join(dataDir, "status.json"),
  });
  await reconcilePinnedHarness(controller, registry, "opencode", {
    spaceId: space.spaceId,
    projectId: "p",
    cwd: dataDir,
    space,
  });
  assert.equal(resolved, false);
});
