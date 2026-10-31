import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { listSlots, registerSlot } from "../src/slots.ts";

register("./tsxHooks.mjs", import.meta.url);

const { defineWidgetPlugin, listWidgets, registerWidgetPlugin } = await import("../src/widgets/catalog.ts");
const { BUILTIN_WIDGET_PLUGINS } = await import("../src/widgets/builtinWidgets.tsx");
const { installBuiltinMiniWidgets } = await import("../src/widgets/builtinMiniWidgets.tsx");

installBuiltinMiniWidgets();

test("built-in catalog covers the complete default canvas", () => {
  const widgets = listWidgets();
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  for (const [id, title] of [
    ["core.chat", "Conversation"],
    ["session.work-status", "Agent Actions"],
    ["session.activity", "Activity Timeline"],
    ["core.quick-actions", "Quick actions"],
  ] as const) {
    assert.equal(byId.get(id)?.title, title);
    assert.equal(typeof byId.get(id)?.render, "function");
  }
  assert.equal(byId.has("core.composer"), false);
  assert.deepEqual(byId.get("core.chat")?.minSize, { w: 4, h: 6 });
  assert.ok((BUILTIN_WIDGET_PLUGINS.find((plugin) => plugin.id === "session")?.widgets?.length ?? 0) > 1);
  assert.equal(BUILTIN_WIDGET_PLUGINS.some((plugin) => plugin.id === "files"), false);
});

test("model-picker effort does not leave duplicate composer controls", () => {
  const byId = new Map(listWidgets().map((widget) => [widget.id, widget]));
  assert.equal(byId.has("composer.agent"), false);
  assert.equal(byId.has("composer.effort"), false);
  assert.equal(byId.has("composer.effort-inline"), false);
});

test("shell catalog has no static Git or Terminal contributions", () => {
  const contributions = new Map(listSlots("widget.catalog").map((item) => [item.id, item]));
  for (const id of ["git.recent", "terminal.shell"]) {
    assert.equal(contributions.has(id), false);
  }
});

test("Terminal header launcher is not dependent on the configurable widget registry", () => {
  assert.equal(listWidgets().some((widget) => widget.id === "terminal.open-action"), false);
  const search = listWidgets().find((widget) => widget.id === "shell.search");
  assert.equal(search?.defaultSlot, "app.header.actions");
  assert.equal(search?.kind, "mini-widget");
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
    const context = {
      projectId: null,
      sessionId: null,
      editing: false,
      instanceId: "sample.status#2",
      config: {},
      updateConfig: () => {},
    };
    assert.equal(widget?.render(context), "status");
    assert.equal(widget?.settingsRender?.({
      ...context,
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

test("two package plugins contribute simultaneously and unregister independently", () => {
  const offA = registerWidgetPlugin(defineWidgetPlugin({
    id: "pkg-a",
    name: "Package A",
    widgets: [{
      id: "pkg-a.board",
      title: "A board",
      description: "Package A context",
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.main"],
      recommended: true,
      render: () => "a",
    }],
  }));
  const offB = registerWidgetPlugin(defineWidgetPlugin({
    id: "pkg-b",
    name: "Package B",
    widgets: [{
      id: "pkg-b.notes",
      title: "B notes",
      description: "Package B context",
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.right"],
      recommended: true,
      render: () => "b",
    }],
  }));
  try {
    const ids = listWidgets().map((widget) => widget.id);
    assert.ok(ids.includes("pkg-a.board"));
    assert.ok(ids.includes("pkg-b.notes"));
    offA();
    const afterA = listWidgets().map((widget) => widget.id);
    assert.equal(afterA.includes("pkg-a.board"), false);
    assert.ok(afterA.includes("pkg-b.notes"));
  } finally {
    offB();
  }
  assert.equal(listWidgets().some((widget) => widget.pluginId === "pkg-a" || widget.pluginId === "pkg-b"), false);
});
