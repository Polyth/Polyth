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

let harnessRosterRequests = 0;
let harnessRoster = [
  { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
];

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        if (url.includes("/api/harnesses/roster")) {
          harnessRosterRequests++;
          return harnessRoster;
        }
        return url.endsWith("/packages-manifest.json")
          ? { packages: [] }
          : { packages: [...descriptors.values()] };
      },
      text: async () => "",
    };
  },
});

const { bootPackages, isPackageEnabled, reconcilePackage, subscribePackages } =
  await import("../src/packages/registry.ts");
const { getState, setActiveView } = await import("../src/store.ts");
const { invalidateRuntimeCatalogs, readHarnessRoster } =
  await import("@polyth/models/runtime-catalog");

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

test("backend package changes invalidate the cached harness roster", async () => {
  invalidateRuntimeCatalogs();
  harnessRosterRequests = 0;
  harnessRoster = [
    { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
  ];
  const scope = { projectId: "project-a", spaceId: "space-a" };

  assert.deepEqual((await readHarnessRoster(scope)).map((row) => row.identity.id), ["codex"]);
  assert.equal(harnessRosterRequests, 1);

  harnessRoster = [
    ...harnessRoster,
    { identity: { id: "commandcode", name: "Command Code", integration: "Headless + Mod" }, policy: { enabled: true, priority: 65, autoSelect: false } },
  ];
  assert.deepEqual((await readHarnessRoster(scope)).map((row) => row.identity.id), ["codex"], "page-lifetime roster is cached before package topology changes");
  assert.equal(harnessRosterRequests, 1);

  reconcilePackage({
    id: "backend-commandcode",
    name: "Command Code harness",
    description: "Command Code native harness",
    core: false,
    enabled: true,
    hasSettings: false,
  });

  assert.deepEqual((await readHarnessRoster(scope)).map((row) => row.identity.id), ["codex", "commandcode"]);
  assert.equal(harnessRosterRequests, 2, "backend package activation must force a fresh harness roster");
});
