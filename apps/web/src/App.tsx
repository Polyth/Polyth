import { useEffect, useRef } from "react";
import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import PresetSetup from "./components/PresetSetup.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import ProjectFolderDialog from "./components/ProjectFolderDialog.tsx";
import ViewErrorBoundary from "./components/ViewErrorBoundary.ts";
import { clearUiError, setOverlay, useStore } from "./store.ts";
import { usePresetState } from "./workspacePresets.ts";
import { LiveRegion } from "./components/a11y/live.tsx";
import WorktreeSessionDialog from "./components/WorktreeSessionDialog.tsx";
import "./builtinCapabilities.ts";
import WorkspaceBottomNav from "./components/workspace/WorkspaceBottomNav.tsx";

function ErrorBanner() {
  const message = useStore((s) => s.uiError);
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-text">{message}</span>
      <button className="error-banner-x" aria-label="Dismiss error" onClick={clearUiError}>×</button>
    </div>
  );
}

export default function App() {
  const overlay = useStore((s) => s.overlay);
  const viewResetKey = useStore(
    (s) => `${s.activeProjectId ?? ""}:${s.activeSessionId ?? ""}:${s.activeView}`,
  );
  const preset = usePresetState();
  const projectReady = useStore(
    (s) => s.activeProjectId !== null && s.projects.some((p) => p.id === s.activeProjectId),
  );
  const noProjects = useStore((s) => s.projectsLoaded && s.projects.length === 0);
  const paneFullscreen = useStore((s) => s.paneFullscreen);

  useEffect(() => {
    const openSettings = () => setOverlay("settings");
    window.addEventListener("polyth:open-settings", openSettings);
    return () => window.removeEventListener("polyth:open-settings", openSettings);
  }, []);

  // First-run sequence: the shell, runtime state, and project picker never
  // depend on a preset. With no project yet, offer the picker once — preset
  // setup does not cover or replace connection, health, or project errors.
  const autoPickerShown = useRef(false);
  useEffect(() => {
    if (preset.setup === "unseen" && noProjects && overlay === null && !autoPickerShown.current) {
      autoPickerShown.current = true;
      setOverlay("project-picker");
    }
  }, [preset.setup, noProjects, overlay]);

  // Optional preset setup: only after a project is usable, only while unseen,
  // and never over another dialog. Settings can reopen it (overlay).
  const showPresetSetup =
    overlay === "onboarding" || (preset.setup === "unseen" && projectReady && overlay === null);

  return (
    <div className="app">
      <Sidebar />
      {/* UX-PANE-MODEL: while a workspace surface covers the workspace, Chat
          stays mounted underneath but is inert and out of the a11y tree — it
          consumes no hit area and cannot retain sequential focus. */}
      <div className="workspace" inert={paneFullscreen} aria-hidden={paneFullscreen || undefined}>
        <ErrorBanner />
        <ViewErrorBoundary resetKey={viewResetKey}>
          <Main />
        </ViewErrorBoundary>
        <StatusBar />
      </div>
      <ContextRail />
      <WorkspaceBottomNav />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "search" && <SessionSearch />}
      {overlay === "project-picker" && <ProjectFolderDialog onClose={() => setOverlay(null)} />}
      {overlay === "worktree-session" && <WorktreeSessionDialog />}
      <SettingsModal open={overlay === "settings"} onClose={() => setOverlay(null)} />
      {showPresetSetup && <PresetSetup />}
      <LiveRegion />
    </div>
  );
}
