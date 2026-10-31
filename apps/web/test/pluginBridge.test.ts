import { register } from "node:module";
register("./tsxHooks.mjs", import.meta.url);

import { test } from "node:test";
import assert from "node:assert/strict";
import type { InstalledPluginDto } from "@polyth/contracts";
import type { ComponentType, ReactElement } from "react";
import { listSlots } from "../src/slots.ts";
import type { SyncListener } from "../src/sync.ts";

const { initPluginBridge } = await import("../src/pluginBridge.ts");

const plugin = (enabled: boolean, uiIntegrity?: string): InstalledPluginDto => ({
  id: "test.bridge",
  name: "Bridge Test",
  version: "1.0.0",
  source: "file:test",
  trust: "ui-only",
  enabled,
  status: enabled ? "ready" : "disabled",
  permissions: { effective: [], requested: [] },
  contributions: [{
    slot: "widget.catalog",
    id: "test.bridge.widget",
    module: "test-widget",
    order: 42,
    props: {
      title: "Bridge Widget",
      description: "Registered from a managed plugin descriptor.",
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.main"],
    },
  }],
  ...(uiIntegrity ? {
    ui: {
      url: `/api/plugins/test.bridge/ui/${uiIntegrity}.mjs`,
      integrity: uiIntegrity,
    },
  } : {}),
});

const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("plugin bridge registers initial catalog items and reconciles WS invalidation", async () => {
  let listener: SyncListener | null = null;
  const emit = (message: Parameters<SyncListener>[0]): void => {
    if (!listener) throw new Error("plugin sync listener is not registered");
    listener(message);
  };
  const sync = {
    onEvent(callback: SyncListener) {
      listener = callback;
      return () => { if (listener === callback) listener = null; };
    },
  };
  let current = plugin(true);
  const dispose = await initPluginBridge(sync, {
    pluginsList: async () => [current],
  });

  try {
    const initial = listSlots("widget.catalog").find((item) => item.id === "test.bridge.widget");
    assert.ok(initial);
    assert.equal(initial.order, 42);
    assert.equal(initial.meta?.pluginId, "test.bridge");
    assert.equal(initial.meta?.pluginName, "Bridge Test");
    assert.equal(initial.render({}), "Plugin widget: Bridge Widget");

    current = plugin(false);
    emit({ type: "plugin/changed", packageId: "test.bridge" });
    await flush();
    assert.equal(
      listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
      false,
    );

    current = plugin(true);
    emit({ type: "plugin/changed", packageId: "test.bridge" });
    await flush();
    assert.equal(
      listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
      true,
    );
  } finally {
    dispose();
  }

  assert.equal(listener, null);
  assert.equal(
    listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
    false,
  );
});

test("plugin/changed does not apply a Space-specific DTO from the wire", async () => {
  let listener: SyncListener | null = null;
  const emit = (message: Parameters<SyncListener>[0]): void => {
    if (!listener) throw new Error("plugin sync listener is not registered");
    listener(message);
  };
  const sync = {
    onEvent(callback: SyncListener) {
      listener = callback;
      return () => { if (listener === callback) listener = null; };
    },
  };
  const spaceA = plugin(true);
  const spaceB = plugin(false);
  let current = spaceB;
  const dispose = await initPluginBridge(sync, {
    pluginsList: async () => [current],
  });
  try {
    assert.equal(listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"), false);
    emit({ type: "plugin/changed", packageId: spaceA.id });
    await flush();
    assert.equal(
      listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
      false,
      "Space B must refetch its own list, not apply another Space's grants",
    );
    current = plugin(true);
    emit({ type: "plugin/changed", packageId: "test.bridge" });
    await flush();
    assert.equal(listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"), true);
  } finally {
    dispose();
  }
});

test("plugin bridge resolves UI modules for contributions in every slot", async () => {
  const Component: ComponentType<Record<string, unknown>> = () => null;
  let loaded = false;
  const withUi: InstalledPluginDto = {
    ...plugin(true, "a".repeat(64)),
    contributions: [
      ...plugin(true).contributions,
      {
        slot: "app.nav",
        id: "test.bridge.nav",
        module: "test-nav",
        props: { configured: true },
      },
    ],
  };
  const dispose = await initPluginBridge(undefined, {
    pluginsList: async () => [withUi],
    load: async () => {
      loaded = true;
      return { modules: { "test-widget": Component, "test-nav": Component } };
    },
    resolve: (_pluginId, moduleKey) =>
      loaded && (moduleKey === "test-widget" || moduleKey === "test-nav") ? Component : null,
  });

  try {
    const catalog = listSlots("widget.catalog").find((item) => item.id === "test.bridge.widget");
    const nav = listSlots("app.nav").find((item) => item.id === "test.bridge.nav");
    assert.ok(catalog);
    assert.ok(nav);
    const rendered = nav.render({ runtime: "value" }) as ReactElement<Record<string, unknown>>;
    assert.equal(rendered.type, Component);
    assert.deepEqual(rendered.props, { configured: true, runtime: "value" });
  } finally {
    dispose();
  }
});

test("a managed package's own settings page takes its name and id; other pages keep slot ids", async () => {
  const Component: ComponentType<Record<string, unknown>> = () => null;
  const managed: InstalledPluginDto = {
    ...plugin(true, "c".repeat(64)),
    id: "home-assistant",
    name: "Home Assistant",
    contributions: [
      { slot: "settings.pages", id: "home-assistant", module: "home-assistant.settings" },
      { slot: "settings.pages", id: "home-assistant.extra", module: "home-assistant.settings" },
    ],
  };
  const dispose = await initPluginBridge(undefined, {
    pluginsList: async () => [managed],
    load: async () => ({ modules: { "home-assistant.settings": Component } }),
    resolve: () => Component,
  });
  try {
    const pages = listSlots("settings.pages");
    const main = pages.find((item) => item.id === "home-assistant");
    const extra = pages.find((item) => item.id === "home-assistant.extra");
    assert.equal(main?.meta?.label, "Home Assistant");
    assert.equal(main?.meta?.pageId, "home-assistant");
    assert.equal(extra?.meta?.pageId, undefined, "only the package's own page is renamed");
    assert.equal(extra?.meta?.label, undefined);
  } finally {
    dispose();
  }
});

test("plugin bridge never loads host modules for sandboxed packages", async () => {
  let loaded = false;
  const sandboxed: InstalledPluginDto = {
    ...plugin(true),
    runtimeKind: "sandboxed",
    contributions: [{
      slot: "workspace.right.tabs",
      id: "test.bridge.surface.main",
      module: "sandbox-surface:main",
      props: { pluginId: "test.bridge", surfaceId: "main", title: "Hello" },
    }],
    sandbox: {
      url: `/api/plugins/test.bridge/sandbox/${"a".repeat(64)}/entry.js`,
      integrity: "a".repeat(64),
    },
  };
  const dispose = await initPluginBridge(undefined, {
    pluginsList: async () => [sandboxed],
    load: async () => {
      loaded = true;
      return { modules: {} };
    },
  });
  try {
    assert.equal(loaded, false);
    assert.ok(listSlots("workspace.right.tabs").some((item) => item.id === "test.bridge.surface.main"));
  } finally {
    dispose();
  }
});

test("plugin bridge reconciles integrity changes and ignores a disabled slow load", async () => {
  let listener: SyncListener | null = null;
  const emit = (message: Parameters<SyncListener>[0]): void => {
    if (!listener) throw new Error("plugin sync listener is not registered");
    listener(message);
  };
  let loads = 0;
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const Component: ComponentType<Record<string, unknown>> = () => null;
  const sync = {
    onEvent(callback: SyncListener) {
      listener = callback;
      return () => { if (listener === callback) listener = null; };
    },
  };
  let current = plugin(true, "a".repeat(64));
  const dispose = await initPluginBridge(sync, {
    pluginsList: async () => [current],
    load: async (_pluginId, _url, integrity) => {
      loads++;
      if (integrity === "c".repeat(64)) await slow;
      return { modules: { "test-widget": Component } };
    },
    resolve: () => Component,
  });

  try {
    assert.equal(loads, 1);
    current = plugin(true, "b".repeat(64));
    emit({ type: "plugin/changed", packageId: "test.bridge" });
    await flush();
    assert.equal(loads, 2, "a new integrity changes the reconciliation signature");

    current = plugin(true, "c".repeat(64));
    emit({ type: "plugin/changed", packageId: "test.bridge" });
    current = plugin(false, "c".repeat(64));
    emit({ type: "plugin/changed", packageId: "test.bridge" });
    releaseSlow();
    await flush();
    await flush();
    assert.equal(
      listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
      false,
      "a slow import cannot re-register a disabled plugin",
    );
  } finally {
    dispose();
  }
});

test("plugin bridge turns a managed rail panel with metadata into a surface, capability and package mark", async () => {
  const { listSurfaces } = await import("../src/surfaces.ts");
  const { listCapabilities } = await import("../src/capabilities.ts");
  const { railIconFor, widgetIconFor } = await import("../src/railIcons.ts");
  const Panel: ComponentType<Record<string, unknown>> = () => null;
  const Mark: ComponentType<{ size?: number }> = () => null;
  const managed: InstalledPluginDto = {
    ...plugin(true, "b".repeat(64)),
    contributions: [
      { slot: "workspace.right.tabs", id: "test.bridge", module: "home-panel" },
      // Outside the plugin's namespace: never promoted over a host surface.
      { slot: "workspace.right.tabs", id: "context", module: "home-panel" },
    ],
  };
  const dispose = await initPluginBridge(undefined, {
    pluginsList: async () => [managed],
    load: async () => ({ modules: { "home-panel": Panel } }),
    resolve: (_pluginId, moduleKey) => moduleKey === "home-panel" ? Panel : null,
    resolveIcon: () => Mark,
    resolveSurface: (_pluginId, moduleKey) => moduleKey === "home-panel" ? {
      title: "Home",
      description: "Your home dashboard.",
      keywords: ["dashboard"],
      presentation: { kind: "workspace", defaultRatio: 5, minWidth: 420, preferredMaxWidth: 1200, keepAlive: true, escape: "close", contentMode: "workspace" },
    } : null,
  });

  try {
    const surface = listSurfaces().find((item) => item.id === "test.bridge");
    assert.ok(surface, "the panel is a registered surface");
    assert.equal(surface.title, "Home");
    assert.equal(surface.capabilityId, "test.bridge");
    assert.equal(surface.ownerPackageId, undefined);
    assert.equal(surface.presentation?.kind, "workspace");
    assert.equal(surface.presentation?.defaultRatio, 0.9, "untrusted geometry is clamped");
    assert.equal((surface.presentation as { contentMode?: string }).contentMode, "workspace");
    const icon = surface.icon?.() as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
    assert.equal(icon.props.children.type, Mark, "the panel wears the plugin's own mark");
    assert.deepEqual(icon.props.children.props, { size: 15, strokeWidth: 1.8, "aria-hidden": true });
    const rendered = surface.component({ active: true, projectId: "p1", sessionId: null }) as ReactElement<Record<string, unknown>>;
    assert.equal(rendered.type, Panel);
    assert.deepEqual(rendered.props, { active: true, projectId: "p1", sessionId: null });

    const capability = listCapabilities().find((item) => item.id === "test.bridge");
    assert.ok(capability, "the panel is a customizable, searchable capability");
    assert.equal(capability.label, "Home");
    assert.equal(capability.standardTier, "more");
    assert.ok(capability.keywords.includes("dashboard"));

    // Every host place that shows the package resolves the same mark.
    const viaLauncher = railIconFor("test.bridge")() as ReactElement<{ children: ReactElement }>;
    const viaWidget = widgetIconFor({ id: "test.bridge.widget", pluginId: "test.bridge" })() as ReactElement<{ children: ReactElement }>;
    assert.equal(viaLauncher.props.children.type, Mark);
    assert.equal(viaWidget.props.children.type, Mark);

    assert.equal(listSurfaces().find((item) => item.id === "context"), undefined);
    assert.ok(listSlots("workspace.right.tabs").some((item) => item.id === "context"),
      "an out-of-namespace panel stays a plain bridged slot");
  } finally {
    dispose();
  }
  assert.equal(listSurfaces().some((item) => item.id === "test.bridge"), false);
  assert.equal(listCapabilities().some((item) => item.id === "test.bridge"), false);
  const fallback = railIconFor("test.bridge")() as ReactElement;
  assert.notEqual((fallback.props as { children?: ReactElement }).children?.type, Mark, "disposal removes the mark");
});

test("plugin bridge retries a UI module that failed to load, busting the memoised URL", async () => {
  const Component: ComponentType<Record<string, unknown>> = () => null;
  const retries: number[] = [];
  let attempts = 0;
  const dispose = await initPluginBridge(undefined, {
    pluginsList: async () => [plugin(true, "d".repeat(64))],
    load: async (_pluginId, _url, _integrity, retry) => {
      attempts++;
      retries.push(retry ?? 0);
      if (attempts === 1) throw new Error("network");
      return { modules: { "test-widget": Component } };
    },
    resolve: (_pluginId, key) => (attempts > 1 ? Component : null),
    recoveryDelaysMs: [5],
  });
  try {
    assert.equal(attempts, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(attempts, 2, "the failed module is retried without a manual reload");
    assert.deepEqual(retries, [0, 1], "the retry uses a distinct URL");
  } finally {
    dispose();
  }
});

test("plugin bridge keeps retrying when the first plugin list fetch fails", async () => {
  const Component: ComponentType<Record<string, unknown>> = () => null;
  let lists = 0;
  let loads = 0;
  let dispose: (() => void) | undefined;
  await assert.rejects(initPluginBridge(undefined, {
    pluginsList: async () => {
      lists++;
      if (lists === 1) throw new Error("offline");
      return [plugin(true, "e".repeat(64))];
    },
    load: async () => { loads++; return { modules: { "test-widget": Component } }; },
    resolve: () => Component,
    recoveryDelaysMs: [5],
  }));
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(loads, 1, "plugins arrive after the list fetch recovers");
  dispose?.();
});
