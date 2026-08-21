import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { registerSlot } from "../src/slots.ts";

register("./tsxHooks.mjs", import.meta.url);

const { defineWidgetPlugin, listWidgets, registerWidgetPlugin } = await import("../src/widgets/catalog.ts");
const { BUILTIN_WIDGET_PLUGINS } = await import("../src/widgets/builtinWidgets.tsx");

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
  assert.ok((BUILTIN_WIDGET_PLUGINS.find((plugin) => plugin.id === "session")?.widgets?.length ?? 0) > 1);
  assert.ok((BUILTIN_WIDGET_PLUGINS.find((plugin) => plugin.id === "files")?.widgets?.length ?? 0) > 1);
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

test("client plugins declare zero or many widgets through one ownership API", () => {
  const before = listWidgets().length;
  const offEmpty = registerWidgetPlugin(defineWidgetPlugin({
    id: "capability-only",
    name: "Capability only",
  }));
  assert.equal(listWidgets().length, before);
  offEmpty();

  const off = registerWidgetPlugin(defineWidgetPlugin({
    id: "sample-tools",
    name: "Sample tools",
    widgets: [
      {
        id: "sample-tools.overview",
        title: "Sample overview",
        description: "A full widget",
        kind: "widget",
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main", "workspace.right"],
        render: () => "overview",
      },
      {
        id: "sample-tools.refresh",
        title: "Refresh sample",
        description: "A mini-widget action",
        kind: "mini-widget",
        defaultSlot: "session.header.actions",
        supportedSlots: ["session.header.actions", "app.header.actions"],
        defaultVisible: true,
        render: () => "refresh",
      },
    ],
  }));
  try {
    const owned = listWidgets().filter((widget) => widget.pluginId === "sample-tools");
    assert.deepEqual(owned.map((widget) => widget.id), [
      "sample-tools.refresh",
      "sample-tools.overview",
    ]);
    assert.ok(owned.every((widget) => widget.pluginName === "Sample tools"));
    assert.equal(owned.find((widget) => widget.kind === "mini-widget")?.defaultSlot, "session.header.actions");
  } finally {
    off();
  }
  assert.equal(listWidgets().some((widget) => widget.pluginId === "sample-tools"), false);
});
