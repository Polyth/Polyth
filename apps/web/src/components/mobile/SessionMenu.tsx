// UX-MOBILE-01 §21: the header title is a real session menu, not a chevron
// that only opens a drawer. New session, rename, fork, archive, the last few
// sessions, and the route to everything else — on the shared sheet system.
import { useState } from "react";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import { api } from "../../api.ts";
import { openSession, refreshSessions } from "../../init.ts";
import {
  setOverlay, setSidebarOpen, setUiError, startNewSession, useStore,
} from "../../store.ts";
import { ago, displaySessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";

export default function SessionMenu({ onClose }: { onClose: () => void }) {
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recent = sessions
    .filter((candidate) => candidate.projectId === projectId
      && candidate.id !== sessionId
      && candidate.status !== "archived")
    .sort((a, b) => (b.lastTurnAt ?? b.updatedAt) - (a.lastTurnAt ?? a.updatedAt))
    .slice(0, 5);

  const run = (work: Promise<unknown>, whatFailed: string) => {
    setBusy(true);
    void work
      .then(() => { if (projectId) return refreshSessions(projectId); })
      .catch((error) => setUiError(friendlyError(whatFailed, error)))
      .finally(() => { setBusy(false); onClose(); });
  };

  if (renaming !== null && session) {
    return (
      <Sheet title={tr("mobile.sessionmenu.renameSession")} className="session-menu-sheet" onClose={() => setRenaming(null)}>
        <div className="starter-form">
          <label className="starter-field">
            <span>{tr("mobile.sessionmenu.title")}</span>
            <input
              value={renaming}
              maxLength={120}
              placeholder={tr("mobile.sessionmenu.sessionTitle")}
              onChange={(event) => setRenaming(event.target.value)}
            />
          </label>
          <div className="starter-form-actions">
            <button type="button" className="ghost-btn" onClick={() => setRenaming(null)}>{tr("common.cancel")}</button>
            <button
              type="button"
              className="primary-btn"
              disabled={busy || renaming.trim() === ""}
              onClick={() => run(api.renameSession(session.id, renaming.trim()), tr("common.error"))}
            >{tr("common.save")}</button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={tr("mobile.sessionmenu.session")} className="session-menu-sheet" onClose={onClose}>
      <div role="listbox" aria-label={tr("mobile.sessionmenu.sessionActions")}>
        <SheetRow
          title={tr("mobile.sessionmenu.newSession")}
          meta={tr("mobile.sessionmenu.startFreshInThisProject")}
          icon={<Icon.newSession />}
          onClick={() => {
            if (projectId) startNewSession(projectId);
            onClose();
          }}
        />
        {session && (
          <>
            <SheetRow
              title={tr("mobile.sessionmenu.rename")}
              icon={<Icon.pencil />}
              onClick={() => setRenaming(session.title)}
            />
            <SheetRow
              title={tr("mobile.sessionmenu.duplicateAsANewSession")}
              meta={tr("mobile.sessionmenu.forkTheConversationSoFar")}
              icon={<Icon.fork />}
              onClick={() => run(
                api.fork(session.id).then((forked) => openSession(forked.id)),
                tr("common.error"),
              )}
            />
            <SheetRow
              title={tr("common.archive")}
              meta={tr("mobile.sessionmenu.keepItReadOnlyInHistory")}
              icon={<Icon.bookmark />}
              onClick={() => run(api.archive(session.id), tr("common.error"))}
            />
          </>
        )}
        {recent.length > 0 && (
          <SheetSection title={tr("mobile.sessionmenu.recentSessions")} count={recent.length}>
            {recent.map((candidate) => (
              <SheetRow
                key={candidate.id}
                title={displaySessionTitle(candidate.title, candidate.id)}
                meta={ago(candidate.lastTurnAt ?? candidate.updatedAt)}
                icon={<Icon.chat />}
                onClick={() => {
                  void openSession(candidate.id).catch((error) =>
                    setUiError(friendlyError(tr("common.error"), error)));
                  onClose();
                }}
              />
            ))}
          </SheetSection>
        )}
        <SheetSection title={tr("common.more")}>
          <SheetRow
            title={tr("mobile.sessionmenu.allProjectsAndSessions")}
            icon={<Icon.files />}
            onClick={() => { setSidebarOpen(true); onClose(); }}
          />
          <SheetRow
            title={tr("common.settings")}
            icon={<Icon.gear />}
            onClick={() => { setOverlay("settings"); onClose(); }}
          />
        </SheetSection>
      </div>
    </Sheet>
  );
}
