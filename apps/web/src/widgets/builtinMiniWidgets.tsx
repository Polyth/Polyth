import type { ReactNode } from "react";
import { setOverlay } from "../store.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";
import { tr } from "../i18n/index.ts";
import {
  AssistIcon, ClockIcon, IconButton, SearchIcon, SettingsIcon, Tooltip,
} from "../components/ui/index.ts";

const SHELL_ACTION_SLOTS = [
  "app.header.actions", "session.header.actions", "app.nav",
  // Widget-areas (WA4): the search / settings controls can also live in the
  // sidebar toolbar or footer, or the app-header leading cluster.
  "app.header.leading", "sidebar.toolbar", "sidebar.footer",
] as const;
const SHELL_ACTIONS_PLUGIN = defineWidgetPlugin({
  id: "shell-actions",
  name: tr("widgets.builtinminiwidgets.applicationShell"),
  widgets: [
    {
      id: "shell.search",
      title: tr("widgets.builtinminiwidgets.searchCommands"),
      description: tr("widgets.builtinminiwidgets.openCommandsAndActionsSearch"),
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 10,
      render: () => (
        <span className="header-action">
          <IconButton
            icon={SearchIcon}
            size="md"
            variant="ghost"
            label={tr("widgets.builtinminiwidgets.searchCommandsAndActions")}
            onClick={() => setOverlay("palette")}
          />
        </span>
      ),
    },
    {
      id: "shell.history",
      title: tr("widgets.builtinminiwidgets.sessionHistory"),
      description: tr("widgets.builtinminiwidgets.searchSessionHistory"),
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ["session.header.actions", "app.header.actions"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 20,
      render: () => (
        <span className="header-action">
          <IconButton
            icon={ClockIcon}
            size="md"
            variant="ghost"
            label={tr("widgets.builtinminiwidgets.searchSessionHistory2")}
            onClick={() => setOverlay("search")}
          />
        </span>
      ),
    },
    {
      id: "shell.settings",
      title: tr("common.settings"),
      description: tr("widgets.builtinminiwidgets.openApplicationSettings"),
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 30,
      render: () => (
        <span className="header-action">
          <IconButton
            icon={SettingsIcon}
            size="md"
            variant="ghost"
            label={tr("common.settings")}
            onClick={() => setOverlay("settings")}
          />
        </span>
      ),
    },
  ],
});
const COMPOSER_CONTROLS_PLUGIN = defineWidgetPlugin({
  id: "composer-controls",
  name: tr("widgets.builtinminiwidgets.applicationShell"),
  widgets: [
    {
      id: "composer.next-action",
      title: tr("composer.generateNextAction"),
      description: tr("composer.generateNextAction"),
      kind: "mini-widget",
      defaultSlot: "composer.trailing",
      supportedSlots: ["composer.leading", "composer.trailing"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 50,
      render: (context) => {
        const canGenerate = context.canGenerateNextAction === true;
        const busy = context.suggestionBusy === true;
        const generate = context.generateNextAction;
        if ((!canGenerate && !busy) || typeof generate !== "function") return null;
        return (
          <Tooltip content={tr("composer.generateNextAction")}>
            <IconButton
              className="composer-next-action"
              icon={AssistIcon}
              label={tr("composer.generateNextAction")}
              size="sm"
              busy={busy}
              onClick={generate as () => void}
            />
          </Tooltip>
        );
      },
    },
    {
      id: "composer.effort",
      title: tr("composer.thinking"),
      description: tr("composer.thinking"),
      kind: "mini-widget",
      defaultSlot: "composer.trailing",
      supportedSlots: ["composer.leading", "composer.trailing"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 60,
      render: (context) => context.composerEffortControl as ReactNode ?? null,
    },
    {
      id: "composer.agent",
      title: tr("composer.agent"),
      description: tr("composer.agent"),
      kind: "mini-widget",
      defaultSlot: "composer.trailing",
      supportedSlots: ["composer.leading", "composer.trailing"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 70,
      render: (context) => context.composerAgentControl as ReactNode ?? null,
    },
  ],
});
let installed = false;
export function installBuiltinMiniWidgets(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(SHELL_ACTIONS_PLUGIN);
  registerWidgetPlugin(COMPOSER_CONTROLS_PLUGIN);
}
