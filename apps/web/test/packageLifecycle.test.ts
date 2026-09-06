import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { PackageDescriptorDto } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});

type PackageState = { enabled: boolean };
const packages = new Map<string, PackageState>([
  ["models", { enabled: true }],
  ["alpha", { enabled: false }],
  ["beta", { enabled: false }],
  ["dictation", { enabled: false }],
]);

const catalog = [
  { id: "alpha", module: "/packages/alpha/entry.js", styles: ["/packages/alpha/entry.css"] },
  { id: "beta", module: "/packages/beta/entry.js", styles: ["/packages/beta/entry.css"] },
  { id: "dictation", module: "/packages/dictation/entry.js", styles: ["/packages/dictation/entry.css"] },
];

const importCounts = new Map<string, number>();
const factoryCounts = new Map<string, number>();
const installerCounts = new Map<string, number>();
const held = new Set<string>();
const pending = new Map<string, { resolve: (value: unknown) => void; promise: Promise<unknown> }>();
const shouldFail = new Set<string>();

function hold(id: string): Promise<unknown> {
  const existing = pending.get(id);
  if (existing) return existing.promise;
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((next) => { resolve = next; });
  pending.set(id, { resolve, promise });
  return promise;
}

function descriptor(id: string, enabled: boolean): PackageDescriptorDto {
  return {
    id,
    name: id,
    description: id,
    core: false,
    enabled,
    hasSettings: true,
  };
}

function factoryFor(id: string) {
  return (host: WebPackageHost) => {
    factoryCounts.set(id, (factoryCounts.get(id) ?? 0) + 1);
    if (id === "alpha") {
      host.widgets.register("alpha", {
        id: "alpha.widget",
        title: "Alpha",
        description: "Alpha",
        render: () => null,
      });
      host.projectContext.register({
        id: "alpha.context",
        order: 10,
        getSnapshot: (projectId) => ({
          title: "Git",
          items: [{ label: "Repo", value: projectId === "project-b" ? "Alpha" : "Alpha" }],
          recommendedWidgetIds: ["alpha.widget"],
        }),
      });
    }
    if (id === "beta") {
      host.widgets.register("beta", {
        id: "beta.widget",
        title: "Beta",
        description: "Beta",
        render: () => null,
      });
      let campaign = "Spring";
      let needsSetup = false;
      const listeners = new Set<() => void>();
      (globalThis as { __betaCampaign?: (value: string) => void }).__betaCampaign = (value) => {
        campaign = value;
        for (const listener of listeners) listener();
      };
      (globalThis as { __betaNeedsSetup?: (value: boolean) => void }).__betaNeedsSetup = (value) => {
        needsSetup = value;
        for (const listener of listeners) listener();
      };
      (globalThis as { __betaOpened?: number }).__betaOpened = 0;
      host.projectContext.register({
        id: "beta.context",
        order: 20,
        getSnapshot: (projectId) => {
          if (projectId === "project-b") return null;
          return {
            title: "Marketing",
            items: [{ label: "Campaign", value: campaign }],
            recommendedWidgetIds: ["beta.widget"],
            ...(needsSetup
              ? {
                needsSetup: {
                  label: "Configure campaign",
                  open: () => { (globalThis as { __betaOpened?: number }).__betaOpened = ((globalThis as { __betaOpened?: number }).__betaOpened ?? 0) + 1; },
                },
              }
              : {}),
          };
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      });
    }
    if (id === "dictation") {
      host.settings.registerPage({
        id: "voice",
        label: "Voice",
        group: "Workspace",
        component: () => null,
      });
      host.capabilities.register({
        id: "voice",
        label: "Voice input",
        plainDescription: "Talk",
        keywords: ["voice"],
        standardTier: "more",
        standardRank: 19,
        open: () => {},
        available: () => true,
      });
      host.widgets.registerPlugin({
        id: "voice",
        name: "Voice",
        widgets: [{
          id: "voice.lifecycle-mic",
          title: "Mic",
          description: "Mic",
          kind: "mini-widget",
          defaultSlot: "composer.leading",
          supportedSlots: ["composer.leading"],
          render: () => null,
        }],
      });
    }
    return () => {
      installerCounts.set(id, (installerCounts.get(id) ?? 0) + 1);
      return () => {};
    };
  };
}

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/packages-manifest.json")) {
      return { ok: true, status: 200, json: async () => ({ packages: catalog }), text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        packages: [...packages.entries()].map(([id, state]): PackageDescriptorDto => ({
          id,
          name: id,
          description: id,
          core: id === "models",
          enabled: state.enabled,
          hasSettings: true,
        })),
      }),
      text: async () => "",
    };
  },
});

const { bootPackages, configureWebPackageLoader, isPackageEnabled, reconcilePackage, whenPackagesSettled } =
  await import("../src/packages/registry.ts");
const { listWidgets } = await import("../src/widgets/catalog.ts");
const { listSlots } = await import("../src/slots.ts");
const { getCapability } = await import("../src/capabilities.ts");
const { listProjectContextSnapshots, listProjectContextRecommendedWidgetIds } =
  await import("../src/packages/projectContext.ts");

configureWebPackageLoader({
  document: dom.document as unknown as Document,
  importModule: async (url) => {
    const id = url.split("/")[2] ?? "";
    importCounts.set(id, (importCounts.get(id) ?? 0) + 1);
    if (shouldFail.has(id)) {
      shouldFail.delete(id);
      throw new Error(`${id} missing`);
    }
    if (held.has(id)) {
      held.delete(id);
      return hold(id);
    }
    return { default: factoryFor(id) };
  },
});

function styleCount(id: string): number {
  return [...dom.document.querySelectorAll("link[data-polyth-web-package-style]")]
    .filter((link) => ((link as unknown as HTMLLinkElement).href.includes(`/packages/${id}/`))).length;
}

test("disabled packages never import, factory, install, style, or register", async () => {
  await bootPackages();
  assert.equal(isPackageEnabled("alpha"), false);
  assert.equal(importCounts.get("alpha") ?? 0, 0);
  assert.equal(factoryCounts.get("alpha") ?? 0, 0);
  assert.equal(installerCounts.get("alpha") ?? 0, 0);
  assert.equal(styleCount("alpha"), 0);
  assert.equal(listWidgets().some((widget) => widget.id === "alpha.widget"), false);
});

test("enable, disable, and re-enable create exactly one live activation", async () => {
  packages.get("alpha")!.enabled = true;
  await bootPackages();
  assert.equal(isPackageEnabled("alpha"), true);
  assert.equal(importCounts.get("alpha"), 1);
  assert.equal(factoryCounts.get("alpha"), 1);
  assert.equal(installerCounts.get("alpha"), 1);
  assert.equal(styleCount("alpha"), 1);
  assert.equal(listWidgets().some((widget) => widget.id === "alpha.widget"), true);

  packages.get("alpha")!.enabled = false;
  await bootPackages();
  assert.equal(isPackageEnabled("alpha"), false);
  assert.equal(listWidgets().some((widget) => widget.id === "alpha.widget"), false);
  assert.equal(styleCount("alpha"), 0);

  packages.get("alpha")!.enabled = true;
  await bootPackages();
  assert.equal(importCounts.get("alpha"), 2);
  assert.equal(factoryCounts.get("alpha"), 2);
  assert.equal(installerCounts.get("alpha"), 2);
  assert.equal(styleCount("alpha"), 1);
  assert.equal(listWidgets().filter((widget) => widget.id === "alpha.widget").length, 1);
});

test("enable then disable before import resolves publishes nothing", async () => {
  held.add("beta");
  packages.get("beta")!.enabled = true;
  reconcilePackage(descriptor("beta", true));
  await Promise.resolve();
  packages.get("beta")!.enabled = false;
  reconcilePackage(descriptor("beta", false));
  pending.get("beta")?.resolve({ default: factoryFor("beta") });
  pending.delete("beta");
  await whenPackagesSettled();
  assert.equal(isPackageEnabled("beta"), false);
  assert.equal(listWidgets().some((widget) => widget.id === "beta.widget"), false);
  assert.equal(styleCount("beta"), 0);
  assert.equal(factoryCounts.get("beta") ?? 0, 0);
});

test("re-enable while generation 1 is in flight lets generation 2 win", async () => {
  held.add("beta");
  packages.get("beta")!.enabled = true;
  reconcilePackage(descriptor("beta", true));
  await Promise.resolve();
  packages.get("beta")!.enabled = false;
  reconcilePackage(descriptor("beta", false));
  held.add("beta");
  packages.get("beta")!.enabled = true;
  reconcilePackage(descriptor("beta", true));
  const first = pending.get("beta");
  first?.resolve({ default: factoryFor("beta") });
  pending.delete("beta");
  await Promise.resolve();
  pending.get("beta")?.resolve({ default: factoryFor("beta") });
  pending.delete("beta");
  await whenPackagesSettled();
  assert.equal(isPackageEnabled("beta"), true);
  assert.equal(listWidgets().filter((widget) => widget.id === "beta.widget").length, 1);
  assert.equal(styleCount("beta"), 1);
});

test("failed activation is retryable on a later enable", async () => {
  packages.get("beta")!.enabled = false;
  await bootPackages();
  shouldFail.add("beta");
  packages.get("beta")!.enabled = true;
  await bootPackages();
  assert.equal(listWidgets().some((widget) => widget.id === "beta.widget"), false);
  packages.get("beta")!.enabled = false;
  await bootPackages();
  packages.get("beta")!.enabled = true;
  await bootPackages();
  assert.ok((factoryCounts.get("beta") ?? 0) >= 1);
  assert.equal(listWidgets().some((widget) => widget.id === "beta.widget"), true);
});

test("dictation owns voice settings, capability, and widget group", async () => {
  packages.get("dictation")!.enabled = true;
  await bootPackages();
  const page = listSlots("settings.pages").find((item) => item.id === "voice");
  assert.equal(page?.meta?.packageId, "dictation");
  assert.equal(getCapability("voice")?.id, "voice");
  const mic = listWidgets().find((widget) => widget.id === "voice.lifecycle-mic");
  assert.equal(mic?.pluginId, "voice");
  assert.equal(mic?.ownerPackageId, "dictation");
  packages.get("dictation")!.enabled = false;
  await bootPackages();
  assert.equal(listSlots("settings.pages").some((item) => item.id === "voice"), false);
  assert.equal(getCapability("voice"), null);
  assert.equal(listWidgets().some((widget) => widget.id === "voice.lifecycle-mic"), false);
  packages.get("dictation")!.enabled = true;
  await bootPackages();
  assert.equal(listSlots("settings.pages").some((item) => item.id === "voice"), true);
  assert.equal(getCapability("voice")?.id, "voice");
});

test("project context composes, recommends per project, and updates live", async () => {
  packages.get("alpha")!.enabled = true;
  packages.get("beta")!.enabled = true;
  await bootPackages();
  const projectA = listProjectContextSnapshots("project-a");
  assert.deepEqual(projectA.map((entry) => entry.id), ["alpha.context", "beta.context"]);
  assert.deepEqual(listProjectContextRecommendedWidgetIds("project-a"), ["alpha.widget", "beta.widget"]);
  const projectB = listProjectContextSnapshots("project-b");
  assert.deepEqual(projectB.map((entry) => entry.id), ["alpha.context"]);
  assert.equal(listProjectContextRecommendedWidgetIds("project-b").includes("beta.widget"), false);

  (globalThis as { __betaCampaign?: (value: string) => void }).__betaCampaign?.("Autumn");
  assert.equal(
    listProjectContextSnapshots("project-a").find((entry) => entry.id === "beta.context")?.snapshot.items?.[0]?.value,
    "Autumn",
  );

  (globalThis as { __betaNeedsSetup?: (value: boolean) => void }).__betaNeedsSetup?.(true);
  const setup = listProjectContextSnapshots("project-a").find((entry) => entry.id === "beta.context")?.snapshot.needsSetup;
  assert.equal(setup?.label, "Configure campaign");
  setup?.open();
  assert.equal((globalThis as { __betaOpened?: number }).__betaOpened, 1);

  reconcilePackage({
    id: "alpha",
    name: "alpha",
    description: "alpha",
    core: false,
    enabled: false,
    hasSettings: true,
  });
  await whenPackagesSettled();
  assert.deepEqual(listProjectContextSnapshots("project-a").map((entry) => entry.id), ["beta.context"]);
  assert.equal(listProjectContextRecommendedWidgetIds("project-a").includes("alpha.widget"), false);
  assert.equal(listWidgets().some((widget) => widget.id === "beta.widget"), true);
});
