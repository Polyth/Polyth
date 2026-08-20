// UX-PANE-MODEL compact navigation: one bounded row — Chat, Files, Git,
// Terminal, Preview — above the status/safe area at max-width:820px (CSS
// hides it wider). It uses the SAME registered surface model as every other
// launcher and the same command path; it is navigation, not a modal dialog.
// Selecting Chat hides the workspace layer (kept-alive) and the command path
// restores the last Chat focus target or composer without remounting trees.
import { closeWorkspacePane, openWorkspacePane, setActiveView, useStore } from "../../store.ts";
import { usePrefs } from "../../prefs.ts";
import { listSurfaces, useSurfaceVersion, workspaceSurfacesOf } from "../../surfaces.ts";
import { Icon } from "../../icons.tsx";

export default function WorkspaceBottomNav() {
  const rail = useStore((s) => s.railPlugin);
  const view = useStore((s) => s.activeView);
  const prefs = usePrefs();
  useSurfaceVersion();
  const panes = workspaceSurfacesOf(listSurfaces())
    .filter((s) => s.plugin === undefined || prefs.plugins.includes(s.plugin));
  if (panes.length === 0) return null;

  const paneOpen = panes.some((s) => s.id === rail);
  const chatCurrent = !paneOpen && view === "session";

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
