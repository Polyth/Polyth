import { useEffect } from "react";
import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import ProjectFolderDialog from "./components/ProjectFolderDialog.tsx";
import ViewErrorBoundary from "./components/ViewErrorBoundary.ts";
import { clearUiError, setOverlay, useStore } from "./store.ts";
import { decideFirstRunSurface, markAutoPickerOffered, wasAutoPickerOffered } from "./projectOnboarding.ts";
import { LiveRegion } from "./components/a11y/live.tsx";
import WorktreeSessionDialog from "./components/WorktreeSessionDialog.tsx";
import "./builtinCapabilities.ts";
import Header from "./components/Header.tsx";
import AlertDialog from "./components/AlertDialog.tsx";
import { useWorkspaceMode } from "./widgets/workspaceMode.ts";
import { useShellMode } from "./responsiveShell.ts";
import { tr } from "./i18n/index.ts";
import { IconButton, Notice } from "./components/ui/index.ts";
import { CloseIcon } from "./components/ui/icons.ts";
import BackgroundQuickPicker from "./components/BackgroundPicker.tsx";

function ErrorBanner() {
  const message = useStore((s) => s.uiError);
  if (!message) return null;
  return (
    <Notice
      tone="error"
      className="error-banner"
      role="alert"
      actions={<IconButton icon={CloseIcon} label={tr("app.dismissError")} size="sm" onClick={clearUiError} />}
    >
      {message}
    </Notice>
  );
}

export default function App() {
  const overlay = useStore((s) => s.overlay);
  const viewResetKey = useStore(
    (s) => `${s.activeProjectId ?? ""}:${s.activeSessionId ?? ""}:${s.activeView}`,
  );
  const registryStatus = useStore((s) => s.projectRegistry.status);
  const projectCount = useStore((s) => s.projectRegistry.projects.length);
  const paneFullscreen = useStore((s) => s.paneFullscreen);
  const activeView = useStore((s) => s.activeView);
  const workspaceMode = useWorkspaceMode();
  const shellMode = useShellMode();

  useEffect(() => {
    const openSettings = () => setOverlay("settings");
    window.addEventListener("polyth:open-settings", openSettings);
    return () => window.removeEventListener("polyth:open-settings", openSettings);
  }, []);

  // UX-ONBOARDING coordinator: one pure decision over project-registry truth.
  // Per-project setup is not an input to picker admission — the picker opens
  // only from a ready-empty registry, once per document, and never over another
  // overlay.
  const surface = decideFirstRunSurface({
    registryStatus,
    projectCount,
    pickerOfferedThisDocument: wasAutoPickerOffered(),
  });

  useEffect(() => {
    if (surface === "project-picker" && overlay === null) {
      markAutoPickerOffered();
      setOverlay("project-picker");
    }
  }, [surface, overlay]);

  return (
    <div className={`app mode-${workspaceMode} view-${activeView}`}>
      <Header />
      <div className="app-shell">
        <Sidebar />
        {/* UX-PANE-MODEL: while a workspace surface covers the workspace, Chat
            stays mounted underneath but is inert and out of the a11y tree — it
            consumes no hit area and cannot retain sequential focus. */}
        <div className="workspace" inert={paneFullscreen} aria-hidden={paneFullscreen || undefined}>
          <ViewErrorBoundary resetKey={viewResetKey}>
            <Main />
          </ViewErrorBoundary>
          {shellMode !== "phone" && <StatusBar />}
        </div>
        <ContextRail />
      </div>
      <BackgroundQuickPicker />
      <ErrorBanner />
      <AlertDialog />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "search" && <SessionSearch />}
      {overlay === "project-picker" && <ProjectFolderDialog onClose={() => setOverlay(null)} />}
      {overlay === "worktree-session" && <WorktreeSessionDialog />}
      <SettingsModal open={overlay === "settings"} onClose={() => setOverlay(null)} />
      <LiveRegion />
    </div>
  );
}
