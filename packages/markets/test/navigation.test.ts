import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { CapabilityDefinition, WebPackageHost } from "@polyth/web-sdk";
import { createMarketNavigation, MARKET_SECTION_LINKS } from "../widgets/navigation.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

function fixture() {
  let snapshot = { activeProjectId: "project-a", railPlugin: null as string | null };
  const listeners = new Set<() => void>();
  const host = {
    store: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    navigation: {
      openWorkspacePane: (id: string) => { update({ railPlugin: id }); return true; },
    },
  };
  function update(change: Partial<typeof snapshot>) {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  return { host: host as unknown as WebPackageHost, update, snapshot: () => snapshot, listeners };
}

test("Markets reopens the last section per project after close, reload and re-enable", () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const f = fixture();
    let navigation = createMarketNavigation(f.host);
    navigation.open();
    assert.equal(f.snapshot().railPlugin, "markets.overview");
    for (const section of MARKET_SECTION_LINKS) {
      f.host.navigation.openWorkspacePane(section.id);
      f.update({ railPlugin: null });
      navigation.open();
      assert.equal(f.snapshot().railPlugin, section.id);
    }
    f.update({ railPlugin: null, activeProjectId: "project-b" });
    navigation.open();
    assert.equal(f.snapshot().railPlugin, "markets.overview", "another project starts with Overview");
    f.host.navigation.openWorkspacePane("markets.portfolio");
    f.update({ railPlugin: null });
    navigation.dispose();
    assert.equal(f.listeners.size, 0, "disable disposes the navigation observer");
    navigation = createMarketNavigation(f.host);
    navigation.open();
    assert.equal(f.snapshot().railPlugin, "markets.portfolio");
    f.update({ railPlugin: null, activeProjectId: "project-a" });
    navigation.open();
    assert.equal(f.snapshot().railPlugin, "markets.filings");
    navigation.dispose();

    const reloaded = fixture();
    navigation = createMarketNavigation(reloaded.host);
    navigation.open();
    assert.equal(reloaded.snapshot().railPlugin, "markets.filings", "fresh runtime reads the saved section");
    navigation.dispose();

    values.set("polyth.markets.lastSection.v1.project-a", "foreign-surface");
    const fresh = fixture();
    navigation = createMarketNavigation(fresh.host);
    navigation.open();
    assert.equal(fresh.snapshot().railPlugin, "markets.overview", "unknown saved sections fall back safely");
    navigation.dispose();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("close/reopen works in memory when storage is blocked", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  try {
    const f = fixture();
    const navigation = createMarketNavigation(f.host);
    f.host.navigation.openWorkspacePane("markets.screener");
    f.update({ railPlugin: null });
    navigation.open();
    assert.equal(f.snapshot().railPlugin, "markets.screener");
    navigation.dispose();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("real Markets entry exposes one rail capability and retains all section destinations", async () => {
  const { default: entry } = await import("../widgets/main.tsx");
  const f = fixture();
  const capabilities: CapabilityDefinition[] = [];
  const surfaces: string[] = [];
  const host = {
    ...f.host,
    capabilities: { register: (definition: CapabilityDefinition) => { capabilities.push(definition); return () => {}; } },
    surfaces: { register: (definition: { id: string }) => { surfaces.push(definition.id); return () => {}; } },
    widgets: { registerPlugin: () => () => {} },
    workbench: { profiles: { register: () => () => {} } },
  } as unknown as WebPackageHost;
  const dispose = entry(host)();
  assert.deepEqual(capabilities.filter((capability) => capability.rail !== false).map((capability) => capability.id), ["markets"]);
  assert.deepEqual(new Set(surfaces), new Set(MARKET_SECTION_LINKS.map((section) => section.id)));
  const home = capabilities.find((capability) => capability.id === "markets")!;
  f.host.navigation.openWorkspacePane("markets.calendar");
  f.update({ railPlugin: null });
  home.open();
  assert.equal(f.snapshot().railPlugin, "markets.calendar", "canonical capability delegates to remembered navigation");
  dispose?.();
  assert.equal(f.listeners.size, 0);
});
