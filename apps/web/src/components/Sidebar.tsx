import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  getState, useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  setSidebarOpen, setUiError,
} from "../store.ts";
import { createSession, refreshSessions, renameProject } from "../init.ts";
import { MOD } from "../format.ts";
import { friendlyError } from "../settings.ts";
import { Icon } from "../icons.tsx";
import SessionList from "./sidebar/SessionList.tsx";
import ImportSessionsDialog from "./ImportSessionsDialog.tsx";
import { useShellMode } from "../responsiveShell.ts";
import { useModalSurface } from "./a11y/Dialog.tsx";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import SlotHost from "./slots/SlotHost.ts";
import { useSidebarExpanded } from "../sidebarPresentation.ts";
import { setSidebarViewMode, useSidebarViewMode } from "../sidebarPrefs.ts";
import {
  SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH,
  clampSidebarWidth, setSidebarLayout, useSidebarLayout,
} from "../sidebarLayout.ts";

function projectGlyph(name: string): string {
  const words = name.trim().split(/[\s\-_/]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || "P";
}

/** Close the drawer only when it is actually open (avoids no-op re-renders
 *  in wide mode, where the sidebar is a plain inline column). */
function closeDrawer(): void {
  if (getState().sidebarOpen) setSidebarOpen(false);
}

export default function Sidebar() {
  // Canonical registry truth: `projects` has one owner; loading and failure
  // never claim there are no projects (UX-ONBOARDING).
  const registry = useStore((s) => s.projectRegistry);
  const projects = registry.projects;
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const drawerOpen = useStore((s) => s.sidebarOpen);
  // Honest presentation state for app.nav contributions: on desktop the
  // sidebar is always expanded regardless of the mobile drawer flag.
  const expanded = useSidebarExpanded(drawerOpen);
  const branch = useStore((s) => s.gitBranch);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [importingProject, setImportingProject] = useState<string | null>(null);

  // UX-FILES-TIMELINE-03 finding 9: persisted view mode — "list" is the
  // current presentation, "folders" nests each project's sessions under a
  // collapsible project folder. Expansion is per-project UI state.
  const viewMode = useSidebarViewMode();
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );
  useEffect(() => {
    // The active project's folder always reveals its sessions.
    if (!activeProjectId || viewMode !== "folders") return;
    setExpandedFolders((prev) => (prev.has(activeProjectId) ? prev : new Set(prev).add(activeProjectId)));
  }, [activeProjectId, viewMode]);
  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        void refreshSessions(id); // nested lists need this project's sessions
      }
      return next;
    });
  };
  const expandAllFolders = () => {
    setExpandedFolders(new Set(projects.map((p) => p.id)));
    for (const p of projects) void refreshSessions(p.id);
  };
  const collapseAllFolders = () => setExpandedFolders(new Set());

  // UX-A390: below 821px the sidebar is a modal drawer. It never opens by
  // itself when the viewport shrinks — wide visibility is not a persisted
  // drawer-open preference.
  const mode = useShellMode();
  const compact = mode !== "wide";
  // Finding 2: wide-mode width + collapse persist across reloads; the compact
  // drawer keeps its own responsive geometry and ignores both.
  const layout = useSidebarLayout();
  const collapsed = !compact && layout.collapsed;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? layout.width;
  const navRef = useRef<HTMLElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const onProjectMenuKey = useDismissibleMenu({
    open: projectMenu !== null,
    menuRef: projectMenuRef,
    triggerRef: projectMenuTriggerRef,
    onClose: () => setProjectMenu(null),
  });
  const prevCompact = useRef(compact);
  useEffect(() => {
    if (!prevCompact.current && compact) closeDrawer();
    prevCompact.current = compact;
  }, [compact]);
  useModalSurface({
    enabled: compact,
    open: compact && drawerOpen,
    onClose: () => setSidebarOpen(false),
    containerRef: navRef,
  });

  const onNewSession = () => {
    if (!activeProjectId) return;
    // Close the drawer only after the session actually exists; a failure
    // leaves it open with the existing error path.
    void createSession(activeProjectId)
      .then(closeDrawer)
      .catch((e) => setUiError(friendlyError("Couldn’t create a session", e)));
  };
  const saveProjectName = async (id: string) => {
    const name = projectName.trim();
    setRenamingProject(null);
    const current = projects.find((p) => p.id === id);
    if (!name || !current || name === current.name) return;
    try {
      // Registry action: the server-returned project is upserted in place —
      // no component-owned `setProjects(await listProjects())` write.
      await renameProject(id, name);
    } catch (e) {
      setUiError(friendlyError("Couldn’t rename the project", e));
    }
  };

  // Mouse-drag resize: transient width during the drag, one persisted write
  // on release (drag state stays local; the pref module owns durability).
  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let next = startWidth;
    const onMove = (ev: MouseEvent) => {
      next = clampSidebarWidth(startWidth + (ev.clientX - startX));
      setDragWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSidebarLayout({ width: next });
      setDragWidth(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onResizeKey = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarLayout({ width: width + (event.key === "ArrowRight" ? 16 : -16) });
  };

  return (
    <>
      {compact && drawerOpen && (
        <div
          className="menu-backdrop sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <nav
        ref={navRef}
        id="polyth-session-drawer"
        className={`sidebar ${drawerOpen ? "open" : ""}${collapsed ? " collapsed" : ""}`}
        style={!compact ? { width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width, minWidth: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width } : undefined}
        {...(compact ? { role: "dialog", "aria-modal": true, "aria-label": "Projects and sessions" } : {})}
      >
        <h2 className="sr-only">Projects and sessions</h2>
        {collapsed && (
          <div className="sidebar-collapsed-rail">
            <button
              className="icon-btn sidebar-expand"
              title="Expand projects and sessions"
              aria-label="Expand projects and sessions"
              aria-expanded="false"
              onClick={() => setSidebarLayout({ collapsed: false })}
            >»</button>
          </div>
        )}
        {!collapsed && (<>
        <div className="sidebar-head">
          <span className="side-section-title">Workspaces</span>
          <span className="side-icons">
            <button
              className="icon-btn"
              title={viewMode === "folders" ? "Switch to single-project session list" : "Group sessions under project folders"}
              aria-label="Toggle project folder view"
              aria-pressed={viewMode === "folders"}
              onClick={() => setSidebarViewMode(viewMode === "folders" ? "list" : "folders")}
            ><Icon.files /></button>
            <button
              className="icon-btn"
              title="Open project"
              disabled={registry.status === "loading"}
              onClick={() => setOverlay("project-picker")}
            ><Icon.plus /></button>
            {!compact && (
              <button
                className="icon-btn sidebar-collapse"
                title="Collapse projects and sessions"
                aria-label="Collapse projects and sessions"
                aria-expanded="true"
                onClick={() => setSidebarLayout({ collapsed: true })}
              >«</button>
            )}
            {compact && (
              <button
                className="icon-btn drawer-close"
                title="Close projects and sessions"
                aria-label="Close projects and sessions"
                onClick={() => setSidebarOpen(false)}
              >×</button>
            )}
          </span>
        </div>
        <div className="side-scroll">
          {registry.status === "loading" && (
            <div className="empty side-projects-status" role="status">Loading projects…</div>
          )}
          {registry.status === "failed" && (
            <div className="empty side-projects-status" role="status">Couldn’t load projects.</div>
          )}
          {registry.status === "ready" && projects.length === 0 && (
            <button className="empty side-open-project" onClick={() => setOverlay("project-picker")}>
              No projects yet.<br />Choose a folder to start →
            </button>
          )}
          {viewMode === "folders" && projects.length > 1 && (
            <div className="side-folder-bar">
              <button className="small-btn" onClick={expandAllFolders}>Expand all</button>
              <button className="small-btn" onClick={collapseAllFolders}>Collapse all</button>
            </div>
          )}
          {projects.map((p) => {
            const card = renamingProject === p.id ? (
              <div className="project-card project-rename">
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
              <div className="project-card-shell">
                {viewMode === "folders" && (
                  <button
                    className={`project-folder-chevron${expandedFolders.has(p.id) ? " open" : ""}`}
                    aria-expanded={expandedFolders.has(p.id)}
                    aria-label={`${expandedFolders.has(p.id) ? "Collapse" : "Expand"} sessions for ${p.name || p.path}`}
                    onClick={() => toggleFolder(p.id)}
                  >{expandedFolders.has(p.id) ? "▾" : "▸"}</button>
                )}
                <button
                  className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
                  aria-current={p.id === activeProjectId ? "true" : undefined}
                  onClick={() => {
                    // Clicking the already-active project must not drop the session (UX-04).
                    if (p.id !== activeProjectId) activateProject(p.id);
                    if (viewMode === "folders") toggleFolder(p.id);
                    else closeDrawer();
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
                  onClick={(event) => {
                    projectMenuTriggerRef.current = event.currentTarget;
                    setProjectMenu((current) => current === p.id ? null : p.id);
                  }}
                >⋯</button>
                {projectMenu === p.id && (
                  <div
                    className="project-actions-menu"
                    role="menu"
                    aria-label={`Actions for ${p.name || p.path}`}
                    ref={projectMenuRef}
                    onKeyDown={onProjectMenuKey}
                  >
                    <button role="menuitem" onClick={() => {
                      setProjectMenu(null);
                      if (p.id !== activeProjectId) activateProject(p.id);
                      void createSession(p.id)
                        .then(closeDrawer)
                        .catch((error) => setUiError(friendlyError("Couldn’t create a session", error)));
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
                    <button role="menuitem" onClick={() => {
                      setProjectMenu(null);
                      if (p.id !== activeProjectId) activateProject(p.id);
                      openWorkspacePane("git");
                    }}>Source control (Git &amp; worktrees)</button>
                    <SlotHost slot="sidebar.project.actions" context={{ projectId: p.id }} />
                  </div>
                )}
              </div>
            );
            if (viewMode !== "folders") return <div key={p.id} className="project-entry">{card}</div>;
            // Finding 9: each project is a folder with its sessions nested —
            // the SAME SessionList the list mode renders for the active project.
            return (
              <div key={p.id} className="project-folder">
                {card}
                {expandedFolders.has(p.id) && (
                  <div className="project-folder-sessions">
                    <SessionList projectId={p.id} />
                  </div>
                )}
              </div>
            );
          })}
          {viewMode === "list" && project && branch && (
            <div className="branch-row"><Icon.tree /><span className="mono">{branch}</span></div>
          )}

          {viewMode === "list" && project && (
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
        </>)}
        {!compact && !collapsed && (
          <div
            className="sidebar-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={width}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            tabIndex={0}
            onMouseDown={startResize}
            onKeyDown={onResizeKey}
          />
        )}
      </nav>
      {importingProject && (
        <ImportSessionsDialog projectId={importingProject} onClose={() => setImportingProject(null)} />
      )}
    </>
  );
}
