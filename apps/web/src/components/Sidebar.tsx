import { Fragment, useEffect, useState } from "react";
import { useStore, activateProject, getState, setUiError } from "../store.ts";
import { addProject, createProject, createSession, openSession, archiveSession, restoreSession, forkSession } from "../init.ts";
import { ago, displaySessionTitle } from "../format.ts";
import { friendlyError, shortcutLabel } from "../settings.ts";
import ProjectForm from "./ProjectForm.tsx";
import type { SessionProjection } from "@polyth/contracts";

const STATUS_DOT: Record<string, string> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  finished: "finished",
  failed: "failed",
  archived: "archived",
};

const STATUS_LABEL: Record<string, string> = {
  working: "Working…",
  waiting: "Waiting on you",
  idle: "Idle",
  finished: "Finished",
  failed: "Failed",
  archived: "Archived",
};

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function GitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="4.6" cy="4" r="1.7" /><circle cx="4.6" cy="12" r="1.7" /><circle cx="11.4" cy="5.6" r="1.7" />
      <path d="M4.6 5.7v4.6M11.4 7.3c0 2.3-2.5 2.5-5 3" />
    </svg>
  );
}

function firstUserText(sessionId: string): string | undefined {
  const events = getState().events[sessionId];
  if (!events) return undefined;
  for (const e of events) {
    if (e.type === "user/message") {
      const d = e.data as Record<string, unknown>;
      const text = typeof d.text === "string" ? d.text : undefined;
      const raw = typeof d.raw === "string" ? d.raw : undefined;
      return text || raw;
    }
  }
  return undefined;
}

function projectGlyph(name: string): string {
  const words = name.trim().split(/[\s\-_/]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase() || "P";
}

function absTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
}

function SessionRow({ session, display, active, relativeTime }: {
  session: SessionProjection;
  display: string;
  active: boolean;
  relativeTime: boolean;
}) {
  const s = session;
  const sub = STATUS_LABEL[s.status] ?? s.status;
  return (
    <div className={`session-row ${active ? "active" : ""} ${s.status === "archived" ? "archived" : ""}`}>
      <button
        className="session-btn"
        aria-current={active ? "true" : undefined}
        title={display}
        onClick={() => void openSession(s.id).catch((e) => setUiError(friendlyError("Couldn’t open the session", e)))}
      >
        <span className={`dot ${STATUS_DOT[s.status] ?? "idle"}`} />
        <span className="session-body">
          <span className="session-title">{display}</span>
          <span className="session-sub">{sub}</span>
        </span>
        <span className="session-time">{relativeTime ? ago(s.updatedAt) : absTime(s.updatedAt)}</span>
      </button>
      <span className="session-actions">
        <button
          title="Fork"
          aria-label={`Fork ${display}`}
          onClick={() => void forkSession(s.id).catch((e) => setUiError(friendlyError("Couldn’t fork the session", e)))}
        >⑂</button>
        {s.status === "archived" ? (
          <button
            title="Restore"
            aria-label={`Restore ${display}`}
            onClick={() => void restoreSession(s.id).catch((e) => setUiError(friendlyError("Couldn’t restore the session", e)))}
          >↑</button>
        ) : (
          <button
            title="Archive"
            aria-label={`Archive ${display}`}
            onClick={() => void archiveSession(s.id).catch((e) => setUiError(friendlyError("Couldn’t archive the session", e)))}
          >↓</button>
        )}
      </span>
    </div>
  );
}

export default function Sidebar() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const branch = useStore((s) => s.gitBranch);
  const settings = useStore((s) => s.settings);
  // Subscribe to events so titles derived from the first prompt stay fresh.
  useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId]?.length : 0));
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [addingProject, setAddingProject] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const handler = () => setAddingProject(true);
    window.addEventListener("polyth:open-project", handler);
    return () => window.removeEventListener("polyth:open-project", handler);
  }, []);

  const q = filter.trim().toLowerCase();
  const projectSessions = sessions
    .filter((s) => s.projectId === activeProjectId)
    .filter((s) => settings.showArchived || s.status !== "archived")
    .map((s) => ({ session: s, display: displaySessionTitle(s.title, s.id, firstUserText(s.id)) }))
    .filter(({ display }) => !q || display.toLowerCase().includes(q))
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt);

  const onAddProject = async (path: string, name: string, create: boolean) => {
    if (create) await createProject(path, name || undefined);
    else await addProject(path, name || undefined);
    setAddingProject(false);
  };
  const onNewSession = () => {
    if (!activeProjectId) return;
    void createSession(activeProjectId).catch((e) => setUiError(friendlyError("Couldn’t create a session", e)));
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span className="brand"><i>p</i> {settings.productName.toLowerCase()}</span>
        <button className="icon-btn" title="Open project" aria-label="Open project" onClick={() => setAddingProject(true)}>+</button>
      </div>
      {addingProject && <ProjectForm onSubmit={onAddProject} onCancel={() => setAddingProject(false)} />}

      <div className="side-scroll">
        {projects.length === 0 && !addingProject && (
          <div className="empty">No projects yet.<br />Open one with +</div>
        )}
        {projects.map((p) => (
          <Fragment key={p.id}>
            <button
              className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
              aria-current={p.id === activeProjectId ? "true" : undefined}
              onClick={() => { if (p.id !== activeProjectId) activateProject(p.id); }}
            >
              <span className="project-glyph">{projectGlyph(p.name || p.path)}</span>
              <span className="project-meta">
                <span className="project-name">{p.name || p.path}</span>
                <span className="project-path" title={p.path}>{p.path}</span>
              </span>
            </button>
            {p.id === activeProjectId && branch && (
              <div className="branch-row">
                <GitIcon />
                <span className="mono">{branch}</span>
              </div>
            )}
          </Fragment>
        ))}

        {project && (
          <>
            <div className="side-search">
              <svg width="14" height="14" viewBox="0 0 16 16" {...STROKE}>
                <circle cx="7.2" cy="7.2" r="4.4" /><path d="M10.5 10.5 13.4 13.4" />
              </svg>
              <input
                type="search"
                value={filter}
                placeholder="Search sessions"
                aria-label="Search sessions"
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="side-label">
              Sessions
              <span className="count">{projectSessions.length}</span>
            </div>
            {projectSessions.length === 0 && (
              <div className="empty" style={{ padding: "12px" }}>{q ? "No sessions match." : "No sessions yet."}</div>
            )}
            {projectSessions.map(({ session: s, display }) => (
              <SessionRow
                key={s.id}
                session={s}
                display={display}
                active={s.id === activeSessionId}
                relativeTime={settings.relativeTime}
              />
            ))}
          </>
        )}
      </div>

      <div className="side-foot">
        <button className="new-session" onClick={onNewSession} disabled={!activeProjectId}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ color: "var(--accent)" }}>
            <path d="M8 3.4v9.2M3.4 8h9.2" />
          </svg>
          New session
          <span className="kbd">{shortcutLabel("N")}</span>
        </button>
        <button
          className="settings-btn"
          onClick={() => window.dispatchEvent(new CustomEvent("polyth:open-settings"))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2.1" />
            <path d="M8 1.6l.9 1.5 1.7-.4.5 1.7 1.7.5-.4 1.7 1.5.9-1.5.9.4 1.7-1.7.5-.5 1.7-1.7-.4-.9 1.5-.9-1.5-1.7.4-.5-1.7-1.7-.5.4-1.7L1.6 8l1.5-.9-.4-1.7 1.7-.5.5-1.7 1.7.4z" />
          </svg>
          Settings
          <span className="kbd">{shortcutLabel(",")}</span>
        </button>
      </div>
    </nav>
  );
}
