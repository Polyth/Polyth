import { getState, setOverlay, setSidebarOpen } from "../store.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";
import { tr } from "../i18n/index.ts";
import { guardedProjectAddAllowed, limitedProjectAddAllowed, useAccountLimits, useGuardrails } from "../guardrails.ts";
import {
  AddIcon, ClockIcon, IconButton, SearchIcon, SettingsIcon,
} from "../components/ui/index.ts";

/** Add project: draws nothing for an account that may not add projects. */
function AddProjectAction() {
  const allowed = guardedProjectAddAllowed(useGuardrails()) && limitedProjectAddAllowed(useAccountLimits());
  if (!allowed) return null;
  return (
    <span className="header-action">
      <IconButton
        icon={AddIcon}
        size="md"
        variant="ghost"
        label={tr("sidebar.addProject")}
        data-intro-anchor="add-project"
        onClick={() => setOverlay("project-picker")}
      />
    </span>
  );
}

const SHELL_ACTION_SLOTS = [
  "app.header.actions", "session.header.actions", "app.nav",
  // Widget-areas (WA4): the search / settings controls can also live in the
  // sidebar toolbar or footer, or the app-header leading cluster.
  "app.header.leading", "sidebar.toolbar", "sidebar.footer",
  // ...or down the navigator's Project rail.
  "sidebar.rail",
  // ...or be dragged from the top-right header rail onto the top or right
  // rail (railPlacement.ts rail zones).
  "app.header.center", "workspace.rail",
  // ...or at either end of the optional status bar.
  "app.statusbar.leading", "app.statusbar.trailing",
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
            data-intro-anchor="settings"
            onClick={() => {
              // From the compact navigator drawer, Settings replaces it.
              if (getState().sidebarOpen) setSidebarOpen(false);
              setOverlay("settings");
            }}
          />
        </span>
      ),
    },
    {
      // The Project rail's "+" is this widget, not a fixed button: it
      // reorders, moves to another rail and hides like every rail item.
      id: "shell.add-project",
      title: tr("sidebar.addProject"),
      description: tr("widgets.builtinminiwidgets.openAddProject"),
      kind: "mini-widget",
      defaultSlot: "sidebar.rail",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 40,
      render: () => <AddProjectAction />,
    },
  ],
});
let installed = false;
export function installBuiltinMiniWidgets(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(SHELL_ACTIONS_PLUGIN);
}
