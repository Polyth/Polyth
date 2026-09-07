import test from "node:test";
import assert from "node:assert/strict";
import { createPackageLifecycle } from "../src/packageLifecycle.ts";
import { createRouteRegistry } from "../src/routeRegistry.ts";
import type { PackageRegistry } from "../src/packages.ts";

test("enable and disable run registered hooks once per transition", async () => {
  const lifecycle = createPackageLifecycle(createRouteRegistry());
  const calls: string[] = [];
  lifecycle.register("usage", {
    onEnable: () => { calls.push("enable"); },
    onDisable: () => { calls.push("disable"); },
  });

  await lifecycle.enable("usage");
  await lifecycle.enable("usage");
  await lifecycle.disable("usage");
  await lifecycle.disable("usage");

  assert.deepEqual(calls, ["enable", "disable"]);
});

test("package transitions are serialized by id", async () => {
  const lifecycle = createPackageLifecycle(createRouteRegistry());
  const calls: string[] = [];
  let finishEnable!: () => void;
  const enablePending = new Promise<void>((resolve) => { finishEnable = resolve; });
  lifecycle.register("schedule", {
    async onEnable() {
      calls.push("enable:start");
      await enablePending;
      calls.push("enable:end");
    },
    onDisable() {
      calls.push("disable");
    },
  });

  const enabling = lifecycle.enable("schedule");
  await Promise.resolve();
  const disabling = lifecycle.disable("schedule");
  await Promise.resolve();
  assert.deepEqual(calls, ["enable:start"]);

  finishEnable();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(calls, ["enable:start", "enable:end", "disable"]);
});

test("startEnabled starts every enabled package", async () => {
  const lifecycle = createPackageLifecycle(createRouteRegistry());
  const calls: string[] = [];
  lifecycle.register("enabled", { onEnable: () => { calls.push("enabled"); } });
  lifecycle.register("disabled", { onEnable: () => { calls.push("disabled"); } });
  const registry = {
    list: () => [
      { id: "enabled", enabled: true },
      { id: "disabled", enabled: false },
    ],
    isEnabled: (id: string) => id === "enabled",
  } as unknown as PackageRegistry;

  await lifecycle.startEnabled(registry);

  assert.deepEqual(calls, ["enabled"]);
});

test("startEnabled continues after an enabled package fails", async () => {
  const lifecycle = createPackageLifecycle(createRouteRegistry());
  const calls: string[] = [];
  lifecycle.register("broken", {
    onEnable: () => {
      calls.push("broken");
      throw new Error("boot failed");
    },
  });
  lifecycle.register("healthy", { onEnable: () => { calls.push("healthy"); } });
  const registry = {
    list: () => [
      { id: "broken", enabled: true },
      { id: "healthy", enabled: true },
    ],
    isEnabled: () => true,
  } as unknown as PackageRegistry;

  await lifecycle.startEnabled(registry);

  assert.deepEqual(calls, ["broken", "healthy"]);
});

test("stopIngress detaches owners without disabling packages", async () => {
  const lifecycle = createPackageLifecycle(createRouteRegistry());
  const calls: string[] = [];
  lifecycle.register("terminal", {
    onEnable: () => { calls.push("enable"); },
    onDisable: () => { calls.push("disable"); },
    stopIngress: () => { calls.push("stop-ingress"); },
  });
  await lifecycle.enable("terminal");
  await lifecycle.stopIngress();
  assert.deepEqual(calls, ["enable", "stop-ingress"]);
  await lifecycle.disable("terminal");
  assert.deepEqual(calls, ["enable", "stop-ingress", "disable"]);
});

test("stopIngress logs a warning when a detacher throws and continues", async () => {
  const lifecycle = createPackageLifecycle(createRouteRegistry());
  const calls: string[] = [];
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    lifecycle.register("broken", {
      stopIngress: () => {
        calls.push("broken");
        throw new Error("detach failed");
      },
    });
    lifecycle.register("healthy", {
      stopIngress: () => { calls.push("healthy"); },
    });
    await lifecycle.stopIngress();
    assert.deepEqual(calls, ["broken", "healthy"]);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]![0]), /package "broken" failed to stop ingress/);
    assert.equal((warnings[0]![1] as Error).message, "detach failed");
  } finally {
    console.warn = original;
  }
});
