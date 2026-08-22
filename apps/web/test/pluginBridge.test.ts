import { test } from "node:test";
import assert from "node:assert/strict";
import type { InstalledPluginDto } from "@polyth/contracts";
import type { ComponentType, ReactElement } from "react";
import { initPluginBridge } from "../src/pluginBridge.ts";
import { listSlots } from "../src/slots.ts";
import type { SyncListener } from "../src/sync.ts";

const plugin = (enabled: boolean, uiIntegrity?: string): InstalledPluginDto => ({
  id: "test.bridge",
  name: "Bridge Test",
  version: "1.0.0",
  source: "file:test",
  trust: "ui-only",
  enabled,
  status: enabled ? "ready" : "disabled",
  capabilities: [],
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

test("plugin bridge registers initial catalog items and reconciles WS changes", async () => {
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
  const dispose = await initPluginBridge(sync, {
    pluginsList: async () => [plugin(true)],
  });

  try {
    const initial = listSlots("widget.catalog").find((item) => item.id === "test.bridge.widget");
    assert.ok(initial);
    assert.equal(initial.order, 42);
    assert.equal(initial.meta?.pluginId, "test.bridge");
    assert.equal(initial.meta?.pluginName, "Bridge Test");
    assert.equal(initial.render({}), "Plugin widget: Bridge Widget");

    emit({ type: "plugin/changed", plugin: plugin(false) });
    assert.equal(
      listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
      false,
    );

    emit({ type: "plugin/changed", plugin: plugin(true) });
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
  const dispose = await initPluginBridge(sync, {
    pluginsList: async () => [plugin(true, "a".repeat(64))],
    load: async (_pluginId, _url, integrity) => {
      loads++;
      if (integrity === "c".repeat(64)) await slow;
      return { modules: { "test-widget": Component } };
    },
    resolve: () => Component,
  });

  try {
    assert.equal(loads, 1);
    emit({ type: "plugin/changed", plugin: plugin(true, "b".repeat(64)) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(loads, 2, "a new integrity changes the reconciliation signature");

    emit({ type: "plugin/changed", plugin: plugin(true, "c".repeat(64)) });
    emit({ type: "plugin/changed", plugin: plugin(false, "c".repeat(64)) });
    releaseSlow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      listSlots("widget.catalog").some((item) => item.id === "test.bridge.widget"),
      false,
      "a slow import cannot re-register a disabled plugin",
    );
  } finally {
    dispose();
  }
});
