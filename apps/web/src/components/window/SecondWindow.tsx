// Second windows (secondWindow.ts owns roles, URLs and presence): the shell's
// window header for a chat or pane window, and the coordination every window
// runs — announcing what it shows, taking content handed back, and keeping a
// pane window on the chat the main window shows.
import { useEffect } from "react";
import { getState, presentPaneAsWindow, setUiError, subscribeStore, useStore, activateProject, openWorkspacePane } from "../../store.ts";
import { openSession } from "../../init.ts";
import {
  getSelfPresence,
  getWindowPeers,
  leadMainWindow,
  onWindowReturn,
  returnToMainWindow,
  startWindowPresence,
  subscribeWindowPresence,
  updateWindowPresence,
  useWindowPresence,
  windowRole,
  windowSurface,
} from "../../secondWindow.ts";
import { listSurfaces, useSurfaceVersion } from "../../surfaces.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";
import { displaySessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { tr } from "../../i18n/index.ts";
import { IconButton, ReturnToWindowIcon } from "../ui/index.ts";
import SlotHost from "../slots/SlotHost.ts";
import "./SecondWindow.css";

function reportOpenError(error: unknown): void {
  setUiError(friendlyError(tr("common.error"), error));
}

/** Run by App in every window. */
export function useWindowCoordination(): void {
  useEffect(() => {
    const stop = startWindowPresence();
    // What this window shows, for the others.
    const publish = () => {
      const state = getState();
      const session = state.activeSessionId ? state.sessions.find((candidate) => candidate.id === state.activeSessionId) : undefined;
      updateWindowPresence({
        projectId: session?.projectId ?? state.activeProjectId,
        sessionId: state.activeSessionId,
      });
    };
    publish();
    const unsubscribe = subscribeStore(publish);
    return () => {
      unsubscribe();
      stop();
    };
  }, []);

  // Main window: a second window hands its chat or pane back.
  useEffect(() => {
    if (windowRole() !== "main") return;
    return onWindowReturn((message) => {
      try { window.focus(); } catch { /* the browser decides */ }
      if (message.role === "chat" && message.sessionId) {
        void openSession(message.sessionId).catch(reportOpenError);
        return;
      }
      if (message.role === "pane" && message.surface) {
        const reopen = () => { openWorkspacePane(message.surface!); };
        const state = getState();
        if (message.sessionId && message.sessionId !== state.activeSessionId) {
          void openSession(message.sessionId, { showChat: false }).then(reopen).catch(reportOpenError);
        } else if (!message.sessionId && message.projectId && message.projectId !== state.activeProjectId) {
          activateProject(message.projectId);
          reopen();
        } else {
          reopen();
        }
      }
    });
  }, []);

  // Pane window: show the surface as the whole window, and follow the chat
  // the main window focused last until the person pins it.
  useEffect(() => {
    if (windowRole() !== "pane") return;
    const surface = windowSurface();
    let following: string | null = null;
    const present = () => {
      if (surface) presentPaneAsWindow(surface);
    };
    const follow = () => {
      if (getSelfPresence().pinned) return;
      const lead = leadMainWindow(getWindowPeers());
      if (!lead) return;
      const key = `${lead.projectId ?? ""}/${lead.sessionId ?? ""}`;
      if (key === following) return;
      following = key;
      const state = getState();
      if (lead.sessionId) {
        if (lead.sessionId !== state.activeSessionId) void openSession(lead.sessionId, { showChat: false }).catch(() => {});
      } else if (lead.projectId && lead.projectId !== state.activeProjectId) {
        activateProject(lead.projectId);
      }
    };
    present();
    const unsubscribeStore = subscribeStore(present);
    let lastPinned = getSelfPresence().pinned;
    const unsubscribePresence = subscribeWindowPresence(() => {
      const pinned = getSelfPresence().pinned;
      // Unpinning follows the main window again at once.
      if (pinned !== lastPinned && !pinned) following = null;
      lastPinned = pinned;
      follow();
    });
    follow();
    return () => {
      unsubscribeStore();
      unsubscribePresence();
    };
  }, []);
}

/** "polyth · feat/x": what a second window works on. */
function useWorkContext(): { projectName: string | null; branch: string | null; title: string | null; status: ReturnType<typeof resolveSessionStatus> | null } {
  const session = useStore((state) => state.activeSessionId ? state.sessions.find((candidate) => candidate.id === state.activeSessionId) : undefined);
  const projectId = useStore((state) => session?.projectId ?? state.activeProjectId);
  const projectName = useStore((state) => state.projectRegistry.projects.find((project) => project.id === projectId)?.name ?? null);
  return {
    projectName,
    branch: session?.branch ?? null,
    title: session ? displaySessionTitle(session.title, session.id) : null,
    status: session ? resolveSessionStatus(session) : null,
  };
}

function backToMain(): void {
  // The main window takes the content; this window then closes. With no main
  // window listening (it was closed), the window stays: it is the only view.
  if (returnToMainWindow()) {
    window.close();
    return;
  }
  setUiError(tr("window.noMainWindow"));
}

/** The header a chat or pane window shows in place of the shell header. */
export function SecondWindowHeader() {
  const role = windowRole();
  const context = useWorkContext();
  const presence = useWindowPresence();
  const surfaceVersion = useSurfaceVersion();
  const surfaceId = windowSurface();
  // Packages register their windows after boot: present the pane once its
  // surface exists (the store subscription covers later project moves).
  useEffect(() => {
    if (role === "pane" && surfaceId) presentPaneAsWindow(surfaceId);
  }, [role, surfaceId, surfaceVersion]);
  const surfaceTitle = surfaceId ? listSurfaces().find((surface) => surface.id === surfaceId)?.title ?? null : null;
  const workLine = [context.projectName, context.branch].filter(Boolean).join(" · ");
  const pinned = presence.self.pinned;
  const hasMain = leadMainWindow(presence.peers) !== null;

  useEffect(() => {
    const name = role === "chat" ? context.title : surfaceTitle;
    const where = workLine || null;
    document.title = [name, where, "Polyth"].filter(Boolean).join(" — ");
  }, [role, context.title, surfaceTitle, workLine]);

  return (
    <header className="second-window-header" data-role={role}>
      <div className="second-window-heading">
        {role === "chat" ? (
          <>
            <span
              className="second-window-status"
              data-kind={context.status?.kind ?? "regular"}
              title={context.status?.label}
              aria-hidden="true"
            />
            <strong className="second-window-title">{context.title ?? tr("split.newChat")}</strong>
            {workLine && <span className="second-window-quiet">{workLine}</span>}
          </>
        ) : (
          <>
            <strong className="second-window-title">{workLine || surfaceTitle || tr("header.polyth")}</strong>
            {context.title && (
              <button
                type="button"
                className="second-window-follow"
                aria-pressed={pinned}
                title={pinned ? tr("window.pinnedHint") : tr("window.followingHint")}
                onClick={() => updateWindowPresence({ pinned: !pinned })}
              >
                {pinned ? tr("window.pinnedTo", { title: context.title }) : tr("window.following", { title: context.title })}
              </button>
            )}
          </>
        )}
      </div>
      <span className="second-window-spacer" />
      {hasMain && (
        <IconButton
          icon={ReturnToWindowIcon}
          size="sm"
          variant="ghost"
          label={tr("window.returnToMain")}
          onClick={backToMain}
        />
      )}
      <SlotHost slot="app.window.controls" />
    </header>
  );
}
