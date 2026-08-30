import { setOverlay } from "../store.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";
import { tr } from "../i18n/index.ts";
import { ClockIcon, IconButton, SearchIcon, SettingsIcon } from "../components/ui/index.ts";

const SHELL_ACTION_SLOTS = ["app.header.actions", "session.header.actions", "app.nav"] as const;
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
let installed = false;
export function installBuiltinMiniWidgets(): void { if (installed) return; installed = true; registerWidgetPlugin(SHELL_ACTIONS_PLUGIN); }
