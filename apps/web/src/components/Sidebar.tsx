import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from "react";
import {
  getState, useStore, activateProject, openWorkspacePane, openWorktreeSessionDialog, setOverlay,
  setSidebarOpen, setUiError, startNewSession,
} from "../store.ts";
import {
  getSyncStatus, reconnectSync, refreshSessions, removeProject, renameProject, subscribeSyncStatus,
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
import ProjectAppearanceDialog from "./ProjectAppearanceDialog.tsx";
import { confirmAlert } from "../alerts.ts";

const EXPANDED_PROJECTS_KEY = "polyth.sidebar.expandedProjects";

function loadExpandedProjects(activeProjectId: string | null): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) {
      const ids = raw.filter((id): id is string => typeof id === "string");
      if (ids.length > 0) return new Set(ids);
    }
  } catch {
    // Corrupt or unavailable UI storage falls back to revealing the active project.
  }
  return new Set(activeProjectId ? [activeProjectId] : []);
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
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [globalMenuOpen, setGlobalMenuOpen] = useState(false);
  const [appearanceProjectId, setAppearanceProjectId] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => "disconnected");
  const host = typeof location === "undefined" ? "Local server" : location.host;

  // Persisted view mode: list shows the active project; tree expands projects
  // into worktrees and sessions. Expansion is per-project UI state.
  const viewMode = useSidebarViewMode();
  const [expandedTrees, setExpandedTrees] = useState<ReadonlySet<string>>(
    () => loadExpandedProjects(activeProjectId),
  );
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedTrees]));
    } catch {
      // UI expansion persistence is best effort.
    }
  }, [expandedTrees]);
  useEffect(() => {
    // The active project always reveals its worktree/session branch.
    if (!activeProjectId) return;
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
        session.projectId === candidate.id
        && `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLowerCase().includes(needle));
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
  // Compact navigation is always the complete project → worktree → session
  // tree. Desktop keeps the user's optional list-mode preference.
  const effectiveViewMode = compact ? "tree" : viewMode;
  // Finding 2: wide-mode width + collapse persist across reloads; the compact
  // drawer keeps its own responsive geometry and ignores both.
  const layout = useSidebarLayout();
  const collapsed = !compact && layout.collapsed;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? layout.width;
  const navRef = useRef<HTMLElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const connectionRef = useRef<HTMLDivElement>(null);
  const globalMenuRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (!sortOpen && !filterOpen && !connectionOpen && !globalMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sortOpen && !sortRef.current?.contains(target)) setSortOpen(false);
      if (filterOpen && !filterRef.current?.contains(target)) setFilterOpen(false);
      if (connectionOpen && !connectionRef.current?.contains(target)) setConnectionOpen(false);
      if (globalMenuOpen && !globalMenuRef.current?.contains(target)) setGlobalMenuOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSortOpen(false);
      setFilterOpen(false);
      setConnectionOpen(false);
      setGlobalMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [connectionOpen, filterOpen, globalMenuOpen, sortOpen]);
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
        <div className="sidebar-service-bar">
          <div className="sidebar-search">
            <Icon.search />
            <input
              type="search"
              value={query}
              placeholder="Search sessions…"
              aria-label="Search projects, worktrees, and sessions"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                className="sidebar-search-clear"
                aria-label="Clear session search"
                title="Clear search"
                onClick={() => setQuery("")}
              >×</button>
            )}
          </div>
          <div className="sidebar-popover-anchor" ref={connectionRef}>
            <button
              className={`sidebar-service-btn sidebar-connection-dot ${syncStatus}`}
              aria-label={`Server connection: ${syncStatus}`}
              title={`Server connection: ${syncStatus}`}
              aria-haspopup="dialog"
              aria-expanded={connectionOpen}
              onClick={() => setConnectionOpen((open) => !open)}
            ><span aria-hidden="true" /></button>
            {connectionOpen && (
              <div className="sidebar-service-popover sidebar-connection-popover" role="dialog" aria-label="Server connection details">
                <strong>{syncStatus === "connected" ? "Connected" : syncStatus === "connecting" ? "Connecting" : "Connection problem"}</strong>
                <span>{host}</span>
                <button onClick={() => { reconnectSync(); setConnectionOpen(false); }}>Reconnect</button>
              </div>
            )}
          </div>
          <button
            className="sidebar-service-btn"
            aria-label="Settings"
            title={`Settings (${MOD} ,)`}
            onClick={() => setOverlay("settings")}
          ><Icon.gear /></button>
          <div className="sidebar-popover-anchor" ref={globalMenuRef}>
            <button
              className="sidebar-service-btn"
              aria-label="More sidebar actions"
              title="More sidebar actions"
              aria-haspopup="menu"
              aria-expanded={globalMenuOpen}
              onClick={() => setGlobalMenuOpen((open) => !open)}
            ><Icon.more /></button>
            {globalMenuOpen && (
              <div className="sidebar-service-popover sidebar-global-menu" role="menu">
                <button role="menuitem" disabled={registry.status === "loading"} onClick={() => {
                  setGlobalMenuOpen(false);
                  setOverlay("project-picker");
                }}>Add project</button>
                <button role="menuitemcheckbox" aria-checked={selectMode} onClick={() => {
                  toggleSelectMode();
                  setGlobalMenuOpen(false);
                }}>{selectMode ? "Cancel session selection" : "Select sessions"}</button>
                {!compact && (
                  <button role="menuitem" onClick={() => {
                    setSidebarViewMode(viewMode === "tree" ? "list" : "tree");
                    setGlobalMenuOpen(false);
                  }}>{viewMode === "tree" ? "Use project list" : "Use project tree"}</button>
                )}
              </div>
            )}
          </div>
          {compact && (
            <button
              className="sidebar-service-btn drawer-close"
              title="Close projects and sessions"
              aria-label="Close projects and sessions"
              onClick={() => setSidebarOpen(false)}
            >×</button>
          )}
        </div>
        <div className="sidebar-list-controls">
          <div className="sidebar-sort" ref={sortRef}>
            <button
              className="sidebar-sort-trigger"
              aria-label={`Sort sessions, currently ${sort === "recent" ? "recent activity" : "project name"}`}
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((open) => !open)}
            >
              <span>{sort === "recent" ? "Recent activity" : "Project name"}</span>
              <span aria-hidden="true">▾</span>
            </button>
            {sortOpen && (
              <div className="sidebar-sort-menu" role="menu">
                <button role="menuitemradio" aria-checked={sort === "recent"} onClick={() => { setSort("recent"); setSortOpen(false); }}>
                  Recent activity {sort === "recent" ? "✓" : ""}
                </button>
                <button role="menuitemradio" aria-checked={sort === "name"} onClick={() => { setSort("name"); setSortOpen(false); }}>
                  Project name {sort === "name" ? "✓" : ""}
                </button>
              </div>
            )}
          </div>
          <span className="sidebar-controls-spacer" />
          <div className="sidebar-filter" ref={filterRef}>
            <button
              className={attentionOnly ? "active" : ""}
              aria-label="Filter sessions"
              aria-pressed={attentionOnly}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              <Icon.filter />
              <span>Filter</span>
            </button>
            {filterOpen && (
              <div className="sidebar-filter-menu" role="menu">
                <button
                  role="menuitemcheckbox"
                  aria-checked={attentionOnly}
                  onClick={() => setAttentionOnly((value) => !value)}
                >
                  <span aria-hidden="true">{attentionOnly ? "✓" : ""}</span>
                  Needs attention
                </button>
                {attentionOnly && (
                  <button role="menuitem" onClick={() => { setAttentionOnly(false); setFilterOpen(false); }}>Clear filters</button>
                )}
              </div>
            )}
          </div>
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
          {query.trim() !== "" && (
            <div className="sidebar-search-results" aria-label="Session search results">
              {visibleProjects.map((p) => {
                const projectMatches = `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase());
                return (
                  <SessionList
                    key={p.id}
                    projectId={p.id}
                    query={projectMatches ? "" : query}
                    attentionOnly={attentionOnly}
                    selectMode={selectMode}
                    selectedSessionIds={selectedSessionIds}
                    onToggleSelected={toggleSelectedSession}
                    searchMode
                    searchProjectName={p.name || p.path}
                  />
                );
              })}
            </div>
          )}
          {query.trim() === "" && visibleProjects.map((p) => {
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
                <button
                  className={`project-card ${p.id === activeProjectId ? "active" : ""}`}
                  aria-current={p.id === activeProjectId ? "true" : undefined}
                  aria-expanded={effectiveViewMode === "tree" ? expandedTrees.has(p.id) : undefined}
                  onClick={() => {
                    if (p.id !== activeProjectId) activateProject(p.id);
                    if (effectiveViewMode === "tree") toggleTree(p.id);
                    else closeDrawer();
                  }}
                  onDoubleClick={() => { setRenamingProject(p.id); setProjectName(p.name); }}
                >
                  {effectiveViewMode === "tree" && (
                    <span className="project-tree-toggle-sign" aria-hidden="true">{expandedTrees.has(p.id) ? "−" : "+"}</span>
                  )}
                  <span className="project-glyph" style={p.color ? { color: p.color } : undefined}>
                    {p.icon
                      ? p.icon.startsWith("/assets/project-icons/")
                        ? <span className="project-glyph-mask" aria-hidden="true" style={{ WebkitMaskImage: `url("${p.icon}")`, maskImage: `url("${p.icon}")` }} />
                        : p.icon.startsWith("data:image/")
                          ? <img src={p.icon} alt="" />
                        : <span aria-hidden="true">{p.icon}</span>
                      : <Icon.files />}
                  </span>
                  <span className="project-meta">
                    <span className="project-name" title={p.path}>{p.name || p.path}</span>
                    <span className="project-path">{p.path}</span>
                  </span>
                </button>
                <button
                  className="project-new-session"
                  title={`New chat in ${p.name || p.path}`}
                  aria-label={`New chat in ${p.name || p.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    startNewSession(p.id);
                    closeDrawer();
                  }}
                ><Icon.plus /></button>
                <button
                  className="project-worktree-btn"
                  title={`Open or create a worktree for ${p.name || p.path}`}
                  aria-label={`Open or create a worktree for ${p.name || p.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openWorktreeSessionDialog(p.id);
                  }}
                ><Icon.worktree /></button>
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
                      setAppearanceProjectId(p.id);
                    }}>Project appearance…</button>
                    <button role="menuitem" onClick={() => {
                      setProjectMenu(null);
                      if (p.id !== activeProjectId) activateProject(p.id);
                      openWorkspacePane("git");
                    }}>Source control (Git &amp; worktrees)</button>
                    <div className="project-menu-separator" role="separator" />
                    <button className="project-menu-close" role="menuitem" onClick={() => {
                      setProjectMenu(null);
                      void confirmAlert(
                        `Close “${p.name || p.path}”? This removes it from Polyth but keeps its folder and files on disk.`,
                        { title: "Close project", confirmLabel: "Close project" },
                      ).then((ok) => { if (ok) void removeProject(p.id); });
                    }}>Close project</button>
                    <SlotHost slot="sidebar.project.actions" context={{ projectId: p.id }} />
                  </div>
                )}
              </div>
            );
            if (effectiveViewMode !== "tree") return <div key={p.id} className="project-entry">{card}</div>;
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
          {query.trim() === "" && effectiveViewMode === "list" && project && branch && (
            <div className="branch-row"><Icon.tree /><span className="mono">{branch}</span></div>
          )}

          {query.trim() === "" && effectiveViewMode === "list" && project && (
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
        <SlotHost
          slot="sidebar.footer"
          context={{ projectId: activeProjectId, sessionId: activeSessionId, expanded }}
        />
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
      {appearanceProjectId && (() => {
        const target = projects.find((candidate) => candidate.id === appearanceProjectId);
        return target ? <ProjectAppearanceDialog project={target} onClose={() => setAppearanceProjectId(null)} /> : null;
      })()}
    </>
  );
}
