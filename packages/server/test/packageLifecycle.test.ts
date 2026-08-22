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
