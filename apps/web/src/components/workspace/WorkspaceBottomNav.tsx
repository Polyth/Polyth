// UX-PANE-MODEL compact navigation: one bounded row — Chat, Files, Git,
// Terminal, Preview — above the status/safe area at max-width:820px (CSS
// hides it wider). It uses the SAME registered surface model as every other
// launcher and the same command path; it is navigation, not a modal dialog.
// Selecting Chat hides the workspace layer (kept-alive) and the command path
// restores the last Chat focus target or composer without remounting trees.
import {
  closeWorkspacePane, openWorkspacePane, setActiveView, setOverlay, setSidebarOpen, startNewSession, useStore,
} from "../../store.ts";
import { listSurfaces, useSurfaceVersion, workspaceSurfacesOf } from "../../surfaces.ts";
import { Icon } from "../../icons.tsx";
import { displaySessionTitle } from "../../format.ts";

export default function WorkspaceBottomNav() {
  const rail = useStore((s) => s.railPlugin);
  const view = useStore((s) => s.activeView);
  const projectId = useStore((s) => s.activeProjectId);
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === s.activeSessionId) ?? null);
  useSurfaceVersion();
  const panes = workspaceSurfacesOf(listSurfaces());

  const paneOpen = panes.some((s) => s.id === rail);
  const chatCurrent = !paneOpen && view === "session";

  if (chatCurrent) {
    const title = displaySessionTitle(session?.title ?? "", session?.id);
    const date = session ? new Date(session.createdAt).toISOString().slice(0, 10) : "Start a session";
    return (
      <nav className="workspace-bottom-nav session-bottom-nav" aria-label="Session">
        <button className="session-nav-round" aria-label="Session history" onClick={() => setOverlay("search")}>
          <Icon.rewind />
        </button>
        <button
          className="session-nav-current"
          aria-label={`Open sessions, current: ${title}`}
          onClick={() => setSidebarOpen(true)}
        >
          <span>{session ? `${title} · ${date}` : date}</span>
          <Icon.chevronDown />
        </button>
        <button
          className="session-nav-round"
          aria-label="New session"
          disabled={!projectId}
          onClick={() => {
            if (!projectId) return;
            startNewSession(projectId);
          }}
        >
          <Icon.plus />
        </button>
      </nav>
    );
  }
  if (panes.length === 0) return null;

  return (
    <nav className="workspace-bottom-nav" aria-label="Workspace">
      <button
        className={`wbn-item${chatCurrent ? " current" : ""}`}
        aria-label="Chat"
        aria-current={chatCurrent ? "page" : undefined}
        onClick={() => {
          if (paneOpen) closeWorkspacePane();
          else setActiveView("session");
        }}
      >
        <Icon.context />
        <span className="wbn-label">Chat</span>
      </button>
      {panes.map((s) => {
        const current = rail === s.id;
        return (
          <button
            key={s.id}
            className={`wbn-item${current ? " current" : ""}`}
            aria-label={s.title}
            aria-current={current ? "page" : undefined}
            data-pane-launcher={s.id}
            // Activating the already-current item leaves it open (navigation
            // semantics — only the rail/header launcher toggles closed).
            onClick={() => openWorkspacePane(s.id)}
          >
            {s.icon ? <s.icon /> : <Icon.context />}
            <span className="wbn-label">{s.shortLabel ?? s.title}</span>
          </button>
        );
      })}
    </nav>
  );
}
