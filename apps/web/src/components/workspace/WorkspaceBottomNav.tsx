// The compact shell's permanent session navigation. Workspace destinations
// live in the swipeable top shortcut rail; this bar stays focused on the three
// high-frequency conversation actions the mobile shell must never hide.
import {
  setOverlay, setRailPlugin, setSidebarOpen, startNewSession, useStore,
} from "../../store.ts";
import { Icon } from "../../icons.tsx";
import { displaySessionTitle } from "../../format.ts";
import { tr } from "../../i18n/index.ts";

export default function WorkspaceBottomNav() {
  const projectId = useStore((state) => state.activeProjectId);
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const title = displaySessionTitle(session?.title ?? "", session?.id);

  const openSessions = () => {
    setRailPlugin(null);
    setSidebarOpen(true);
  };

  return (
    <nav className="workspace-bottom-nav session-bottom-nav" aria-label={tr("workspace.workspacebottomnav.session")}>
      <button
        className="session-nav-action"
        aria-label={tr("workspace.workspacebottomnav.sessionHistory")}
        onClick={() => setOverlay("search")}
      >
        <Icon.rewind />
        <span>Recents</span>
      </button>
      <button
        className="session-nav-current"
        aria-label={tr("workspace.workspacebottomnav.openSessionsCurrentValue", { title })}
        aria-controls="polyth-session-drawer"
        onClick={openSessions}
      >
        <span className="session-nav-current-kicker">Projects &amp; sessions</span>
        <strong>{session ? title : tr("header.newSession")}</strong>
        <Icon.chevronDown />
      </button>
      <button
        className="session-nav-action"
        aria-label={tr("workspace.workspacebottomnav.newSession")}
        disabled={!projectId}
        onClick={() => {
          if (projectId) startNewSession(projectId);
        }}
      >
        <Icon.plus />
        <span>New chat</span>
      </button>
    </nav>
  );
}
