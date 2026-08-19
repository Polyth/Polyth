import { useCallback, useEffect, useState } from "react";
import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import { clearUiError, getState, setUiError, useStore } from "./store.ts";
import { createSession } from "./init.ts";
import { friendlyError } from "./settings.ts";

function ErrorBanner() {
  const message = useStore((s) => s.uiError);
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.8M8 11.2v.1" />
      </svg>
      <span className="error-banner-text">{message}</span>
      <button className="error-banner-x" aria-label="Dismiss error" onClick={clearUiError}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" /></svg>
      </button>
    </div>
  );
}

export default function App() {
  const [railOpen, setRailOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toggleRail = useCallback(() => setRailOpen((v) => !v), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    const onOpenSettings = () => setSettingsOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key.toLowerCase() === "n" && !e.shiftKey) {
        const pid = getState().activeProjectId;
        if (!pid) return;
        e.preventDefault();
        void createSession(pid).catch((err) => setUiError(friendlyError("Couldn’t create a session", err)));
      }
    };
    window.addEventListener("polyth:open-settings", onOpenSettings);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("polyth:open-settings", onOpenSettings);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <div className="workspace">
        <ErrorBanner />
        <Main />
        <StatusBar />
      </div>
      <ContextRail open={railOpen} onToggle={toggleRail} />
      <CommandPalette onToggleRail={toggleRail} />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </div>
  );
}
