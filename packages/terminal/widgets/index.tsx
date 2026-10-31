import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import TerminalView from "./TerminalView.tsx";
import TerminalSettingsPage from "./TerminalSettingsPage.tsx";

export default defineWebPackage((host) => () => {
  const t = host.ui.locale.translate;
  const off = [
    host.settings.registerPage({
      id: "terminal",
      packageId: "terminal",
      label: t("terminalsettings.title"),
      group: "Engineering",
      icon: "terminal",
      order: 33,
      component: () => <TerminalSettingsPage host={host} />,
      settingsItems: [
        { id: "terminal.shell", pageId: "terminal", label: t("terminalsettings.shell"), keywords: ["terminal", "shell", "bash", "zsh", "fish", "powershell", "login shell"], focusTarget: "terminal.shell" },
      ],
    }),
    host.surfaces.register({ id: "terminal", title: "Terminal", description: t("terminalview.surfaceDescription"), capabilityId: "terminal", order: 3, component: TerminalView, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.6, minWidth: 380, minHeight: 200, preferredMaxWidth: 760, keepAlive: true, escape: "content", dock: "bottom", dockOptions: ["bottom", "side"] }, "workspace") }),
    host.capabilities.register({ id: "terminal", label: "Terminal", plainDescription: t("terminalview.surfaceDescription"), keywords: ["terminal", "shell", "console"], standardTier: "more", standardRank: 4, defaultRails: { general: "top", engineering: "top", operations: "top" }, open: () => { host.navigation.openWorkspacePane("terminal"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "terminal", name: "Terminal", widgets: [{ id: "terminal.shell", title: "Terminal", description: t("terminalview.widgetDescription"), defaultSlot: "workspace.bottom", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 7 }, minSize: { w: 4, h: 7 }, render: (context) => <TerminalView projectId={context.projectId} sessionId={context.sessionId} /> }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
