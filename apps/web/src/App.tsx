import { useEffect } from "react";
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
import { decideFirstRunSurface, markAutoPickerOffered, wasAutoPickerOffered } from "./projectOnboarding.ts";
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
  const registryStatus = useStore((s) => s.projectRegistry.status);
  const projectCount = useStore((s) => s.projectRegistry.projects.length);
  const hasActiveProject = useStore(
    (s) => s.activeProjectId !== null && s.projectRegistry.projects.some((p) => p.id === s.activeProjectId),
  );
  const paneFullscreen = useStore((s) => s.paneFullscreen);

  useEffect(() => {
    const openSettings = () => setOverlay("settings");
    window.addEventListener("polyth:open-settings", openSettings);
    return () => window.removeEventListener("polyth:open-settings", openSettings);
  }, []);

  // UX-ONBOARDING coordinator: one pure decision over project-registry truth.
  // `preset.setup` is not an input to picker admission — the picker opens only
  // from a ready-empty registry, once per document, and never over another
  // overlay. The episode flag is read in render; it only changes together with
  // the overlay transition below, so the value is always current.
  const surface = decideFirstRunSurface({
    registryStatus,
    projectCount,
    hasValidActiveProject: hasActiveProject,
    pickerOfferedThisDocument: wasAutoPickerOffered(),
    presetSetup: preset.setup,
  });

  useEffect(() => {
    if (surface === "project-picker" && overlay === null) {
      markAutoPickerOffered();
      setOverlay("project-picker");
    }
  }, [surface, overlay]);

  // Optional preset setup renders only after activeProjectId identifies a
  // project in a ready registry, never over the picker or another dialog.
  // Settings can reopen it explicitly (overlay === "onboarding").
  const showPresetSetup =
    overlay === "onboarding" || (surface === "preset-setup" && overlay === null);

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
