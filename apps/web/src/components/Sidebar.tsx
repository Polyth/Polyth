import { useState } from "react";
import { useStore, activateProject } from "../store.ts";
import { addProject, createProject, createSession, openSession, archiveSession, restoreSession, forkSession } from "../init.ts";
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
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
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
    void createSession(activeProjectId).catch((e) => window.alert(`create session failed: ${e}`));
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span className="brand"><i>p</i> polyth</span>
        <button className="icon-btn" title="Open project" onClick={() => setAddingProject(true)}>+</button>
      </div>
      {addingProject && <ProjectForm onSubmit={onAddProject} onCancel={() => setAddingProject(false)} />}
      {projects.length === 0 && <div className="empty">No projects yet.<br />Add one with +</div>}
      {projects.map((p) => (
        <div
          key={p.id}
          className={`project-row ${p.id === activeProjectId ? "active" : ""}`}
          onClick={() => activateProject(p.id)}
        >
          <span className="project-dot" />
          <span className="project-name" title={p.path}>{p.name || p.path}</span>
        </div>
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
                onClick={() => void openSession(s.id)}
                title={s.title}
              >
                <span className={`dot ${STATUS_DOT[s.status] ?? "idle"}`} />
                <span className="session-title">{s.title || "(untitled)"}</span>
                <span className="session-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    title="Fork"
                    onClick={() => void forkSession(s.id).catch((e) => window.alert(`fork failed: ${e}`))}
                  >⑂</button>
                  {s.status === "archived" ? (
                    <button title="Restore" onClick={() => void restoreSession(s.id).catch((e) => window.alert(`restore failed: ${e}`))}>↑</button>
                  ) : (
                    <button title="Archive" onClick={() => void archiveSession(s.id).catch((e) => window.alert(`archive failed: ${e}`))}>↓</button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <button className="new-session-btn" onClick={onNewSession}>New session <span>⌘ N</span></button>
        </>
      )}
    </nav>
  );
}
