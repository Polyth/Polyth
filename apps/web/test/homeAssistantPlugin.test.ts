import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { HOME_ASSISTANT_WIDGETS } from "@polyth/home-assistant";

register("./tsxHooks.mjs", import.meta.url);

const {
  HOME_ASSISTANT_WIDGET_PLUGIN,
  installHomeAssistantPlugin,
} = await import("../src/widgets/homeAssistantPlugin.tsx");
const { listWidgets } = await import("../src/widgets/catalog.ts");

test("Home Assistant declares matching server and client widget surfaces", () => {
  const client = HOME_ASSISTANT_WIDGET_PLUGIN.widgets ?? [];
  assert.deepEqual(
    client.map((widget) => widget.id),
    HOME_ASSISTANT_WIDGETS.map((widget) => widget.id),
  );
  assert.deepEqual(
    client.map((widget) => widget.kind),
    ["widget", "widget", "widget", "widget", "mini-widget", "mini-widget"],
  );
  assert.equal(client.filter((widget) => widget.kind === "widget").length, 4);
  assert.equal(client.filter((widget) => widget.kind === "mini-widget").length, 2);
  assert.ok(client.every((widget) => widget.capabilities?.includes("polyth.homeAssistant")));
});

test("Home Assistant registers multiple practical widgets through the plugin API", () => {
  installHomeAssistantPlugin();
  const widgets = listWidgets().filter((widget) => widget.pluginId === "home-assistant");
  assert.equal(widgets.length, 6);
  assert.deepEqual(
    widgets.map((widget) => widget.id).sort(),
    [
      "home-assistant.climate-sensors",
      "home-assistant.connection",
      "home-assistant.entity-state",
      "home-assistant.light",
      "home-assistant.light-action",
      "home-assistant.status-action",
    ],
  );
  const statusAction = widgets.find((widget) => widget.id === "home-assistant.status-action");
  assert.equal(statusAction?.kind, "mini-widget");
  assert.equal(statusAction?.defaultSlot, "app.header.actions");
  assert.ok(statusAction?.supportedSlots?.includes("app.nav"));

  const connection = widgets.find((widget) => widget.id === "home-assistant.connection");
  assert.equal(connection?.kind, "widget");
  assert.equal(connection?.defaultSlot, "workspace.right");
  assert.equal(typeof connection?.settingsRender, "function");
  assert.equal(typeof connection?.render, "function");
});
