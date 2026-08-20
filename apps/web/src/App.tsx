import { useEffect } from "react";
import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import Onboarding from "./components/Onboarding.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import ViewErrorBoundary from "./components/ViewErrorBoundary.tsx";
import { clearUiError, setOverlay, useStore } from "./store.ts";
import { usePrefs } from "./prefs.ts";
import { LiveRegion } from "./components/a11y/live.tsx";
import WorktreeSessionDialog from "./components/WorktreeSessionDialog.tsx";

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
      <div className="workspace">
        <ErrorBanner />
        <ViewErrorBoundary resetKey={viewResetKey}>
          <Main />
        </ViewErrorBoundary>
        <StatusBar />
      </div>
      <ContextRail />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "search" && <SessionSearch />}
      {overlay === "worktree-session" && <WorktreeSessionDialog />}
      <SettingsModal open={overlay === "settings"} onClose={() => setOverlay(null)} />
      <LiveRegion />
    </div>
  );
}
