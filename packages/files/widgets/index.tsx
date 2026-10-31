import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import EditorView from "./EditorView.tsx";
import WorkspaceSearch from "./WorkspaceSearch.tsx";
import SessionWorkspace from "./SessionWorkspace.tsx";
import FilesSettings from "./FilesSettings.tsx";
import RepositorySettings from "./RepositorySettings.tsx";
import { fileResourceProvider } from "./fileProvider.ts";
import { bindFilesWorkbench } from "./workbenchHints.ts";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const translate = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  const off = [
    bindFilesWorkbench(host.workbench),
    host.settings.registerPage({
      id: "files",
      packageId: "files",
      label: translate("filesreg.pageLabel"),
      group: "Engineering",
      icon: "files",
      order: 28,
      component: FilesSettings,
      settingsItems: [
        { id: "files.inline-ai.explain", pageId: "files", label: translate("filessettings.explainPrompt"), keywords: ["explain", "selection", "inline"], focusTarget: "files.inline-ai.explain" },
        { id: "files.inline-ai.fix", pageId: "files", label: translate("filessettings.fixPrompt"), keywords: ["fix", "inline", "selection"], focusTarget: "files.inline-ai.fix" },
        { id: "files.inline-ai.model", pageId: "files", label: translate("filessettings.quickModel"), keywords: ["model", "small", "utility"], focusTarget: "files.inline-ai.model" },
        { id: "files.external.folders", pageId: "files", label: translate("filesreg.foldersOutside"), keywords: ["outside", "absolute", "tmp", "folders", "security", "read"], focusTarget: "files.external.folders" },
        { id: "files.external.extensions", pageId: "files", label: translate("filesreg.typesOutside"), keywords: ["outside", "extensions", "types", "security", "read"], focusTarget: "files.external.extensions" },
      ],
    }),
    host.projectSettings.register({
      id: "files.repositories",
      label: translate("filesreg.reposLabel"),
      description: translate("filesreg.reposDescription"),
      icon: "folder",
      order: 10,
      render: ({ projectId, project }) => <RepositorySettings projectId={projectId} project={project} folderPicker={host.ui.components.FolderPicker} />,
    }),
    host.resources.registerProvider(fileResourceProvider),
    // A new chat picks its repositories in the composer's location row (host);
    // an open session edits its membership from the header.
    host.slots.register({ slot: "session.header.status", id: "files.workspace.session", order: 20, render: () => <SessionWorkspace openRepositories={host.projectSettings.open ? (id) => host.projectSettings.open!(id, "files.repositories") : undefined} /> }),
    host.surfaces.register({ id: "workspace-search", title: translate("filesreg.searchTitle"), description: translate("filesreg.searchDescription"), shortLabel: translate("filesreg.searchShort"), capabilityId: "workspace-search", order: 2, component: (props) => createElement(WorkspaceSearch, { ...props, resourceLink: host.ui.components.ResourceLink }), presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "workspace-search", label: translate("filesreg.searchCapability"), plainDescription: translate("filesreg.searchPlain"), keywords: ["search", "find", "content", "repositories"], standardTier: "more", standardRank: 2, defaultRails: {}, open: () => { host.navigation.openWorkspacePane("workspace-search"); }, available: () => host.store.getSnapshot().activeProjectId !== null }),
    host.surfaces.register({ id: "files", title: translate("editorview.projectFiles"), description: translate("filesreg.filesDescription"), shortLabel: translate("editorview.files"), capabilityId: "files", order: 1, component: EditorView, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "files", label: translate("editorview.projectFiles"), plainDescription: translate("filesreg.filesPlain"), keywords: ["files", "editor", "tree", "quick open"], standardTier: "primary", standardRank: 1, defaultRails: { general: "top", engineering: "top", research: "top", operations: "top", finance: "right", personal: "right" }, open: () => { host.navigation.openWorkspacePane("files"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "files", name: translate("editorview.files"), widgets: [{ id: "files.explorer", title: translate("editorview.files"), description: translate("filesreg.filesPlain"), defaultSlot: "workspace.left", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 6, h: 7 }, minSize: { w: 5, h: 6 }, maxSize: { w: 12, h: 50 }, audience: "standard", scope: "workspace", resizable: true, render: (context) => createElement("div", { className: "files-widget" }, createElement(EditorView, { embedded: true, projectId: context.projectId, sessionId: context.sessionId })) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
