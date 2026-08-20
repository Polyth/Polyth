import { useState } from "react";
import {
  useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  setProjects, setSidebarOpen, setUiError,
} from "../store.ts";
import { createSession } from "../init.ts";
import { api } from "../api.ts";
import { usePrefs } from "../prefs.ts";
import { MOD } from "../format.ts";
import { friendlyError } from "../settings.ts";
import { Icon } from "../icons.tsx";
import SessionList from "./sidebar/SessionList.tsx";
import ImportSessionsDialog from "./ImportSessionsDialog.tsx";
import SlotHost from "./slots/SlotHost.ts";
import { useSidebarExpanded } from "../sidebarPresentation.ts";

function projectGlyph(name: string): string {
  const words = name.trim().split(/[\s\-_/]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || "P";
}

export default function Sidebar() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const drawerOpen = useStore((s) => s.sidebarOpen);
  // Honest presentation state for app.nav contributions: on desktop the
  // sidebar is always expanded regardless of the mobile drawer flag.
  const expanded = useSidebarExpanded(drawerOpen);
  const branch = useStore((s) => s.gitBranch);
  const productName = useStore((s) => s.settings.productName);
  const prefs = usePrefs();
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [importingProject, setImportingProject] = useState<string | null>(null);

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
              <button className="icon-btn" title="Git & worktrees" onClick={() => openWorkspacePane("git")}><Icon.tree /></button>
            )}
            <button className="icon-btn" title="Open project" onClick={() => setOverlay("project-picker")}><Icon.plus /></button>
          </span>
        </div>
        <div className="side-scroll">
          {projects.length === 0 && (
            <button className="empty side-open-project" onClick={() => setOverlay("project-picker")}>
              No projects yet.<br />Choose a folder to start →
            </button>
          )}
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
            <div className="project-card-shell" key={p.id}>
              <button
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
              <button
                className="project-menu-btn"
                aria-label={`Actions for ${p.name || p.path}`}
                aria-haspopup="menu"
                aria-expanded={projectMenu === p.id}
                onClick={() => setProjectMenu((current) => current === p.id ? null : p.id)}
              >⋯</button>
              {projectMenu === p.id && (
                <div className="project-actions-menu" role="menu">
                  <button role="menuitem" onClick={() => {
                    setProjectMenu(null);
                    if (p.id !== activeProjectId) activateProject(p.id);
                    void createSession(p.id).catch((error) => setUiError(friendlyError("Couldn’t create a session", error)));
                  }}>New session</button>
                  <button role="menuitem" onClick={() => {
                    setProjectMenu(null);
                    openWorktreeSessionDialog(p.id);
                  }}>New session in worktree…</button>
                  <button role="menuitem" onClick={() => {
                    setProjectMenu(null);
                    setImportingProject(p.id);
                  }}>Import sessions…</button>
                  <button role="menuitem" onClick={() => {
                    setProjectMenu(null);
                    setRenamingProject(p.id);
                    setProjectName(p.name);
                  }}>Rename project</button>
                  {prefs.plugins.includes("git") && (
                    <button role="menuitem" onClick={() => {
                      setProjectMenu(null);
                      if (p.id !== activeProjectId) activateProject(p.id);
                      openWorkspacePane("git");
                    }}>Git &amp; worktrees</button>
                  )}
                  <SlotHost slot="sidebar.project.actions" context={{ projectId: p.id }} />
                </div>
              )}
            </div>
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
          <SlotHost
            slot="app.nav"
            context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
          />
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
      {importingProject && (
        <ImportSessionsDialog projectId={importingProject} onClose={() => setImportingProject(null)} />
      )}
    </>
  );
}
