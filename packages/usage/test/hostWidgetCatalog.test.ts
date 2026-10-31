// Moved from apps/web/test/widgetCatalog.test.ts: the usage package's own widget
// declarations and registration.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { USAGE_WIDGETS } = await import("../src/index.ts");
const { installUsagePlugin, USAGE_WIDGET_PLUGIN } = await import("../widgets/usagePlugin.tsx");
const { listWidgets } = await import("../../../apps/web/src/widgets/catalog.ts");

test("Usage plugin owns all package-declared usage widgets", () => {
  const client = USAGE_WIDGET_PLUGIN.widgets ?? [];
  assert.deepEqual(
    client.map((widget) => widget.id),
    USAGE_WIDGETS.map((widget) => widget.id),
  );
  assert.deepEqual(
    client.map(({ render: _render, settingsRender: _settingsRender, isAvailable: _isAvailable, ...widget }) => widget),
    USAGE_WIDGETS.map(({ module: _module, ...widget }) => widget),
  );
  installUsagePlugin();
  const widgets = listWidgets().filter((widget) => widget.pluginId === "usage");
  assert.deepEqual(
    widgets.map((widget) => widget.id).sort(),
    [
      "usage.global",
      "usage.limits",
      "usage.project",
      "usage.session",
    ],
  );
  assert.ok(widgets.every((widget) => widget.category === "Usage"));
  assert.ok(widgets.every((widget) => typeof widget.render === "function"));
  assert.ok(widgets.every((widget) => typeof widget.settingsRender === "function"));
  assert.equal(widgets.find((widget) => widget.id === "usage.session")?.defaultSlot, "session.composer.before");
  assert.ok(widgets.find((widget) => widget.id === "usage.session")?.supportedSlots?.includes("session.composer.before"));
  assert.equal(widgets.find((widget) => widget.id === "usage.global")?.defaultSlot, "workspace.main");
  // The package names its own Workspace panel sizes; the host has no per-widget fallback.
  assert.deepEqual(
    Object.fromEntries(widgets.map((widget) => [widget.id, [widget.panelSizes, widget.panelDefaultSize]])),
    {
      "usage.global": [["compact", "standard"], "compact"],
      "usage.limits": [["compact", "standard"], "compact"],
      "usage.project": [["wide", "large"], "large"],
      "usage.session": [["compact", "standard"], "compact"],
    },
  );
});
