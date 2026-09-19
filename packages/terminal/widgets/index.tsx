import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import TerminalView from "./TerminalView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "terminal", title: "Terminal", description: "Run commands in the project workspace.", capabilityId: "terminal", order: 3, component: TerminalView, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.6, minWidth: 380, minHeight: 200, preferredMaxWidth: 760, keepAlive: true, escape: "content", dock: "bottom", dockOptions: ["bottom", "side"] }, "workspace") }),
    host.capabilities.register({ id: "terminal", label: "Terminal", plainDescription: "Run commands in the project workspace.", keywords: ["terminal", "shell", "console"], standardTier: "more", standardRank: 20, open: () => { host.navigation.openWorkspacePane("terminal"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "terminal", name: "Terminal", widgets: [{ id: "terminal.shell", title: "Terminal", description: "Run project-scoped shell sessions.", defaultSlot: "workspace.bottom", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 7 }, minSize: { w: 4, h: 7 }, render: (context) => <TerminalView projectId={context.projectId} sessionId={context.sessionId} /> }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
