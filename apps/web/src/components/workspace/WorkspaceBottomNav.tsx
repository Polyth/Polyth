// UX-PANE-MODEL compact navigation: one bounded row with at most four direct
// destinations plus a More sheet above the status/safe area at max-width:820px
// (CSS hides it wider). It uses the SAME registered surface model as every
// other launcher and the same command path; it is navigation, not a modal.
// Selecting Chat hides the workspace layer (kept-alive) and the command path
// restores the last Chat focus target or composer without remounting trees.
import { useState } from "react";
import {
  closeWorkspacePane, openWorkspacePane, setActiveView, setOverlay, setSidebarOpen, startNewSession, useStore,
} from "../../store.ts";
import { listSurfaces, useSurfaceVersion, workspaceSurfacesOf } from "../../surfaces.ts";
import { Icon } from "../../icons.tsx";
import { displaySessionTitle } from "../../format.ts";
import { tr } from "../../i18n/index.ts";
import Sheet, { SheetRow } from "../mobile/Sheet.tsx";
import { tapFeedback } from "../../haptics.ts";

const MAX_PRIMARY_NAV_ITEMS = 4;

export default function WorkspaceBottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const rail = useStore((s) => s.railPlugin);
  const view = useStore((s) => s.activeView);
  const projectId = useStore((s) => s.activeProjectId);
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === s.activeSessionId) ?? null);
  useSurfaceVersion();
  const panes = workspaceSurfacesOf(listSurfaces());
  const primaryPanes = panes.slice(0, MAX_PRIMARY_NAV_ITEMS - 1);
  const overflowPanes = panes.slice(MAX_PRIMARY_NAV_ITEMS - 1);

  const paneOpen = panes.some((s) => s.id === rail);
  const chatCurrent = !paneOpen && view === "session";
  const overflowCurrent = overflowPanes.some((s) => s.id === rail);

  if (chatCurrent) {
    const title = displaySessionTitle(session?.title ?? "", session?.id);
    const date = session ? new Date(session.createdAt).toISOString().slice(0, 10) : "Start a session";
    return (
      <nav className="workspace-bottom-nav session-bottom-nav" aria-label={tr("workspace.workspacebottomnav.session")}>
        <button className="session-nav-round" aria-label={tr("workspace.workspacebottomnav.sessionHistory")} onClick={() => { tapFeedback(); setOverlay("search"); }}>
          <Icon.rewind />
        </button>
        <button
          className="session-nav-current"
          aria-label={tr("workspace.workspacebottomnav.openSessionsCurrentValue", { title: title })}
          onClick={() => { tapFeedback(); setSidebarOpen(true); }}
        >
          <span>{session ? `${title} · ${date}` : date}</span>
          <Icon.chevronDown />
        </button>
        <button
          className="session-nav-round"
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
  if (panes.length === 0) return null;

  return (
    <>
      <nav className="workspace-bottom-nav" aria-label={tr("workspace.workspacebottomnav.workspace")}>
        <button
          className={`wbn-item${chatCurrent ? " current" : ""}`}
          aria-label={tr("workspace.workspacebottomnav.chat")}
          aria-current={chatCurrent ? "page" : undefined}
          onClick={() => {
            tapFeedback();
            setMoreOpen(false);
            if (paneOpen) closeWorkspacePane();
            else setActiveView("session");
          }}
        >
          <Icon.context />
          <span className="wbn-label">{tr("workspace.workspacebottomnav.chat")}</span>
        </button>
        {primaryPanes.map((s) => {
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
              onClick={() => {
                tapFeedback();
                setMoreOpen(false);
                openWorkspacePane(s.id);
              }}
            >
              {s.icon ? <s.icon /> : <Icon.context />}
              <span className="wbn-label">{s.shortLabel ?? s.title}</span>
            </button>
          );
        })}
        {overflowPanes.length > 0 && (
          <button
            type="button"
            className={`wbn-item${overflowCurrent ? " current" : ""}`}
            aria-label={tr("header.moreTools")}
            aria-current={overflowCurrent ? "page" : undefined}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            onClick={() => { tapFeedback(); setMoreOpen(true); }}
          >
            <Icon.more />
            <span className="wbn-label">{tr("common.more")}</span>
          </button>
        )}
      </nav>
      {moreOpen && overflowPanes.length > 0 && (
        <Sheet
          title={tr("header.moreTools")}
          className="workspace-more-sheet"
          onClose={() => setMoreOpen(false)}
        >
          <div role="listbox" aria-label={tr("header.moreTools")}>
            {overflowPanes.map((s) => (
              <SheetRow
                key={s.id}
                title={s.title}
                icon={s.icon ? <s.icon /> : <Icon.context />}
                selected={rail === s.id}
                onClick={() => {
                  tapFeedback();
                  openWorkspacePane(s.id);
                  setMoreOpen(false);
                }}
              />
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
