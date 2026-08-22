import { Icon } from "../icons.tsx";
import { setOverlay } from "../store.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";

const ACTION_SLOTS = [
  "app.header.actions",
  "session.header.actions",
  "app.nav",
] as const;

const SHELL_ACTIONS_PLUGIN = defineWidgetPlugin({
  id: "shell-actions",
  name: "Application shell",
  widgets: [
    {
      id: "shell.search",
      title: "Search commands",
      description: "Open commands and actions search.",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 10,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("palette")} aria-label="Search commands and actions">
          <Icon.search /><span>Search</span>
        </button>
      ),
    },
    {
      id: "shell.history",
      title: "Session history",
      description: "Search session history.",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 20,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("search")} aria-label="Search session history">
          <Icon.clock /><span>History</span>
        </button>
      ),
    },
    {
      id: "shell.settings",
      title: "Settings",
      description: "Open application settings.",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 30,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("settings")}>
          <Icon.gear /><span>Settings</span>
        </button>
      ),
    },
  ],
});

let installed = false;

export function installBuiltinMiniWidgets(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(SHELL_ACTIONS_PLUGIN);
}
