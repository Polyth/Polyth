import { useEffect } from "react";
import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import Onboarding from "./components/Onboarding.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import ProjectFolderDialog from "./components/ProjectFolderDialog.tsx";
import ViewErrorBoundary from "./components/ViewErrorBoundary.ts";
import { clearUiError, setOverlay, useStore } from "./store.ts";
import { usePrefs } from "./prefs.ts";
import { LiveRegion } from "./components/a11y/live.tsx";
import WorktreeSessionDialog from "./components/WorktreeSessionDialog.tsx";
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
  const paneFullscreen = useStore((s) => s.paneFullscreen);
  const prefs = usePrefs();

  useEffect(() => {
    const openSettings = () => setOverlay("settings");
    window.addEventListener("polyth:open-settings", openSettings);
    return () => window.removeEventListener("polyth:open-settings", openSettings);
  }, []);

  if (!prefs.persona || overlay === "onboarding") return <Onboarding />;

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
      <LiveRegion />
    </div>
  );
}
