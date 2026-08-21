// Sessions settings page: session control (list/new/fork/abort) over the
// /api/control surface — the same API agents and external tools can use.
import { useMemo, useState } from "react";
import { api } from "../../api.ts";
import { setOverlay, setActiveView, setUiError, updateSettings, useStore } from "../../store.ts";
import { openSession, refreshSessions } from "../../init.ts";
import { ago } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { EmptyState, PageHead, Row, Toggle } from "./parts.tsx";

export default function SessionsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  // useSyncExternalStore selectors must return STABLE snapshots — returning a
  // fresh filtered array here looped React (#185) and white-screened the page.
  const allSessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const sessions = useMemo(
    () => allSessions.filter((x) => x.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt),
    [allSessions, projectId],
  );
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      if (projectId) await refreshSessions(projectId);
    } catch (e) {
      setUiError(friendlyError("Couldn’t update the session", e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead title="Sessions" blurb="Control sessions here or over the /api/control/sessions API — list, create, fork, abort." />
      <Row label="Auto-title new sessions" hint="Derive a title from the first prompt." itemId="sessions.autoTitle">
        <Toggle on={settings.autoTitleSessions} onChange={(autoTitleSessions) => updateSettings({ autoTitleSessions })} label="Auto-title sessions" />
      </Row>
      <Row label="Expand archived sessions" hint="Show archived sessions immediately in the sidebar." itemId="sessions.showArchived">
        <Toggle on={settings.showArchived} onChange={(showArchived) => updateSettings({ showArchived })} label="Expand archived sessions" />
      </Row>
      {!projectId && <EmptyState title="No active project" />}
      {projectId && (
        <>
          <Row label="New session" hint="Creates an idle session in the active project.">
            <button
              className="small-btn"
              disabled={busy === "new"}
              onClick={() => void act("new", async () => {
                const ref = await api.controlNew(projectId);
                await openSession(ref.id);
                setOverlay(null);
              })}
            >Create</button>
          </Row>
          <Row label="Scheduled prompts" hint="Send a prompt at a time or on an interval.">
            <button className="small-btn" onClick={() => { setOverlay(null); setActiveView("schedule"); }}>Open Schedule →</button>
          </Row>
          <div className="stat-label">Sessions in project</div>
          {sessions.length === 0 && <EmptyState title="No sessions yet" />}
          {sessions.map((s) => (
            <div key={s.id} className="set-row">
              <div className="set-row-text">
                <div className="set-row-label">
                  <span className={`dot ${s.status}`} style={{ display: "inline-block", marginRight: 6 }} />
                  {s.title || "(untitled)"}
                </div>
                <div className="set-row-hint">{s.status} · {ago(s.updatedAt)} ago</div>
              </div>
              <div className="set-row-control">
                <button className="small-btn" onClick={() => { void openSession(s.id); setOverlay(null); }}>Open</button>
                <button
                  className="small-btn"
                  disabled={busy === s.id}
                  onClick={() => void act(s.id, async () => {
                    const ref = await api.controlFork(s.id);
                    await openSession(ref.id);
                    setOverlay(null);
                  })}
                >Fork</button>
                {s.status === "working" && (
                  <button className="small-btn danger-btn" disabled={busy === s.id} onClick={() => void act(s.id, () => api.controlAbort(s.id))}>
                    Abort
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
