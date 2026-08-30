import test from "node:test";
import assert from "node:assert/strict";
import { getWidget, listWidgets } from "../src/widgets/catalog.ts";
import { installSystemWidgets } from "../src/widgets/systemWidgets.tsx";
import { supportedWidgetSlots } from "../src/widgets/widgetLibrary.ts";

test("system status is a movable workspace widget, not a header contribution", () => {
  installSystemWidgets();
  const widget = getWidget("system.status");

  assert.ok(widget);
  assert.equal(widget.kind, "widget");
  assert.equal(widget.defaultSlot, "workspace.right");
  assert.equal(widget.defaultVisible, true);
  assert.deepEqual(supportedWidgetSlots(widget), [
    "workspace.header",
    "workspace.left",
    "workspace.main",
    "workspace.right",
    "workspace.bottom",
    "workspace.floating",
  ]);
  assert.ok(listWidgets().some((candidate) => candidate.id === "system.status"));
});
