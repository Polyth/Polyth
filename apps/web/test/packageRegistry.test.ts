import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { PackageDescriptorDto } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

const descriptors = new Map<string, PackageDescriptorDto>([
  ["models", {
    id: "models",
    name: "Providers & Models",
    description: "Model configuration.",
    core: true,
    enabled: true,
    hasSettings: true,
  }],
  ["dictation", {
    id: "dictation",
    name: "Voice & Dictation",
    description: "Voice controls.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["usage", {
    id: "usage",
    name: "Usage",
    description: "Usage reporting.",
    core: false,
    enabled: true,
    hasSettings: true,
  }],
  ["git", {
    id: "git",
    name: "Git",
    description: "Source control.",
    core: true,
    enabled: true,
    hasSettings: true,
  }],
  ["workflow", {
    id: "workflow",
    name: "Workflows",
    description: "Workflow orchestration.",
    core: false,
    enabled: true,
    hasSettings: false,
  }],
]);

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => String(input).endsWith("/web-packages/manifest.json")
      ? { packages: [] }
      : { packages: [...descriptors.values()] },
    text: async () => "",
  }),
});

const { bootPackages, isPackageEnabled, subscribePackages } =
  await import("../src/packages/registry.ts");
const { getState, setActiveView } = await import("../src/store.ts");

test("package state follows server descriptors when the web manifest is empty", async () => {
  let notifications = 0;
  const unsubscribe = subscribePackages(() => { notifications++; });
  await bootPackages();

  assert.equal(isPackageEnabled("voice"), true, "dictation aliases to the voice UI package");
  assert.equal(isPackageEnabled("usage"), true);
  assert.equal(isPackageEnabled("git"), true);
  assert.equal(isPackageEnabled("workflow"), true);

  setActiveView("workflow");
  descriptors.get("dictation")!.enabled = false;
  descriptors.get("usage")!.enabled = false;
  descriptors.get("git")!.enabled = false;
  descriptors.get("workflow")!.enabled = false;
  await bootPackages();

  assert.equal(isPackageEnabled("voice"), false);
  assert.equal(getState().activeView, "session", "disabling the active workflow package returns to chat");
  assert.equal(notifications, 2);
  unsubscribe();
});
