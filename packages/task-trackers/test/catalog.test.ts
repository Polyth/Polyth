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
    "task-trackers.overview",
  ]);
  assert.equal(widgets[0]?.defaultSlot, "workspace.main");
  assert.equal(widgets[1]?.defaultSlot, "session.composer.before");
  assert.equal(widgets[2]?.defaultSlot, "workspace.right");
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
  assert.deepEqual(registered, [TASK_TRACKER_WIDGET_PLUGIN]);
  const second = install();
  assert.notEqual(first, second, "a later install replaces the previous activation");
  assert.equal(registered.length, 2);
  assert.equal(disposals, 1);
  second();
  assert.equal(disposals, 2);

  install()();
  assert.equal(registered.length, 3);
  assert.equal(disposals, 3);
});

test("task tracker web package registers Tasks workbench profile, surface and capability", async () => {
  const { default: defineWebPackageEntry } = await import("../widgets/index.tsx");

  const surfaces: unknown[] = [];
  const profiles: unknown[] = [];
  const capabilities: unknown[] = [];
  const settingsPages: unknown[] = [];
  const settingsItems: unknown[] = [];
  const projectContexts: unknown[] = [];
  const widgets: WidgetPlugin[] = [];
  let disposals = 0;

  let activatedProfile: string | null = null;
  let openedWorkspacePane: string | null = null;

  const host = {
    widgets: {
      registerPlugin(plugin: WidgetPlugin) {
        widgets.push(plugin);
        return () => { disposals++; };
      },
    },
    surfaces: {
      register(def: unknown) {
        surfaces.push(def);
        return () => { disposals++; };
      },
    },
    workbench: {
      profiles: {
        register(def: unknown) {
          profiles.push(def);
          return () => { disposals++; };
        },
      },
      activateProfile(id: string) {
        activatedProfile = id;
        return true;
      },
    },
    capabilities: {
      register(def: unknown) {
        capabilities.push(def);
        return () => { disposals++; };
      },
    },
    settings: {
      registerPage(def: unknown) {
        settingsPages.push(def);
        return () => { disposals++; };
      },
      registerItems(items: unknown[]) {
        settingsItems.push(...items);
        return () => { disposals++; };
      },
    },
    projectContext: {
      register(def: unknown) {
        projectContexts.push(def);
        return () => { disposals++; };
      },
    },
    navigation: {
      openWorkspacePane(id: string) {
        openedWorkspacePane = id;
        return true;
      },
    },
    ui: { icons: {} },
    errors: { friendly: (action: string) => action },
  } as unknown as WebPackageHost;

  const init = defineWebPackageEntry(host);
  const teardown = init();

  assert.equal(profiles.length, 1);
  const profile = profiles[0] as {
    id: string;
    label: string;
    order: number;
    presentation: {
      navigation?: string;
      optional?: boolean;
      homeSurface?: string;
      focused?: boolean;
    };
    defaultLayout: {
      surfaces: readonly { surface: string; region: string; active?: boolean }[];
    };
  };
  assert.equal(profile.id, "tasks");
  assert.equal(profile.label, "Tasks");
  assert.equal(profile.presentation.navigation, "primary");
  // The tab is opt-in per project (like Canvas) and is the board itself over
  // the whole workspace, not a split beside Chat.
  assert.equal(profile.presentation.optional, true);
  assert.equal(profile.presentation.homeSurface, "task-trackers");
  assert.equal(profile.presentation.focused, undefined);
  assert.deepEqual(profile.defaultLayout.surfaces, [
    { surface: "session", region: "primary", active: true },
    { surface: "task-trackers", region: "end", active: true },
  ]);

  assert.equal(surfaces.length, 1);
  const surface = surfaces[0] as {
    id: string;
    presentation: {
      kind: string;
      contentMode: string;
      keepAlive: boolean;
    };
  };
  assert.equal(surface.id, "task-trackers");
  assert.equal(surface.presentation.kind, "workspace");
  assert.equal(surface.presentation.contentMode, "workspace");
  assert.equal(surface.presentation.keepAlive, true);
  // Opened from Chat, the board is a companion: chat keeps the larger share.
  assert.equal((surface.presentation as unknown as { defaultRatio: number }).defaultRatio, 0.45);

  assert.equal(capabilities.length, 1);
  const cap = capabilities[0] as { id: string; open: () => void };
  assert.equal(cap.id, "task-trackers");
  // The launcher opens the board as a window; it never switches the view.
  cap.open();
  assert.equal(openedWorkspacePane, "task-trackers");
  assert.equal(activatedProfile, null);

  teardown();
  assert.equal(disposals, 7);
});
