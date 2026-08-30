import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import EditorView from "./EditorView.tsx";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "files", title: "Project files", description: "Browse, open, and edit files in this project.", shortLabel: "Files", capabilityId: "files", order: 1, component: EditorView, presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" } }),
    host.capabilities.register({ id: "files", label: "Project files", plainDescription: "Browse and edit project files.", keywords: ["files", "editor", "tree", "quick open"], standardTier: "primary", standardRank: 1, open: () => { host.navigation.openWorkspacePane("files"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "files", name: "Files", widgets: [{ id: "files.explorer", title: "Files", description: "Browse and edit project files.", defaultSlot: "workspace.left", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 6, h: 7 }, minSize: { w: 5, h: 6 }, maxSize: { w: 12, h: 50 }, audience: "standard", scope: "workspace", resizable: true, render: () => createElement(EditorView) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
