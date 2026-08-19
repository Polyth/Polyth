import Sidebar from "./components/Sidebar.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import Onboarding from "./components/Onboarding.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import SettingsView from "./components/SettingsView.tsx";
import { useStore } from "./store.ts";
import { usePrefs } from "./prefs.ts";

export default function App() {
  const overlay = useStore((s) => s.overlay);
  const prefs = usePrefs();

  if (!prefs.persona || overlay === "onboarding") return <Onboarding />;

  return (
    <div className="app-frame">
      <div className="app">
        <Sidebar />
        <div className="workspace">
          <Main />
        </div>
        <ContextRail />
      </div>
      <StatusBar />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "search" && <SessionSearch />}
      {overlay === "settings" && <SettingsView />}
    </div>
  );
}
