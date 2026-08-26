import { Icon } from "../icons.tsx";
import { setOverlay } from "../store.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";
import { tr } from "../i18n/index.ts";

const SHELL_ACTION_SLOTS = ["app.header.actions", "session.header.actions", "app.nav"] as const;
const SHELL_ACTIONS_PLUGIN = defineWidgetPlugin({
  id: "shell-actions",
  name: tr("widgets.builtinminiwidgets.applicationShell"),
  widgets: [
    { id: "shell.search", title: tr("widgets.builtinminiwidgets.searchCommands"), description: tr("widgets.builtinminiwidgets.openCommandsAndActionsSearch"), kind: "mini-widget", defaultSlot: "app.header.actions", supportedSlots: SHELL_ACTION_SLOTS, defaultVisible: true, defaultSize: { w: 1, h: 1 }, resizable: false, audience: "simple", order: 10, render: () => <button className="header-action" onClick={() => setOverlay("palette")} aria-label={tr("widgets.builtinminiwidgets.searchCommandsAndActions")}><Icon.search /><span>{tr("common.search")}</span></button> },
    { id: "shell.history", title: tr("widgets.builtinminiwidgets.sessionHistory"), description: tr("widgets.builtinminiwidgets.searchSessionHistory"), kind: "mini-widget", defaultSlot: "session.header.actions", supportedSlots: ["session.header.actions", "app.header.actions"], defaultVisible: true, defaultSize: { w: 1, h: 1 }, resizable: false, audience: "simple", order: 20, render: () => <button className="header-action" onClick={() => setOverlay("search")} aria-label={tr("widgets.builtinminiwidgets.searchSessionHistory2")}><Icon.clock /><span>{tr("widgets.builtinminiwidgets.history")}</span></button> },
    { id: "shell.settings", title: tr("common.settings"), description: tr("widgets.builtinminiwidgets.openApplicationSettings"), kind: "mini-widget", defaultSlot: "app.header.actions", supportedSlots: SHELL_ACTION_SLOTS, defaultVisible: true, defaultSize: { w: 1, h: 1 }, resizable: false, audience: "simple", order: 30, render: () => <button className="header-action" title={tr("common.settings")} aria-label={tr("common.settings")} onClick={() => setOverlay("settings")}><Icon.gear /><span>{tr("common.settings")}</span></button> },
  ],
});
let installed = false;
export function installBuiltinMiniWidgets(): void { if (installed) return; installed = true; registerWidgetPlugin(SHELL_ACTIONS_PLUGIN); }
