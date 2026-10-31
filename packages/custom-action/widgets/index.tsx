import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type WidgetDefinition } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import ActionLibrary from "./ActionLibrary.tsx";
import {
  ActionBar,
  ActionBarSettings,
  ActionPanel,
  availabilityKey,
  barAvailable,
  SingleAction,
  SingleActionSettings,
  singleAvailable,
} from "./ActionWidgets.tsx";
import { setActionHost } from "./host.ts";
import { installActionLaunchers } from "./railLaunchers.tsx";
import ResultCards from "./ResultCards.tsx";
import { getSnapshot, refresh, resetActionStore, subscribe } from "./store.ts";

const TOOLBAR_SLOTS = [
  "session.header.actions",
  "app.header.actions",
  "app.header.center",
  "composer.leading",
  "composer.trailing",
  "app.statusbar.leading",
  "app.statusbar.trailing",
  "sidebar.toolbar",
  "session.footer",
  "workspace.header",
] as const;

function widgetDefinitions(): WidgetDefinition[] {
  const category = tr("customaction.title");
  return [
    {
      id: "custom-action.bar",
      title: tr("customaction.widget.barTitle"),
      description: tr("customaction.widget.barDescription"),
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: TOOLBAR_SLOTS,
      category,
      capabilities: ["custom-action"],
      // Shows itself only once the project has an action (see isAvailable).
      defaultVisible: true,
      audience: "standard",
      scope: "workspace",
      duplicatable: true,
      resizable: false,
      defaultSize: { w: 3, h: 1 },
      minSize: { w: 1, h: 1 },
      isAvailable: barAvailable,
      render: (context) => createElement(ActionBar, context),
      settingsRender: (context) => createElement(ActionBarSettings, context),
    },
    {
      id: "custom-action.panel",
      title: tr("customaction.widget.panelTitle"),
      description: tr("customaction.widget.panelDescription"),
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.main", "workspace.left", "workspace.right", "workspace.bottom", "workspace.header", "session.empty.widgets"],
      category,
      capabilities: ["custom-action"],
      defaultVisible: false,
      audience: "standard",
      scope: "workspace",
      duplicatable: false,
      resizable: true,
      defaultSize: { w: 6, h: 3 },
      recommendedSize: { w: 6, h: 3 },
      minSize: { w: 2, h: 2 },
      maxSize: { w: 12, h: 12 },
      panelSizes: ["standard", "wide", "large"],
      panelDefaultSize: "wide",
      panelTitle: tr("customaction.title"),
      render: (context) => createElement(ActionPanel, context),
    },
    {
      // The original single-button widget id; old placements keep working.
      id: "custom-action.command",
      title: tr("customaction.widget.singleTitle"),
      description: tr("customaction.widget.singleDescription"),
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: [...TOOLBAR_SLOTS, "workspace.main"],
      category,
      capabilities: ["custom-action"],
      defaultVisible: false,
      audience: "standard",
      scope: "workspace",
      duplicatable: true,
      resizable: false,
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 1, h: 1 },
      isAvailable: singleAvailable,
      render: (context) => createElement(SingleAction, context),
      settingsRender: (context) => createElement(SingleActionSettings, context),
    },
  ];
}

export default defineWebPackage((host) => () => {
  setActionHost(host);
  const off = [
    host.surfaces.register({
      id: "custom-action",
      title: tr("customaction.title"),
      description: tr("customaction.description"),
      shortLabel: tr("customaction.shortTitle"),
      capabilityId: "custom-action",
      order: 46,
      component: ({ projectId }) => createElement(ActionLibrary, { variant: "window", projectId: projectId ?? null }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.44,
        minWidth: 340,
        minHeight: 260,
        preferredMaxWidth: 820,
        keepAlive: true,
        escape: "close",
      },
    }),
    // Result cards for presses from rails and toolbars, over the whole shell.
    host.slots.register({
      slot: "app.layers",
      id: "custom-action.results",
      render: () => createElement(ResultCards),
    }),
    host.capabilities.register({
      id: "custom-action",
      label: tr("customaction.title"),
      plainDescription: tr("customaction.description"),
      keywords: ["custom actions", "actions", "shortcuts", "commands", "scripts", "buttons", "macros", "shell", "run", "deploy"],
      standardTier: "more",
      standardRank: 24,
      defaultRails: { general: "right", engineering: "right", operations: "right" },
      open: () => host.navigation.openWorkspacePane("custom-action"),
      available: () => true,
    }),
    host.settings.registerPage({
      id: "custom-actions",
      label: tr("customaction.title"),
      group: "Customize",
      icon: "zap",
      order: 40,
      component: () => createElement(ActionLibrary, { variant: "settings" }),
      settingsItems: [{
        id: "custom-actions.library",
        pageId: "custom-actions",
        label: tr("customaction.title"),
        description: tr("customaction.description"),
        keywords: ["shortcut", "command", "script", "button", "macro", "shell", "terminal", "run", "agent", "chat"],
        focusTarget: "custom-actions.library",
      }],
    }),
  ];

  // Hosts read widget availability synchronously. When the library changes
  // which projects have actions, re-register so every placed bar re-asks.
  let widgets = host.widgets.registerPlugin({ id: "custom-action", name: tr("customaction.title"), widgets: widgetDefinitions() });
  let key = availabilityKey(getSnapshot());
  const unsubscribe = subscribe(() => {
    const next = availabilityKey(getSnapshot());
    if (next === key) return;
    key = next;
    widgets();
    widgets = host.widgets.registerPlugin({ id: "custom-action", name: tr("customaction.title"), widgets: widgetDefinitions() });
  });
  // Every action is its own rail launcher too (railLaunchers.tsx).
  const offLaunchers = installActionLaunchers(host);
  void refresh();

  return () => {
    offLaunchers();
    unsubscribe();
    widgets();
    off.toReversed().forEach((dispose) => dispose());
    resetActionStore();
    setActionHost(null);
  };
});
