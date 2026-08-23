import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from "react";
import {
  getState, useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  setSidebarOpen, setUiError, startNewSession,
} from "../store.ts";
import {
  getSyncStatus, refreshSessions, renameProject, subscribeSyncStatus,
} from "../init.ts";
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
import { api } from "../api.ts";
import { announce } from "./a11y/live.tsx";

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
  const sessions = useStore((s) => s.sessions);
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
  const [selectMode, setSelectMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => "disconnected");
  const host = typeof location === "undefined" ? "Local server" : location.host;

  // Persisted view mode: list shows the active project; tree expands projects
  // into worktrees and sessions. Expansion is per-project UI state.
  const viewMode = useSidebarViewMode();
  const [expandedTrees, setExpandedTrees] = useState<ReadonlySet<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );
  useEffect(() => {
    // The active project always reveals its worktree/session branch.
    if (!activeProjectId || viewMode !== "tree") return;
    setExpandedTrees((prev) => (prev.has(activeProjectId) ? prev : new Set(prev).add(activeProjectId)));
  }, [activeProjectId, viewMode]);
  const toggleTree = (id: string) => {
    setExpandedTrees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        void refreshSessions(id); // nested lists need this project's sessions
      }
      return next;
    });
  };
  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matchesAttention = (projectId: string) => sessions.some((session) =>
      session.projectId === projectId
      && session.status !== "archived"
      && (session.status === "working"
        || session.status === "waiting"
        || (session.attention?.questions ?? 0) > 0
        || (session.attention?.permissions ?? 0) > 0));
    const filtered = projects.filter((candidate) => {
      if (attentionOnly && !matchesAttention(candidate.id)) return false;
      if (!needle) return true;
      if (`${candidate.name} ${candidate.path}`.toLowerCase().includes(needle)) return true;
      return sessions.some((session) =>
        session.projectId === candidate.id && session.title.toLowerCase().includes(needle));
    });
    return filtered.sort((a, b) => {
      if (sort === "name") return (a.name || a.path).localeCompare(b.name || b.path);
      const latest = (projectId: string) => sessions.reduce(
        (value, session) => session.projectId === projectId ? Math.max(value, session.updatedAt) : value,
        0,
      );
      return latest(b.id) - latest(a.id) || (a.name || a.path).localeCompare(b.name || b.path);
    });
  }, [attentionOnly, projects, query, sessions, sort]);
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
    startNewSession(activeProjectId);
    closeDrawer();
  };
  const toggleSelectMode = () => {
    setSelectMode((current) => {
      if (current) setSelectedSessionIds(new Set());
      return !current;
    });
  };
  const toggleSelectedSession = (id: string) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const runBulk = async (op: "archive" | "restore") => {
    const ids = [...selectedSessionIds];
    if (ids.length === 0) return;
    const affectedProjects = new Set(
      sessions.filter((session) => selectedSessionIds.has(session.id)).map((session) => session.projectId),
    );
    try {
      const result = await api.bulkSessions(op, ids);
      const failNote = result.failed.length
        ? `; ${result.failed.length} failed (${result.failed.map((failure) => failure.code).join(", ")})`
        : "";
      announce(`${op === "archive" ? "Archived" : "Restored"} ${result.succeeded.length} session(s)${failNote}`);
      if (result.failed.length > 0) {
        setUiError(`Some sessions could not be ${op === "archive" ? "archived" : "restored"}: ${result.failed.map((failure) => `${failure.id.slice(0, 8)}:${failure.code}`).join(", ")}`);
      }
      setSelectedSessionIds(new Set());
      setSelectMode(false);
      await Promise.all([...affectedProjects].map((projectId) => refreshSessions(projectId)));
    } catch (error) {
      setUiError(friendlyError(`Couldn’t ${op} the selected sessions`, error));
    }
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
          <h2 className="sidebar-title">Sessions</h2>
          <button
            className={`icon-btn sidebar-select-toggle${selectMode ? " active" : ""}`}
            title={selectMode ? "Cancel session selection" : "Select sessions"}
            aria-label={selectMode ? "Cancel session selection" : "Select sessions"}
            aria-pressed={selectMode}
            onClick={toggleSelectMode}
          ><Icon.select /></button>
          {compact && (
            <button
              className="icon-btn drawer-close"
              title="Close projects and sessions"
              aria-label="Close projects and sessions"
              onClick={() => setSidebarOpen(false)}
            >×</button>
          )}
        </div>
        <div className="sidebar-actions">
          <button className="sidebar-new-chat" onClick={onNewSession} disabled={!activeProjectId}>
            <Icon.plus /> New chat
          </button>
          <button
            className="sidebar-add-project"
            disabled={registry.status === "loading"}
            onClick={() => setOverlay("project-picker")}
          >
            <Icon.plus /> Add project
          </button>
          <label className="sidebar-sort">
            <Icon.filter />
            <span className="sr-only">Sort projects</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as "recent" | "name")}>
              <option value="recent">Sort: Recent</option>
              <option value="name">Sort: Name</option>
            </select>
            <Icon.chevronDown />
          </label>
        </div>
        <div className="sidebar-search">
          <Icon.search />
          <input
            type="search"
            value={query}
            placeholder="Search"
            aria-label="Search projects and sessions"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className={attentionOnly ? "active" : ""}
            aria-label={attentionOnly ? "Show all sessions" : "Show sessions needing attention"}
            aria-pressed={attentionOnly}
            title={attentionOnly ? "Show all sessions" : "Show sessions needing attention"}
            onClick={() => setAttentionOnly((value) => !value)}
          >
            <Icon.filter />
          </button>
        </div>
        <div className="side-scroll">
          {selectMode && (
            <div className="session-bulk-actions" aria-label="Selected session actions">
              <span>{selectedSessionIds.size === 0 ? "Select sessions" : `${selectedSessionIds.size} selected`}</span>
              <button className="small-btn" disabled={selectedSessionIds.size === 0} onClick={() => void runBulk("archive")}>Archive</button>
              <button className="small-btn" disabled={selectedSessionIds.size === 0} onClick={() => void runBulk("restore")}>Restore</button>
            </div>
          )}
          {registry.status === "loading" && (
            <div className="empty side-projects-status" role="status">Loading projects…</div>
          )}
          {registry.status === "failed" && (
            <div className="empty side-projects-status" role="status">Couldn’t load projects.</div>
          )}
          {registry.status === "ready" && projects.length === 0 && (
            <button className="empty side-open-project" onClick={() => setOverlay("project-picker")}>
              No projects yet.<br />Choose a project path to start →
            </button>
          )}
          {registry.status === "ready" && projects.length > 0 && visibleProjects.length === 0 && (
            <div className="empty side-projects-status" role="status">No matching sessions.</div>
          )}
          {visibleProjects.map((p) => {
            const projectSessionCount = sessions.filter(
              (session) => session.projectId === p.id && session.status !== "archived",
            ).length;
            const projectQuery = query.trim()
              && `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase())
              ? ""
              : query;
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
                {viewMode === "tree" && (
                  <button
                    className={`project-tree-chevron${expandedTrees.has(p.id) ? " open" : ""}`}
                    aria-expanded={expandedTrees.has(p.id)}
                    aria-label={`${expandedTrees.has(p.id) ? "Collapse" : "Expand"} sessions for ${p.name || p.path}`}
                    onClick={() => toggleTree(p.id)}
                  >{expandedTrees.has(p.id) ? "▾" : "▸"}</button>
                )}
                <button
                  className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
                  aria-current={p.id === activeProjectId ? "true" : undefined}
                  onClick={() => {
                    if (p.id !== activeProjectId) activateProject(p.id);
                    if (viewMode === "tree") toggleTree(p.id);
                    else closeDrawer();
                  }}
                  onDoubleClick={() => { setRenamingProject(p.id); setProjectName(p.name); }}
                >
                  <span className="project-glyph" style={p.color ? { color: p.color } : undefined}>
                    <Icon.files />
                  </span>
                  <span className="project-meta">
                    <span className="project-name" title={p.path}>{p.icon ? `${p.icon} ` : ""}{p.name || p.path}</span>
                    <span className="project-path">{p.path}</span>
                  </span>
                  {projectSessionCount > 0 && (
                    <span className="project-count" aria-label={`${projectSessionCount} active sessions`}>
                      <i aria-hidden="true" />{projectSessionCount}
                    </span>
                  )}
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
                ><Icon.more /></button>
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
                      startNewSession(p.id);
                      closeDrawer();
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
                      if (viewMode === "tree" && !expandedTrees.has(p.id)) toggleTree(p.id);
                      setSelectMode(true);
                    }}>Select sessions</button>
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
            if (viewMode !== "tree") return <div key={p.id} className="project-entry">{card}</div>;
            return (
              <div key={p.id} className="project-tree-node">
                {card}
                {expandedTrees.has(p.id) && (
                  <div className="project-tree-sessions">
                    <SessionList
                      projectId={p.id}
                      query={projectQuery}
                      attentionOnly={attentionOnly}
                      selectMode={selectMode}
                      selectedSessionIds={selectedSessionIds}
                      onToggleSelected={toggleSelectedSession}
                    />
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
              <SessionList
                projectId={project.id}
                query={
                  query.trim()
                  && `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase())
                    ? ""
                    : query
                }
                attentionOnly={attentionOnly}
                selectMode={selectMode}
                selectedSessionIds={selectedSessionIds}
                onToggleSelected={toggleSelectedSession}
              />
            </div>
          )}
          <SlotHost
            slot="app.nav"
            context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
          />
        </div>
        <div className="side-foot">
          <button
            className="sidebar-layout-btn"
            title={viewMode === "tree" ? "Switch to project list" : "Show project and session hierarchy"}
            aria-label="Toggle project tree view"
            aria-pressed={viewMode === "tree"}
            onClick={() => setSidebarViewMode(viewMode === "tree" ? "list" : "tree")}
          >
            {viewMode === "tree" ? <Icon.hierarchy /> : <Icon.list />}
          </button>
          <div className="sidebar-connection" aria-label={`${host}, ${syncStatus}`}>
            <strong>{host}</strong>
            <span className={syncStatus}><i aria-hidden="true" />{
              syncStatus === "connected" ? "Connected" : syncStatus === "connecting" ? "Connecting" : "Reconnecting"
            }</span>
          </div>
          <button
            className="sidebar-switch-btn"
            title="Refresh sessions"
            aria-label="Refresh sessions"
            disabled={!activeProjectId}
            onClick={() => { if (activeProjectId) void refreshSessions(activeProjectId); }}
          >
            <Icon.shuffle />
          </button>
          <button className="settings-btn" aria-label="Settings" title={`Settings (${MOD} ,)`} onClick={() => setOverlay("settings")}>
            <Icon.gear />
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
