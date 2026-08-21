import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { registerSlot } from "../src/slots.ts";

register("./tsxHooks.mjs", import.meta.url);

const { listWidgets } = await import("../src/widgets/catalog.ts");
await import("../src/widgets/builtinWidgets.tsx");

test("built-in catalog covers the complete default canvas", () => {
  const widgets = listWidgets();
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  for (const [id, title] of [
    ["core.composer", "Composer"],
    ["goals.current", "Current Task Plan"],
    ["files.project-map", "Project Map"],
    ["git.recent", "Recent Changes"],
    ["session.work-status", "Agent Actions"],
    ["knowledge.notes", "Notes / Memory"],
    ["session.activity", "Activity Timeline"],
    ["core.quick-actions", "Quick actions"],
  ] as const) {
    assert.equal(byId.get(id)?.title, title);
    assert.equal(typeof byId.get(id)?.render, "function");
    assert.equal(typeof byId.get(id)?.settingsRender, "function");
  }
});

test("plugin catalog and settings slots merge into one widget definition", () => {
  const offCatalog = registerSlot("widget.catalog", "sample.status", () => "status", 0, {
    pluginId: "sample",
    title: "Sample status",
    description: "Status supplied by a plugin.",
    zone: "right",
    audience: "power",
    defaultSize: { w: 4, h: 3 },
  });
  const offSettings = registerSlot("widget.settings", "sample.status", () => "settings", 0, {
    widgetId: "sample.status",
  });
  try {
    const widget = listWidgets().find((item) => item.id === "sample.status");
    assert.equal(widget?.pluginId, "sample");
    assert.equal(widget?.zone, "right");
    assert.equal(widget?.audience, "power");
    assert.deepEqual(widget?.defaultSize, { w: 4, h: 3 });
    assert.equal(widget?.render({ projectId: null, sessionId: null, editing: false }), "status");
    assert.equal(widget?.settingsRender?.({
      projectId: null,
      sessionId: null,
      widgetId: "sample.status",
      editing: true,
    }), "settings");
  } finally {
    offSettings();
    offCatalog();
  }
});
