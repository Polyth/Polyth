import { useState } from "react";
import { useStore, activateProject, setActiveView, setOverlay, setProjects, setSidebarOpen, setUiError } from "../store.ts";
import { addProject, createProject, createSession } from "../init.ts";
import { api } from "../api.ts";
import { usePrefs } from "../prefs.ts";
import { MOD } from "../format.ts";
import { friendlyError } from "../settings.ts";
import { Icon } from "../icons.tsx";
import ProjectForm from "./ProjectForm.tsx";
import SessionList from "./sidebar/SessionList.tsx";

function projectGlyph(name: string): string {
  const words = name.trim().split(/[\s\-_/]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || "P";
}

export default function Sidebar() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const drawerOpen = useStore((s) => s.sidebarOpen);
  const branch = useStore((s) => s.gitBranch);
  const productName = useStore((s) => s.settings.productName);
  const prefs = usePrefs();
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [addingProject, setAddingProject] = useState(false);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");

  const onAddProject = async (path: string, name: string, create: boolean) => {
    if (create) await createProject(path, name || undefined);
    else await addProject(path, name || undefined);
    setAddingProject(false);
  };
  const onNewSession = () => {
    if (!activeProjectId) return;
    setSidebarOpen(false);
    void createSession(activeProjectId).catch((e) => setUiError(friendlyError("Couldn’t create a session", e)));
  };
  const saveProjectName = async (id: string) => {
    const name = projectName.trim();
    setRenamingProject(null);
    const current = projects.find((p) => p.id === id);
    if (!name || !current || name === current.name) return;
    try {
      await api.patchProject(id, { name });
      setProjects(await api.listProjects());
    } catch (e) {
      setUiError(friendlyError("Couldn’t rename the project", e));
    }
  };

  return (
    <>
      {drawerOpen && <div className="menu-backdrop sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <nav className={`sidebar ${drawerOpen ? "open" : ""}`}>
        <div className="sidebar-head">
          <span className="brand"><i>p</i> {productName.toLowerCase()}</span>
          <span className="side-icons">
            <button className="icon-btn" title={`Search sessions (${MOD}P)`} onClick={() => setOverlay("search")}><Icon.search /></button>
            {prefs.plugins.includes("git") && (
              <button className="icon-btn" title="Git & worktrees" onClick={() => setActiveView("git")}><Icon.tree /></button>
            )}
            <button className="icon-btn" title="Open project" onClick={() => setAddingProject(true)}><Icon.plus /></button>
          </span>
        </div>
        {addingProject && <ProjectForm onSubmit={onAddProject} onCancel={() => setAddingProject(false)} />}
        <div className="side-scroll">
          {projects.length === 0 && <div className="empty">No projects yet.<br />Add one with +</div>}
          {projects.map((p) => (
          renamingProject === p.id ? (
            <div key={p.id} className="project-card project-rename">
              <input
                autoFocus
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onBlur={() => void saveProjectName(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveProjectName(p.id);
                  else if (e.key === "Escape") setRenamingProject(null);
                }}
              />
            </div>
          ) : (
            <button
              key={p.id}
              className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
              aria-current={p.id === activeProjectId ? "true" : undefined}
              onClick={() => {
                // Clicking the already-active project must not drop the session (UX-04).
                if (p.id !== activeProjectId) activateProject(p.id);
              }}
              onDoubleClick={() => { setRenamingProject(p.id); setProjectName(p.name); }}
            >
              <span className="project-glyph" style={p.color ? { background: p.color } : undefined}>
                {p.icon || projectGlyph(p.name || p.path)}
              </span>
              <span className="project-meta">
                <span className="project-name" title={p.path}>{p.icon ? `${p.icon} ` : ""}{p.name || p.path}</span>
                <span className="project-path">{p.path}</span>
              </span>
            </button>
          )
          ))}
          {project && branch && (
            <div className="branch-row"><Icon.tree /><span className="mono">{branch}</span></div>
          )}

          {project && (
            <div className="session-list">
              <div className="side-label session-heading">
                <span>Sessions</span>
                <span className="count" title={project.path}>Workspace</span>
              </div>
              <SessionList projectId={project.id} />
            </div>
          )}
        </div>
        <div className="side-foot">
          <button className="new-session" onClick={onNewSession} disabled={!activeProjectId}>
            <Icon.plus /> New session <span className="kbd">{MOD} N</span>
          </button>
          <button className="settings-btn" onClick={() => setOverlay("settings")}>
            <Icon.gear /> Settings <span className="kbd">{MOD} ,</span>
          </button>
        </div>
      </nav>
    </>
  );
}
