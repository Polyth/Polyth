import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntime, HarnessContext, HarnessProvider } from "@polyth/contracts";
import { createHarnessRegistry } from "../src/index.ts";

const context = {
  spaceId: "space",
  projectId: "project",
  cwd: "/project",
  remote: false,
} as HarnessContext;

function provider(counters: { probes: number; discovers: number }): HarnessProvider {
  return {
    descriptor: { id: "fast", name: "Fast", integration: "test", priority: 0 },
    async probe() {
      counters.probes += 1;
      return {
        harnessId: "fast",
        installed: true,
        healthy: true,
        authenticated: "unknown",
        state: "unknown",
      };
    },
    async discover() {
      counters.discovers += 1;
      return {
        state: "ready",
        authenticated: true,
        catalog: { models: [] },
      };
    },
    async createRuntime() {
      return {} as AgentRuntime;
    },
  } as HarnessProvider;
}

test("resolve reuses a fresh detailed snapshot without probe/discover", async () => {
  const counters = { probes: 0, discovers: 0 };
  const registry = createHarnessRegistry();
  registry.register(provider(counters));

  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.deepEqual(counters, { probes: 1, discovers: 1 });

  const selected = await registry.resolve(context, { mode: "pinned", harnessId: "fast" });
  assert.equal(selected.descriptor.id, "fast");
  assert.deepEqual(counters, { probes: 1, discovers: 1 });
});

test("summary readiness is refined once, then reused by warm resolves", async () => {
  const counters = { probes: 0, discovers: 0 };
  const registry = createHarnessRegistry();
  registry.register(provider(counters));

  await registry.snapshots(context, { harnessId: "fast" });
  assert.deepEqual(counters, { probes: 1, discovers: 0 });

  await registry.resolve(context, { mode: "pinned", harnessId: "fast" });
  assert.deepEqual(counters, { probes: 2, discovers: 1 });

  await registry.resolve(context, { mode: "pinned", harnessId: "fast" });
  assert.deepEqual(counters, { probes: 2, discovers: 1 });

  // Readiness discovery is not full metadata discovery. A later detail request
  // must still materialize catalog/capabilities/configuration exactly once.
  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.deepEqual(counters, { probes: 3, discovers: 2 });

  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.deepEqual(counters, { probes: 3, discovers: 2 });
});
