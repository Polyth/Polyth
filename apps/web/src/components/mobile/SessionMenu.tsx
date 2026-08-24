// UX-MOBILE-01 §21: the phone header's session menu. The whole title is the
// trigger; this sheet is the real menu behind it — new / rename / fork /
// archive plus a short recent-session list, all one tap deep.
import { useState } from "react";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import { Icon } from "../../icons.tsx";
import { api } from "../../api.ts";
import {
  archiveSession, forkSession, openSession, refreshSessions,
} from "../../init.ts";
import { setUiError, startNewSession, useStore } from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { announce } from "../a11y/live.tsx";
import { ago, displaySessionTitle } from "../../format.ts";
import { tapFeedback } from "../../haptics.ts";

const RECENT_LIMIT = 3;

export default function SessionMenu({ onClose }: { onClose: () => void }) {
  const projectId = useStore((s) => s.activeProjectId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const sessions = useStore((s) => s.sessions);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session?.title ?? "");

  const recent = sessions
    .filter((candidate) =>
      candidate.projectId === projectId
      && candidate.status !== "archived"
      && candidate.id !== session?.id)
    .sort((a, b) => (b.lastTurnAt ?? b.updatedAt) - (a.lastTurnAt ?? a.updatedAt))
    .slice(0, RECENT_LIMIT);

  const run = (action: () => void) => {
    tapFeedback();
    onClose();
    action();
  };

  const doRename = async () => {
    const next = title.trim();
    setRenaming(false);
    if (!session || !next || next === session.title) return;
    try {
      await api.renameSession(session.id, next);
      announce(`Session renamed to ${next}`);
      if (projectId) await refreshSessions(projectId);
    } catch (error) {
      setUiError(friendlyError("Couldn’t rename the session", error));
    }
    onClose();
  };

  return (
    <Sheet title={session ? displaySessionTitle(session.title, session.id) : "Session"} onClose={onClose}>
      {renaming && session ? (
        <form
          className="starter-form"
          onSubmit={(event) => {
            event.preventDefault();
            void doRename();
          }}
        >
          <label className="starter-field">
            <span>Session name</span>
            <input
              autoFocus
              value={title}
              placeholder={displaySessionTitle(session.title, session.id)}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="starter-form-actions">
            <button type="button" onClick={() => setRenaming(false)}>Cancel</button>
            <button type="submit" className="primary-btn" disabled={title.trim() === ""}>Rename</button>
          </div>
        </form>
      ) : (
        <>
          <div role="group" aria-label="Session actions">
            <SheetRow
              title="New session"
              meta="Start fresh in this project"
              icon={<Icon.newSession />}
              onClick={() => run(() => {
                if (projectId) startNewSession(projectId);
              })}
            />
            {session && (
              <SheetRow
                title="Rename"
                meta="Give this session a clear name"
                icon={<Icon.pencil />}
                onClick={() => {
                  setTitle(session.title);
                  setRenaming(true);
                }}
              />
            )}
            {session && (
              <SheetRow
                title="Fork"
                meta="Branch a copy from here"
                icon={<Icon.fork />}
                onClick={() => run(() => {
                  void forkSession(session.id).catch((error) =>
                    setUiError(friendlyError("Couldn’t fork the session", error)));
                })}
              />
            )}
            {session && (
              <SheetRow
                title="Archive"
                meta="Move it out of the active list"
                icon={<Icon.trash />}
                onClick={() => run(() => {
                  void archiveSession(session.id)
                    .then(() => announce("Session archived"))
                    .catch((error) => setUiError(friendlyError("Couldn’t archive the session", error)));
                })}
              />
            )}
          </div>
          {recent.length > 0 && (
            <SheetSection title="Recent" count={recent.length}>
              {recent.map((candidate) => (
                <SheetRow
                  key={candidate.id}
                  title={displaySessionTitle(candidate.title, candidate.id)}
                  meta={ago(candidate.lastTurnAt ?? candidate.updatedAt)}
                  icon={<Icon.session />}
                  onClick={() => run(() => {
                    void openSession(candidate.id).catch((error) =>
                      setUiError(friendlyError("Couldn’t open the session", error)));
                  })}
                />
              ))}
            </SheetSection>
          )}
        </>
      )}
    </Sheet>
  );
}
