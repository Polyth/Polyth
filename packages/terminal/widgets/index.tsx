import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import TerminalView from "./TerminalView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "terminal", title: "Terminal", description: "Run commands in the project workspace.", capabilityId: "terminal", order: 3, component: TerminalView, presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "content" } }),
    host.capabilities.register({ id: "terminal", label: "Terminal", plainDescription: "Run commands in the project workspace.", keywords: ["terminal", "shell", "console"], standardTier: "more", standardRank: 20, open: () => { host.navigation.openWorkspacePane("terminal"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "terminal", name: "Terminal", widgets: [{ id: "terminal.shell", title: "Terminal", description: "Run project-scoped shell sessions.", defaultSlot: "workspace.bottom", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 7 }, minSize: { w: 4, h: 7 }, render: () => createElement(TerminalView) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
