import { useState } from "react";
import { useStore, activateProject, setActiveView, setOverlay, setSidebarOpen } from "../store.ts";
import { addProject, createProject, createSession, openSession, archiveSession, restoreSession, forkSession } from "../init.ts";
import { usePrefs } from "../prefs.ts";
import { ago, MOD, deriveSessionTitle } from "../format.ts";
import { getUiSettings } from "../uiPrefs.ts";
import { firstUserText } from "../utils.ts";
import { Icon } from "../icons.tsx";
import ProjectForm from "./ProjectForm.tsx";

const STATUS_DOT: Record<string, string> = {
  working: "working",
  waiting: "waiting",
  idle: "idle",
  finished: "finished",
  failed: "failed",
  archived: "archived",
};

export default function Sidebar() {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const eventsMap = useStore((s) => s.events);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const drawerOpen = useStore((s) => s.sidebarOpen);
  const prefs = usePrefs();
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const projectSessions = sessions
    .filter((s) => s.projectId === activeProjectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const [addingProject, setAddingProject] = useState(false);

  const onAddProject = async (path: string, name: string, create: boolean) => {
    if (create) await createProject(path, name || undefined);
    else await addProject(path, name || undefined);
    setAddingProject(false);
  };
  const onNewSession = () => {
    if (!activeProjectId) return;
    setSidebarOpen(false);
    void createSession(activeProjectId).catch((e) => window.alert(`create session failed: ${e}`));
  };

  return (
    <>
      {drawerOpen && <div className="menu-backdrop sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <nav className={`sidebar ${drawerOpen ? "open" : ""}`}>
        <div className="sidebar-head">
          <span className="brand"><i>p</i> polyth</span>
          <span className="side-icons">
            <button className="icon-btn" title={`Search sessions (${MOD}P)`} onClick={() => setOverlay("search")}><Icon.search /></button>
            {prefs.plugins.includes("git") && (
              <button className="icon-btn" title="Git & worktrees" onClick={() => setActiveView("git")}><Icon.tree /></button>
            )}
            <button className="icon-btn" title="Customize workspace & settings" onClick={() => setOverlay("settings")}><Icon.gear /></button>
            <button className="icon-btn" title="Open project" onClick={() => setAddingProject(true)}><Icon.plus /></button>
          </span>
        </div>
        {addingProject && <ProjectForm onSubmit={onAddProject} onCancel={() => setAddingProject(false)} />}
        {projects.length === 0 && <div className="empty">No projects yet.<br />Add one with +</div>}
        {projects.map((p) => (
          <button
            key={p.id}
            className={`project-row ${p.id === activeProjectId ? "active" : ""}`}
            aria-current={p.id === activeProjectId ? "true" : undefined}
            onClick={() => {
              // Clicking the already-active project must not drop the session (UX-04).
              if (p.id !== activeProjectId) activateProject(p.id);
            }}
          >
            <span className="project-dot" />
            <span className="project-main">
              <span className="project-name" title={p.path}>{p.name || p.path}</span>
              <span className="project-path">{p.path}</span>
            </span>
          </button>
        ))}

        {project && (
          <>
            <div className="session-list">
              <div className="session-heading">
                <span>Sessions</span>
                <span className="project-path" title={project.path}>{project.path}</span>
              </div>
              {projectSessions.length === 0 && <div className="empty" style={{ padding: "12px" }}>No sessions.</div>}
              {projectSessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-row ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}`}
                >
                  <button
                    className="session-btn"
                    aria-current={s.id === activeSessionId ? "true" : undefined}
                    title={s.title}
                    onClick={() => { setSidebarOpen(false); void openSession(s.id); }}
                  >
                    <span className={`dot ${STATUS_DOT[s.status] ?? "idle"}`} />
                    <span className="session-title">{deriveSessionTitle(s.title, firstUserText(eventsMap[s.id]))}</span>
                    <span className="session-time">{ago(s.updatedAt)}</span>
                  </button>
                  <span className="session-actions">
                    <button
                      title="Fork"
                      aria-label={`Fork ${s.title || "session"}`}
                      onClick={() => void forkSession(s.id).catch((e) => window.alert(`fork failed: ${e}`))}
                    >⑂</button>
                    {s.status === "archived" ? (
                      <button title="Restore" aria-label={`Restore ${s.title || "session"}`} onClick={() => void restoreSession(s.id).catch((e) => window.alert(`restore failed: ${e}`))}>↑</button>
                    ) : (
                      <button
                        title="Archive"
                        aria-label={`Archive ${s.title || "session"}`}
                        onClick={() => {
                          // Settings > Behavior: optional confirmation before archiving.
                          if (getUiSettings().confirmSessionArchive && !window.confirm(`Archive "${s.title || "session"}"?`)) return;
                          void archiveSession(s.id).catch((e) => window.alert(`archive failed: ${e}`));
                        }}
                      >↓</button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <button className="new-session-btn" onClick={onNewSession}>New session <span>{MOD} N</span></button>
          </>
        )}
      </nav>
    </>
  );
}
