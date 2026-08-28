// The compact shell's permanent session navigation. Workspace destinations
// live in the swipeable top shortcut rail; this bar stays focused on the three
// high-frequency conversation actions the mobile shell must never hide.
import {
  openPalette, setRailPlugin, setSidebarOpen, startNewSession, useStore,
} from "../../store.ts";
import { Icon } from "../../icons.tsx";
import { displaySessionTitle } from "../../format.ts";
import { tr } from "../../i18n/index.ts";
import { tapFeedback } from "../../haptics.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";

export default function WorkspaceBottomNav() {
  const projectId = useStore((state) => state.activeProjectId);
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const title = displaySessionTitle(session?.title ?? "", session?.id);
  const status = session ? resolveSessionStatus(session) : null;

  const openSessions = () => {
    tapFeedback();
    setRailPlugin(null);
    setSidebarOpen(true);
  };

  return (
    <nav className="workspace-bottom-nav session-bottom-nav" aria-label={tr("workspace.workspacebottomnav.session")}>
      <button
        className="session-nav-action"
        aria-label={tr("shell.commandPalette")}
        onClick={() => {
          tapFeedback();
          openPalette("all");
        }}
      >
        <Icon.search />
      </button>
      <button
        className="session-nav-current"
        aria-label={tr("workspace.workspacebottomnav.openSessionsCurrentValue", { title })}
        aria-controls="polyth-session-drawer"
        onClick={openSessions}
      >
        <span className="session-nav-current-kicker">Projects &amp; sessions</span>
        <strong>
          {status && (
            <span
              className={`session-nav-status ${status.kind}`}
              title={status.label}
              aria-label={status.label}
            >
              <span aria-hidden>{status.glyph}</span>
            </span>
          )}
          {session ? title : tr("header.newSession")}
        </strong>
        <Icon.chevronDown />
      </button>
      <button
        className="session-nav-action"
        aria-label={tr("workspace.workspacebottomnav.newSession")}
        disabled={!projectId}
        onClick={() => {
          if (!projectId) return;
          tapFeedback();
          startNewSession(projectId);
        }}
      >
        <Icon.plus />
      </button>
    </nav>
  );
}
