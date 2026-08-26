import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import PreviewView from "./PreviewView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "browser", title: "Browser", shortLabel: "Preview", capabilityId: "browser", order: 4, component: PreviewView, presentation: { kind: "workspace", defaultRatio: 0.45, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" } }),
    host.capabilities.register({ id: "browser", label: "Browser", plainDescription: "Browse with agents and point at page elements.", keywords: ["browser", "element picker", "agent browser", "app"], standardTier: "primary", standardRank: 2, open: () => { host.navigation.openWorkspacePane("browser"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "browser", name: "Browser", widgets: [{ id: "browser.app", title: "Browser", description: "Browse pages with agents.", defaultSlot: "workspace.bottom", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 6 }, render: () => createElement(PreviewView) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
