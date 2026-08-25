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
  value: async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ packages: [...descriptors.values()] }),
    text: async () => "",
  }),
});

const { bootPackages, isPackageEnabled, subscribePackages } =
  await import("../src/packages/registry.ts");
const { listSlots } = await import("../src/slots.ts");
const { listWidgets } = await import("../src/widgets/catalog.ts");
const { getCapability } = await import("../src/capabilities.ts");
const { getState, setActiveView } = await import("../src/store.ts");

test("package boot installs and removes package-owned settings and widgets", async () => {
  let notifications = 0;
  const unsubscribe = subscribePackages(() => { notifications++; });
  await bootPackages();

  assert.equal(isPackageEnabled("voice"), true, "dictation aliases to the voice UI package");
  assert.ok(listSlots("settings.pages").some((item) => item.id === "voice"));
  assert.ok(listSlots("settings.pages").some((item) => item.id === "usage"));
  assert.ok(listSlots("settings.pages").some((item) => item.id === "models"));
  assert.ok(listSlots("settings.pages").some((item) => item.id === "agents"));
  assert.ok(listSlots("settings.pages").some((item) => item.id === "git"));
  assert.ok(listWidgets().some((item) => item.pluginId === "voice"));
  assert.ok(listWidgets().some((item) => item.pluginId === "usage"));
  assert.equal(listWidgets().find((item) => item.id === "git.pending-changes")?.defaultSlot, "session.footer");
  assert.ok(getCapability("workflow"), "enabled workflow package installs its navigation capability");
  assert.equal(listWidgets().find((item) => item.id === "workflow.composer-action")?.defaultSlot, "composer.trailing");

  setActiveView("workflow");
  descriptors.get("dictation")!.enabled = false;
  descriptors.get("usage")!.enabled = false;
  descriptors.get("git")!.enabled = false;
  descriptors.get("workflow")!.enabled = false;
  await bootPackages();

  assert.equal(isPackageEnabled("voice"), false);
  assert.equal(listSlots("settings.pages").some((item) => item.id === "voice"), false);
  assert.equal(listSlots("settings.pages").some((item) => item.id === "usage"), false);
  assert.equal(listSlots("settings.pages").some((item) => item.id === "git"), false);
  assert.equal(listWidgets().some((item) => item.pluginId === "voice"), false);
  assert.equal(listWidgets().some((item) => item.pluginId === "usage"), false);
  assert.equal(listWidgets().some((item) => item.pluginId === "git"), false);
  assert.equal(getCapability("workflow"), null);
  assert.equal(listWidgets().some((item) => item.pluginId === "workflow"), false);
  assert.equal(getState().activeView, "session", "disabling the active workflow package returns to chat");
  assert.equal(notifications, 2);
  unsubscribe();
});
