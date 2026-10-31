// Moved from apps/web/test/widgetCatalog.test.ts: the workflow package's own
// widget declarations and registration.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { WORKFLOW_WIDGET_PLUGIN } = await import("../widgets/index.tsx");
const { listWidgets, registerWidgetPlugin } = await import("../../../apps/web/src/widgets/catalog.ts");

test("workflow package declares a visible, placeable composer action", () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  assert.equal(widget.kind, "mini-widget");
  assert.equal(widget.defaultSlot, "composer.trailing");
  assert.deepEqual(widget.supportedSlots, ["composer.leading", "composer.trailing"]);
  assert.equal(widget.defaultVisible, true);
  assert.notEqual(widget.requiredVisible, true);
  assert.equal(widget.order, 50);
  assert.equal(typeof widget.render, "function");
});

test("workflow package registers its own composer widget", () => {
  const unregister = registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN);
  const widgets = listWidgets().filter((widget) => widget.pluginId === WORKFLOW_WIDGET_PLUGIN.id);
  assert.deepEqual(
    widgets.map((widget) => widget.id).sort(),
    ["workflow.composer-action"],
  );
  assert.ok(widgets.every((widget) => typeof widget.render === "function"));
  unregister();
});
