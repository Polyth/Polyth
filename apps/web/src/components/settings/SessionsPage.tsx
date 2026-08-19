// Sessions settings page: session control (list/new/fork/abort) over the
// /api/control surface — the same API agents and external tools can use.
import { useState } from "react";
import { api } from "../../api.ts";
import { setOverlay, setActiveView, useStore } from "../../store.ts";
import { openSession, refreshSessions } from "../../init.ts";
import { ago } from "../../format.ts";
import { pluginOn } from "../../prefs.ts";
import { EmptyState, PageHead, Row } from "./parts.tsx";

export default function SessionsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const sessions = useStore((s) => s.sessions.filter((x) => x.projectId === s.activeProjectId));
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      if (projectId) await refreshSessions(projectId);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead title="Sessions" blurb="Control sessions here or over the /api/control/sessions API — list, create, fork, abort." />
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
          {pluginOn("schedule") && (
            <Row label="Scheduled prompts" hint="Send a prompt at a time or on an interval.">
              <button className="small-btn" onClick={() => { setOverlay(null); setActiveView("schedule"); }}>Open Schedule →</button>
            </Row>
          )}
          <div className="stat-label">Sessions in project</div>
          {sessions.length === 0 && <EmptyState title="No sessions yet" />}
          {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => (
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
