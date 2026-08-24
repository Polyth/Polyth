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
      <Sheet title="Rename session" className="session-menu-sheet" onClose={() => setRenaming(null)}>
        <div className="starter-form">
          <label className="starter-field">
            <span>Title</span>
            <input
              value={renaming}
              maxLength={120}
              placeholder="Session title"
              onChange={(event) => setRenaming(event.target.value)}
            />
          </label>
          <div className="starter-form-actions">
            <button type="button" className="ghost-btn" onClick={() => setRenaming(null)}>Cancel</button>
            <button
              type="button"
              className="primary-btn"
              disabled={busy || renaming.trim() === ""}
              onClick={() => run(api.renameSession(session.id, renaming.trim()), "Couldn’t rename the session")}
            >Save</button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Session" className="session-menu-sheet" onClose={onClose}>
      <div role="listbox" aria-label="Session actions">
        <SheetRow
          title="New session"
          meta="Start fresh in this project"
          icon={<Icon.newSession />}
          onClick={() => {
            if (projectId) startNewSession(projectId);
            onClose();
          }}
        />
        {session && (
          <>
            <SheetRow
              title="Rename…"
              icon={<Icon.pencil />}
              onClick={() => setRenaming(session.title)}
            />
            <SheetRow
              title="Duplicate as a new session"
              meta="Fork the conversation so far"
              icon={<Icon.fork />}
              onClick={() => run(
                api.fork(session.id).then((forked) => openSession(forked.id)),
                "Couldn’t duplicate the session",
              )}
            />
            <SheetRow
              title="Archive"
              meta="Keep it read-only in history"
              icon={<Icon.bookmark />}
              onClick={() => run(api.archive(session.id), "Couldn’t archive the session")}
            />
          </>
        )}
        {recent.length > 0 && (
          <SheetSection title="Recent sessions" count={recent.length}>
            {recent.map((candidate) => (
              <SheetRow
                key={candidate.id}
                title={displaySessionTitle(candidate.title, candidate.id)}
                meta={ago(candidate.lastTurnAt ?? candidate.updatedAt)}
                icon={<Icon.chat />}
                onClick={() => {
                  void openSession(candidate.id).catch((error) =>
                    setUiError(friendlyError("Couldn’t open the session", error)));
                  onClose();
                }}
              />
            ))}
          </SheetSection>
        )}
        <SheetSection title="More">
          <SheetRow
            title="All projects and sessions"
            icon={<Icon.files />}
            onClick={() => { setSidebarOpen(true); onClose(); }}
          />
          <SheetRow
            title="Settings"
            icon={<Icon.gear />}
            onClick={() => { setOverlay("settings"); onClose(); }}
          />
        </SheetSection>
      </div>
    </Sheet>
  );
}
