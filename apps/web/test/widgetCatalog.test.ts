import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { USAGE_WIDGETS } from "@polyth/usage";
import { GITHUB_WIDGETS } from "@polyth/github";
import { listSlots, registerSlot } from "../src/slots.ts";

register("./tsxHooks.mjs", import.meta.url);

const { defineWidgetPlugin, listWidgets, registerWidgetPlugin } = await import("../src/widgets/catalog.ts");
const { BUILTIN_WIDGET_PLUGINS } = await import("../src/widgets/builtinWidgets.tsx");
const { installBuiltinMiniWidgets, WORKFLOW_WIDGET_PLUGIN } =
  await import("../src/widgets/builtinMiniWidgets.tsx");
const { installUsagePlugin, USAGE_WIDGET_PLUGIN } = await import("../../../packages/usage/widgets/usagePlugin.tsx");
const { installGithubPlugin, GITHUB_WIDGET_PLUGIN } = await import("../../../packages/github/widgets/githubPlugin.tsx");

installBuiltinMiniWidgets();

test("built-in catalog covers the complete default canvas", () => {
  const widgets = listWidgets();
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  for (const [id, title] of [
    ["core.chat", "Conversation"],
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
  assert.equal(byId.has("core.composer"), false);
  assert.ok((BUILTIN_WIDGET_PLUGINS.find((plugin) => plugin.id === "session")?.widgets?.length ?? 0) > 1);
  assert.ok((BUILTIN_WIDGET_PLUGINS.find((plugin) => plugin.id === "files")?.widgets?.length ?? 0) > 1);
});

test("workflow package declares a visible, placeable composer action", () => {
  const widget = WORKFLOW_WIDGET_PLUGIN.widgets?.find((item) => item.id === "workflow.composer-action");
  assert.ok(widget);
  assert.equal(widget.kind, "mini-widget");
  assert.equal(widget.defaultSlot, "composer.trailing");
  assert.deepEqual(widget.supportedSlots, ["composer.leading", "composer.trailing"]);
  assert.equal(widget.defaultVisible, true);
  assert.equal(widget.requiredVisible, true);
  assert.equal(widget.order, 50);
  assert.equal(typeof widget.render, "function");
});

test("built-in mini-widget installer registers every workflow widget", () => {
  installBuiltinMiniWidgets();
  const widgets = listWidgets().filter((widget) => widget.pluginId === WORKFLOW_WIDGET_PLUGIN.id);
  assert.deepEqual(
    widgets.map((widget) => widget.id).sort(),
    ["workflow.active-run", "workflow.composer-action"],
  );
  assert.ok(widgets.every((widget) => typeof widget.render === "function"));
});

test("feature-owned Git and Terminal widgets contribute through the catalog slot", () => {
  const contributions = new Map(listSlots("widget.catalog").map((item) => [item.id, item]));
  for (const [id, pluginId] of [
    ["git.recent", "git"],
    ["terminal.shell", "terminal"],
  ] as const) {
    assert.equal(contributions.get(id)?.meta?.pluginId, pluginId);
    assert.equal(listWidgets().find((widget) => widget.id === id)?.pluginId, pluginId);
  }
});

test("Terminal header launcher is not dependent on the configurable widget registry", () => {
  assert.equal(listWidgets().some((widget) => widget.id === "terminal.open-action"), false);
  const search = listWidgets().find((widget) => widget.id === "shell.search");
  assert.equal(search?.defaultSlot, "app.header.actions");
  assert.equal(search?.kind, "mini-widget");
});

test("Usage plugin owns all package-declared usage widgets", () => {
  const client = USAGE_WIDGET_PLUGIN.widgets ?? [];
  assert.deepEqual(
    client.map((widget) => widget.id),
    USAGE_WIDGETS.map((widget) => widget.id),
  );
  assert.deepEqual(
    client.map(({ render: _render, settingsRender: _settingsRender, ...widget }) => widget),
    USAGE_WIDGETS.map(({ module: _module, ...widget }) => widget),
  );
  installUsagePlugin();
  const widgets = listWidgets().filter((widget) => widget.pluginId === "usage");
  assert.deepEqual(
    widgets.map((widget) => widget.id).sort(),
    [
      "usage.project",
      "usage.quota-summary",
      "usage.quotas",
      "usage.session",
      "usage.sessions-table",
    ],
  );
  assert.ok(widgets.every((widget) => widget.category === "Usage"));
  assert.ok(widgets.every((widget) => typeof widget.render === "function"));
  assert.ok(widgets.every((widget) => typeof widget.settingsRender === "function"));
  assert.equal(widgets.find((widget) => widget.id === "usage.session")?.defaultSlot, "session.composer.before");
  assert.ok(widgets.find((widget) => widget.id === "usage.session")?.supportedSlots?.includes("session.composer.before"));
  assert.equal(widgets.find((widget) => widget.id === "usage.quota-summary")?.defaultSlot, "workspace.header");
});

test("GitHub plugin owns its package-declared current PR widget", () => {
  const client = GITHUB_WIDGET_PLUGIN.widgets ?? [];
  assert.deepEqual(
    client.map(({ render: _render, settingsRender: _settingsRender, ...widget }) => widget),
    GITHUB_WIDGETS.map(({ module: _module, ...widget }) => widget),
  );
  installGithubPlugin();
  const widget = listWidgets().find((item) => item.id === "github.pr-summary");
  assert.equal(widget?.pluginId, "github");
  assert.equal(widget?.defaultSlot, "session.composer.before");
  assert.ok(widget?.supportedSlots?.includes("workspace.right"));
  assert.equal(typeof widget?.render, "function");
  assert.equal(typeof widget?.settingsRender, "function");
  assert.ok(widget?.settingsSchema);
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
