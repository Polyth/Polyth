import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("./tsxHooks.mjs", import.meta.url);

const {
  TASK_TRACKER_WIDGET_PLUGIN,
  createTaskTrackerInstaller,
} = await import("../widgets/plugin.tsx");

test("task tracker package owns its complete renderable widget catalog", () => {
  const widgets = TASK_TRACKER_WIDGET_PLUGIN.widgets ?? [];
  assert.equal(TASK_TRACKER_WIDGET_PLUGIN.id, "task-trackers");
  assert.deepEqual(widgets.map((widget) => widget.id), [
    "task-trackers.board",
    "task-trackers.linked-task",
  ]);
  assert.equal(widgets[0]?.defaultSlot, "workspace.main");
  assert.equal(widgets[1]?.defaultSlot, "session.composer.before");
  assert.ok(widgets.every((widget) => typeof widget.render === "function"));
  assert.ok(widgets.every((widget) => typeof widget.settingsRender === "function"));
});

test("task tracker web entry installs and disposes through the bounded host", () => {
  const registered: WidgetPlugin[] = [];
  let disposals = 0;
  const host = {
    widgets: {
      registerPlugin(plugin: WidgetPlugin) {
        registered.push(plugin);
        return () => { disposals++; };
      },
    },
    ui: { icons: {} },
    errors: { friendly: (action: string) => action },
  } as unknown as WebPackageHost;

  const install = createTaskTrackerInstaller(host);
  const first = install();
  const second = install();
  assert.equal(first, second);
  assert.deepEqual(registered, [TASK_TRACKER_WIDGET_PLUGIN]);
  first();
  assert.equal(disposals, 1);

  install()();
  assert.equal(registered.length, 2);
  assert.equal(disposals, 2);
});
