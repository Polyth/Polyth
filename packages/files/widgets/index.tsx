import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import EditorView from "./EditorView.tsx";
import FilesSettings from "./FilesSettings.tsx";
import { fileResourceProvider } from "./fileProvider.ts";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "files",
      packageId: "files",
      label: "File editor",
      group: "Engineering",
      icon: "files",
      order: 28,
      component: FilesSettings,
      settingsItems: [
        { id: "files.inline-ai.explain", pageId: "files", label: "Explain prompt", keywords: ["explain", "selection", "inline"], focusTarget: "files.inline-ai.explain" },
        { id: "files.inline-ai.fix", pageId: "files", label: "Fix prompt", keywords: ["fix", "inline", "selection"], focusTarget: "files.inline-ai.fix" },
        { id: "files.inline-ai.model", pageId: "files", label: "Quick model", keywords: ["model", "small", "utility"], focusTarget: "files.inline-ai.model" },
      ],
    }),
    host.resources.registerProvider(fileResourceProvider),
    host.surfaces.register({ id: "files", title: "Project files", description: "Browse, open, and edit files in this project.", shortLabel: "Files", capabilityId: "files", order: 1, component: EditorView, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "files", label: "Project files", plainDescription: "Browse and edit project files.", keywords: ["files", "editor", "tree", "quick open"], standardTier: "primary", standardRank: 1, open: () => { host.navigation.openWorkspacePane("files"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "files", name: "Files", widgets: [{ id: "files.explorer", title: "Files", description: "Browse and edit project files.", defaultSlot: "workspace.left", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 6, h: 7 }, minSize: { w: 5, h: 6 }, maxSize: { w: 12, h: 50 }, audience: "standard", scope: "workspace", resizable: true, render: (context) => createElement(EditorView, { projectId: context.projectId, sessionId: context.sessionId }) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
