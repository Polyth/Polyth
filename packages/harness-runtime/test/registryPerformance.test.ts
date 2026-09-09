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
        catalog: { models: [{ providerID: "test", modelID: "model", name: "Model" }] },
      };
    },
    async createRuntime() {
      return {} as AgentRuntime;
    },
  } as HarnessProvider;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

test("detail catalog stays warm across summary TTL refreshes and expires independently", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const counters = { probes: 0, discovers: 0 };
  const registry = createHarnessRegistry();
  registry.register(provider(counters));

  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.deepEqual(counters, { probes: 1, discovers: 1 });

  now += 16_000;
  const refreshed = (await registry.snapshots(context, { harnessId: "fast", detail: true }))[0]!;
  assert.equal(refreshed.catalog?.models?.[0]?.modelID, "model");
  assert.deepEqual(counters, { probes: 2, discovers: 1 });

  now += 5 * 60_000;
  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.deepEqual(counters, { probes: 3, discovers: 2 });
});

test("forced summary fences its old catalog and an overlapping detail upgrades to fresh metadata", async () => {
  const forcedProbeStarted = deferred<void>();
  const forcedProbeGate = deferred<void>();
  let probes = 0;
  let discovers = 0;
  const registry = createHarnessRegistry();
  registry.register({
    ...provider({ probes: 0, discovers: 0 }),
    async probe() {
      probes += 1;
      if (probes === 2) {
        forcedProbeStarted.resolve();
        await forcedProbeGate.promise;
      }
      return { harnessId: "fast", installed: true, healthy: true, authenticated: true };
    },
    async discover() {
      discovers += 1;
      return {
        catalog: { models: [{ providerID: "test", modelID: `model-${discovers}`, name: `Model ${discovers}` }] },
      };
    },
  });

  const initial = await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.equal(initial[0]?.catalog?.models?.[0]?.modelID, "model-1");

  const forcedSummary = registry.snapshots(context, { harnessId: "fast", force: true });
  await forcedProbeStarted.promise;
  let detailSettled = false;
  const detail = registry.snapshots(context, { harnessId: "fast", detail: true })
    .finally(() => { detailSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detailSettled, false, "fresh-cache fast path must not bypass the forced summary");

  forcedProbeGate.resolve();
  assert.equal((await forcedSummary)[0]?.catalog?.models?.[0]?.modelID, "model-1");
  assert.equal((await detail)[0]?.catalog?.models?.[0]?.modelID, "model-2");
  assert.deepEqual({ probes, discovers }, { probes: 2, discovers: 2 });
});

test("fresh catalog metadata cannot hide a newer unknown readiness probe after sign-out", async (t) => {
  let now = 20_000;
  t.mock.method(Date, "now", () => now);
  let signedOut = false;
  let discovers = 0;
  const registry = createHarnessRegistry();
  registry.register({
    ...provider({ probes: 0, discovers: 0 }),
    async probe() {
      return {
        harnessId: "fast",
        installed: true,
        healthy: true,
        authenticated: "unknown",
        state: "unknown",
      };
    },
    async discover() {
      discovers += 1;
      return signedOut
        ? { state: "auth-required" as const, authenticated: false }
        : {
            state: "ready" as const,
            authenticated: true,
            catalog: { models: [{ providerID: "test", modelID: "signed-in", name: "Signed in" }] },
          };
    },
  });

  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.equal(discovers, 1);
  signedOut = true;
  now += 16_000;
  const summary = await registry.snapshots(context, { harnessId: "fast" });
  assert.equal(summary[0]?.availability.state, "unknown");
  assert.equal(summary[0]?.catalog?.models?.[0]?.modelID, "signed-in");

  await assert.rejects(
    registry.resolve(context, { mode: "pinned", harnessId: "fast" }),
    { code: "runtime-unavailable" },
  );
  assert.equal(discovers, 2, "resolve must refine readiness despite a warm catalog");
});

test("a detail request upgrades an overlapping summary flight and detail callers share it", async () => {
  const probeGate = deferred<void>();
  const probeStarted = deferred<void>();
  let probes = 0;
  let discovers = 0;
  const registry = createHarnessRegistry();
  registry.register({
    ...provider({ probes: 0, discovers: 0 }),
    async probe() {
      probes += 1;
      probeStarted.resolve();
      await probeGate.promise;
      return { harnessId: "fast", installed: true, healthy: true, authenticated: true };
    },
    async discover() {
      discovers += 1;
      return { catalog: { models: [{ providerID: "test", modelID: "detail", name: "Detail" }] } };
    },
  });

  const summary = registry.snapshots(context, { harnessId: "fast" });
  await probeStarted.promise;
  const detailA = registry.snapshots(context, { harnessId: "fast", detail: true });
  const detailB = registry.snapshots(context, { harnessId: "fast", detail: true });
  probeGate.resolve();

  assert.equal((await summary)[0]?.catalog, undefined);
  assert.equal((await detailA)[0]?.catalog?.models?.[0]?.modelID, "detail");
  assert.equal((await detailB)[0]?.catalog?.models?.[0]?.modelID, "detail");
  assert.deepEqual({ probes, discovers }, { probes: 1, discovers: 1 });
});

test("invalidation during discovery fences the stale result from repopulating the cache", async () => {
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  let discovers = 0;
  const registry = createHarnessRegistry();
  const p = provider({ probes: 0, discovers: 0 });
  p.discover = async () => {
    discovers += 1;
    const ordinal = discovers;
    if (ordinal === 1) {
      firstStarted.resolve();
      await firstGate.promise;
    }
    return { catalog: { models: [{ providerID: "test", modelID: `model-${ordinal}`, name: `Model ${ordinal}` }] } };
  };
  registry.register(p);

  const staleFlight = registry.snapshots(context, { harnessId: "fast", detail: true });
  await firstStarted.promise;
  registry.invalidate({
    spaceId: context.spaceId,
    projectId: context.projectId,
    cwd: context.cwd,
    remote: context.remote,
    harnessId: "fast",
  });
  firstGate.resolve();
  assert.equal((await staleFlight)[0]?.catalog?.models?.[0]?.modelID, "model-1");

  const refreshed = (await registry.snapshots(context, { harnessId: "fast", detail: true }))[0]!;
  assert.equal(refreshed.catalog?.models?.[0]?.modelID, "model-2");
  await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.equal(discovers, 2);
});

test("explicit invalidation does not restore a previous account catalog on auth failure", async () => {
  let failAuthentication = false;
  const registry = createHarnessRegistry();
  const p = provider({ probes: 0, discovers: 0 });
  p.discover = async () => {
    if (failAuthentication) throw new Error("authentication expired");
    return { catalog: { models: [{ providerID: "test", modelID: "old-account", name: "Old account" }] } };
  };
  registry.register(p);

  const initial = await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.equal(initial[0]?.catalog?.models?.[0]?.modelID, "old-account");
  registry.invalidate({ ...context, harnessId: "fast" });
  failAuthentication = true;
  const unauthenticated = await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.equal(unauthenticated[0]?.availability.state, "auth-required");
  assert.equal(unauthenticated[0]?.catalog, undefined);
  assert.equal(unauthenticated[0]?.stale, undefined);
});

test("a forced refresh wins over an older pending detail regardless of completion order", async () => {
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  let discovers = 0;
  const registry = createHarnessRegistry();
  const p = provider({ probes: 0, discovers: 0 });
  p.discover = async () => {
    discovers += 1;
    const ordinal = discovers;
    if (ordinal === 1) {
      firstStarted.resolve();
      await firstGate.promise;
    }
    return { catalog: { models: [{ providerID: "test", modelID: `model-${ordinal}`, name: `Model ${ordinal}` }] } };
  };
  registry.register(p);

  const oldFlight = registry.snapshots(context, { harnessId: "fast", detail: true });
  await firstStarted.promise;
  const forced = await registry.snapshots(context, { harnessId: "fast", detail: true, force: true });
  assert.equal(forced[0]?.catalog?.models?.[0]?.modelID, "model-2");
  firstGate.resolve();
  assert.equal((await oldFlight)[0]?.catalog?.models?.[0]?.modelID, "model-1");

  const warm = await registry.snapshots(context, { harnessId: "fast", detail: true });
  assert.equal(warm[0]?.catalog?.models?.[0]?.modelID, "model-2");
  assert.equal(discovers, 2);
});

test("catalog snapshots are isolated by Space, project, cwd, remote target, and harness", async () => {
  const calls: string[] = [];
  const registry = createHarnessRegistry();
  for (const id of ["fast", "other"]) {
    registry.register({
      ...provider({ probes: 0, discovers: 0 }),
      descriptor: { id, name: id, integration: "test", priority: id === "fast" ? 0 : 1 },
      async probe(target) {
        return { harnessId: id, installed: true, healthy: true, authenticated: true };
      },
      async discover(target) {
        const targetKey = [target.spaceId, target.projectId, target.cwd, target.remote ?? false, id].join(":");
        calls.push(targetKey);
        return { catalog: { models: [{ providerID: "test", modelID: targetKey, name: targetKey }] } };
      },
    });
  }
  const targets: HarnessContext[] = [
    context,
    { ...context, spaceId: "space-2" },
    { ...context, projectId: "project-2" },
    { ...context, cwd: "/other" },
    { ...context, remote: true },
  ];

  for (const target of targets) {
    await registry.snapshots(target, { harnessId: "fast", detail: true });
  }
  await registry.snapshots(context, { harnessId: "other", detail: true });
  for (const target of targets) {
    await registry.snapshots(target, { harnessId: "fast", detail: true });
  }
  await registry.snapshots(context, { harnessId: "other", detail: true });
  assert.equal(calls.length, 6);

  registry.invalidate({ ...context, harnessId: "fast" });
  await registry.snapshots(context, { harnessId: "fast", detail: true });
  await registry.snapshots({ ...context, remote: true }, { harnessId: "fast", detail: true });
  assert.equal(calls.length, 7, "local invalidation must not evict the remote target");
});
